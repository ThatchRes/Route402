// Deterministic route optimizer (guide A2 + A6 + A8). Pure functions: no I/O, no LLM, no guessed rates.
// Every candidate is priced through the SAME quoteFor() the payout service executes, so numbers match exactly.
import { quoteFor, type QuoteInput } from "../scenarios.js";
import { convert, decimals, fmt, toMinor } from "../money.js";
import { BANKS, NETWORKS, OFFRAMPS, ONRAMPS, PLATFORM, STABILITY, SWAPS, TOKENS, MID_PER_USD, venueQuote, type Tier } from "./registry.js";
import { div, lessBps, mul } from "./rates.js";
import { bankMarkup, MARKET, midInfo } from "./market.js";   // live mids overwrite the demo table before any price is computed

export interface Intent {
  srcCcy: string; destCcy: string; amountType: "SOURCE_FIXED" | "RECIPIENT_FIXED"; amount: string;
  deadlineUtc?: string; objective?: "balanced" | "cheapest" | "fastest";   // default balanced = cost + speed
  allowSplit?: boolean; nowUtc?: string; midOverrides?: Record<string, string>;     // e.g. {"USD/XOF": "605.2"}
  liveOnly?: boolean;   // only routes whose funding can really execute today (x402 USDC on Base) or bank routes
  provider?: "stablecoin" | "bank";   // one provider's routes only (each provider quotes separately)
  beneficiaryAcceptsUsdc?: boolean;   // supplier has a USDC wallet on file (USD-invoiced suppliers)
  reference?: string;                 // invoice reference carried with the payment (kept on the receipt)
  beneficiary?: any;                  // supplier details (payee history is updated when the payment completes)
  currentBank?: { label: string; fxMarkupBps: number; wireFeeUsd: number; businessDays: number; measured?: boolean };   // the company's own bank = baseline
  // measured: true -> the FX markup comes from measured bank pricing for this corridor (market.ts); fxMarkupBps is only the fallback
}

export function mid(a: string, b: string, o: Record<string, string> = {}): string {
  if (a === b) return "1";
  if (o[`${a}/${b}`]) return o[`${a}/${b}`];
  if (o[`${b}/${a}`]) return div("1", o[`${b}/${a}`]);
  if (!MID_PER_USD[a] || !MID_PER_USD[b]) throw new Error(`no rate for ${a}/${b}: supply midOverrides["${a}/${b}"] (rates are never invented)`);
  return div(MID_PER_USD[b], MID_PER_USD[a]);
}
const usdOf = (amount: string, ccy: string, o: Record<string, string>) => Number(amount) / Number(mid("USD", ccy, o));
function usdToCcy(usd: number, ccy: string, o: Record<string, string>): string {   // fee assumption -> exact string, rounded UP
  const d = decimals(ccy), m = Math.ceil(usd * Number(mid("USD", ccy, o)) * 10 ** d - 1e-9);
  return (m / 10 ** d).toFixed(d);
}
const tierBps = (tiers: Tier[], usd: number) => tiers.find((t) => usd <= t.upToUsd)!.bps;

// ---------------------------------------------------------------- timing (UTC business days, labeled assumption)
const isBiz = (d: Date) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
function nextBiz(d: Date, hour = 14) { const x = new Date(d); do { x.setUTCDate(x.getUTCDate() + 1); } while (!isBiz(x)); x.setUTCHours(hour, 0, 0, 0); return x; }
function addBizDays(d: Date, n: number, hour = 17) { let x = new Date(d); for (let i = 0; i < n; i++) x = nextBiz(x, hour); return x; }

interface Route {
  routeId: string; kind: "bank" | "stablecoin"; label: string; token?: string; network?: string;
  x402Executable: boolean; capacityUsd: number; steps: string[];
  build: (amountType: Intent["amountType"], amount: string, sizeUsd: number) => QuoteInput & { network?: string };
  arrival: (now: Date) => Date; pegDeviation: number; coins: string[];
}

export function enumerateRoutes(it: Intent): { routes: Route[]; missing: string[]; unpriced: string[] } {
  const o = it.midOverrides ?? {}, routes: Route[] = [], missing: string[] = [], unpriced: string[] = [];
  try { mid(it.srcCcy, it.destCcy, o); } catch (e: any) { missing.push(e.message); return { routes, missing, unpriced }; }
  const sameCcy = it.srcCcy === it.destCcy;   // no FX: the bank charges its wire fee only
  const cbBps = !it.currentBank || sameCcy ? 0 : it.currentBank.measured ? bankMarkup(it.srcCcy, it.destCcy, it.currentBank.fxMarkupBps).bps : it.currentBank.fxMarkupBps;
  const banks = it.currentBank
    ? [{ id: "current_bank", label: `${it.currentBank.label} (your current bank)`, fixedUsd: it.currentBank.wireFeeUsd, tiers: [{ upToUsd: Infinity, bps: cbBps }],
         businessDays: it.currentBank.businessDays, cutoffUtcHour: 21, capacityUsd: Infinity, dest: "*" as const, isBaseline: true },
       ...BANKS.filter((b) => !b.isBaseline)]
    : BANKS;
  for (const b of banks) {
    if (b.dest !== "*" && !b.dest.includes(it.destCcy)) continue;
    routes.push({ routeId: `bank:${b.id}`, kind: "bank", label: b.label, x402Executable: false, capacityUsd: b.capacityUsd,
      steps: [`${it.srcCcy} debit`, `${b.label} FX ${it.srcCcy}->${it.destCcy}`, `${it.destCcy} credit`], pegDeviation: 0, coins: [],
      build: (amountType, amount, usd) => ({ route: "bank", srcCcy: it.srcCcy, destCcy: it.destCcy, amountType, amount,
        fxRate: lessBps(mid(it.srcCcy, it.destCcy, o), sameCcy ? 0 : tierBps(b.tiers, usd)), fundingFee: usdToCcy(b.fixedUsd, it.srcCcy, o), payoutFee: "0" }),
      arrival: (now) => {
        if (b.sameDayBeforeUtcHour !== undefined && isBiz(now) && now.getUTCHours() < b.sameDayBeforeUtcHour) return new Date(now.getTime() + 4 * 3600e3);
        const start = isBiz(now) && now.getUTCHours() < b.cutoffUtcHour ? now : nextBiz(now, 9);
        return addBizDays(start, b.businessDays);
      } });
  }
  for (const on of ONRAMPS.filter((x) => x.src === it.srcCcy)) {
    const tok = TOKENS.find((t) => t.id === on.token)!;
    for (const net of NETWORKS.filter((n) => n.token === tok.id)) {
      for (const off of OFFRAMPS.filter((f) => f.tokens.includes(tok.id) && f.networks.includes(net.id) && (f.dest === "*" || f.dest.includes(it.destCcy)))) {
        if (off.requiresUsdcWallet && !it.beneficiaryAcceptsUsdc) { unpriced.push(`stablecoin: supplier has no USDC wallet on file`); continue; }
        let pegToDest: string; try { pegToDest = mid(tok.peg, it.destCcy, o); } catch { continue; }
        routes.push({ routeId: `coin:${tok.id}:${net.id}:${off.id}`, kind: "stablecoin", label: `${tok.id} on ${net.id} via ${off.label}`,
          token: tok.id, network: net.id, x402Executable: !!net.x402Executable && tok.id === "USDC",
          capacityUsd: Math.min(on.capacityUsd, off.capacityUsd), pegDeviation: tok.pegDeviation, coins: [tok.id],
          steps: [`${it.srcCcy} debit`, `onramp ${it.srcCcy}->${tok.id}`, `${tok.id} on ${net.id}${net.x402Executable && tok.id === "USDC" ? " (x402 funding)" : ""}`,
                  `${off.label} ${tok.id}->${it.destCcy}`, `${it.destCcy} credit`],
          build: (amountType, amount, usd) => ({ route: "stablecoin", srcCcy: it.srcCcy, destCcy: it.destCcy, amountType, amount,
            fundingAsset: tok.id, network: net.id, onrampRate: lessBps(mid(it.srcCcy, tok.peg, o), on.bps),
            fxRate: lessBps(pegToDest, tierBps(off.tiers, usd)),
            fundingFee: usdToCcy(on.fixedUsd + net.gasUsd, it.srcCcy, o), payoutFee: off.fixedDest !== undefined ? off.fixedDest.toFixed(decimals(it.destCcy)) : usdToCcy(off.fixedUsd, it.destCcy, o) }),
          arrival: (now) => {
            const t = new Date(now.getTime() + (net.finalityMin + off.payoutMin) * 60e3);
            if (off.always) return t;                                        // 24/7 leg: no cut-off, no business days
            return isBiz(t) && t.getUTCHours() < off.cutoffUtcHour ? t : new Date(nextBiz(t).getTime() + off.payoutMin * 60e3);
          } });
      }
    }
  }
  // two-coin routes: onramp to T1, on-chain swap T1 -> T2 on the same network, redeem T2 locally
  for (const on of ONRAMPS.filter((x) => x.src === it.srcCcy)) {
    const t1 = TOKENS.find((t) => t.id === on.token)!;
    for (const sw of SWAPS.filter((x) => x.from === t1.id)) {
      const t2 = TOKENS.find((t) => t.id === sw.to)!;
      for (const netId of sw.networks.filter((n) => t1.networks.includes(n) && t2.networks.includes(n))) {
        const net = NETWORKS.find((n) => n.token === t1.id && n.id === netId)!;
        for (const off of OFFRAMPS.filter((f) => f.tokens.includes(t2.id) && f.networks.includes(netId) && (f.dest === "*" || f.dest.includes(it.destCcy)))) {
          const vq = venueQuote(it.destCcy);
          if (!vq) { unpriced.push(`stablecoin to ${it.destCcy}: ${t1.id}->${t2.id} conversion price is not published; enter a live venue quote (VENUE_QUOTES)`); continue; }
          let swapRate: string, pegToDest: string;
          try { swapRate = lessBps(mid(t1.peg, t2.peg, o), vq.bps); pegToDest = mid(t2.peg, it.destCcy, o); } catch { continue; }
          const live = t1.id === "USDC" && netId === "base";
          routes.push({ routeId: `coin:${t1.id}>${t2.id}:${netId}:${off.id}`, kind: "stablecoin", label: `${t1.id}->${t2.id} swap on ${netId}, ${off.label}`,
            token: t1.id, network: netId, x402Executable: live, capacityUsd: Math.min(on.capacityUsd, sw.capacityUsd, off.capacityUsd),
            pegDeviation: Math.max(t1.pegDeviation, t2.pegDeviation), coins: [t1.id, t2.id],
            steps: [`${it.srcCcy} debit`, `onramp ${it.srcCcy}->${t1.id}`, `${t1.id} on ${netId}${live ? " (x402 funding)" : ""}`,
                    `${t1.id}->${t2.id} at venue quote ${vq.bps} bps (${vq.source})`, `${off.label} ${t2.id}->${it.destCcy}`, `${it.destCcy} credit`],
            build: (amountType, amount, usd) => ({ route: "stablecoin", srcCcy: it.srcCcy, destCcy: it.destCcy, amountType, amount,
              fundingAsset: t1.id, network: netId, onrampRate: lessBps(mid(it.srcCcy, t1.peg, o), on.bps),
              fxRate: mul(swapRate, lessBps(pegToDest, tierBps(off.tiers, usd))),     // swap + redemption, exact composite rate
              fundingFee: usdToCcy(on.fixedUsd + net.gasUsd, it.srcCcy, o),
              payoutFee: off.fixedDest !== undefined ? off.fixedDest.toFixed(decimals(it.destCcy)) : usdToCcy(off.fixedUsd + net.gasUsd, it.destCcy, o) }),
            arrival: (now) => {
              const t = new Date(now.getTime() + (net.finalityMin + sw.minutes + off.payoutMin) * 60e3);
              if (off.always) return t;
              return isBiz(t) && t.getUTCHours() < off.cutoffUtcHour ? t : new Date(nextBiz(t).getTime() + off.payoutMin * 60e3);
            } });
        }
      }
    }
  }
  return { routes, missing, unpriced: [...new Set(unpriced)] };
}

export interface Priced {
  routeId: string; label: string; kind: string; token?: string; network?: string; x402Executable: boolean; steps: string[];
  amount: string; quote: any; arrivalUtc: string; costMinor: bigint; timeCostMinor: bigint; scoreMinor: bigint; eligible: boolean; reason?: string;
}

function price(r: Route, it: Intent, amount: string, now: Date, deadline?: Date): Priced {
  const o = it.midOverrides ?? {};
  const sizeUsd = it.amountType === "SOURCE_FIXED" ? usdOf(amount, it.srcCcy, o) : usdOf(amount, it.destCcy, o);
  const base: any = { routeId: r.routeId, label: r.label, kind: r.kind, token: r.token, network: r.network,
    x402Executable: r.x402Executable, steps: r.steps, amount, costMinor: 0n, timeCostMinor: 0n, scoreMinor: 0n };
  let quote: any;
  try { quote = quoteFor(r.build(it.amountType, amount, sizeUsd), r.routeId); } catch (e: any) { return { ...base, quote: null, arrivalUtc: "", eligible: false, reason: e.message }; }
  const arrival = r.arrival(now);
  const S = BigInt(quote.sourceDebit.minor), net = BigInt(quote.recipientNet.minor);
  const days = Math.max(0, (arrival.getTime() - now.getTime()) / 86400e3);
  const time = (S * BigInt(Math.round(PLATFORM.timeValueBpsPerDay * days * 100))) / 1_000_000n;
  const netInSrc = convert(net, it.destCcy, it.srcCcy, mid(it.destCcy, it.srcCcy, o)).minor;
  const binding = it.amountType === "RECIPIENT_FIXED" ? S : -netInSrc;
  // balanced (default): money cost + time value of a slower arrival. cheapest: money only. fastest: sorted by arrival.
  const score = binding + ((it.objective ?? "balanced") === "cheapest" ? 0n : time);
  const out: Priced = { ...base, quote, arrivalUtc: arrival.toISOString(), costMinor: binding, timeCostMinor: time, scoreMinor: score, eligible: true };
  const fail = (reason: string) => ({ ...out, eligible: false, reason });
  if (sizeUsd > r.capacityUsd) return fail(`exceeds provider capacity (${r.capacityUsd.toLocaleString()} USD-eq); a split may help`);
  if (deadline && arrival > deadline) return fail(`arrives ${arrival.toISOString()} after deadline`);
  if (r.pegDeviation > STABILITY.maxPegDeviation) return fail(`${r.coins.join("/")} is ${r.pegDeviation} off peg (limit ${STABILITY.maxPegDeviation}): not stable enough`);
  return out;
}

const better = (a: bigint, b: bigint) => a < b;
const pick = (xs: Priced[], cmp: (a: Priced, b: Priced) => number) => {
  const p = [...xs].sort(cmp)[0];
  return p ? { routeId: p.routeId, label: p.label, sourceDebit: p.quote.sourceDebit.display, recipientNet: p.quote.recipientNet.display, arrivalUtc: p.arrivalUtc } : null;
};

export function optimize(it: Intent) {
  const now = it.nowUtc ? new Date(it.nowUtc) : new Date();
  const deadline = it.deadlineUtc ? new Date(it.deadlineUtc) : undefined;
  const { routes, missing, unpriced } = enumerateRoutes(it);
  if (missing.length) return { status: "MISSING_INPUT", missing };
  const ofProvider = (id: string) => id.startsWith("coin:") ? "stablecoin" : "bank";
  const usable = routes.filter((r) => (!it.liveOnly || r.kind === "bank" || r.x402Executable) && (!it.provider || ofProvider(r.routeId) === it.provider));
  const priced = usable.map((r) => price(r, it, it.amount, now, deadline));
  const eligible = priced.filter((p) => p.eligible).sort((a, b) => (it.objective === "fastest"
    ? a.arrivalUtc.localeCompare(b.arrivalUtc) || Number(a.scoreMinor - b.scoreMinor) : Number(a.scoreMinor - b.scoreMinor)));
  const bestUnsplit = eligible[0];

  // ---- split search (A8): size-specific quotes per child, fixed fees counted per child, exposure caps
  let bestSplit: { children: Priced[]; scoreMinor: bigint } | undefined;
  if (it.allowSplit !== false) {
    const pool = priced.filter((p) => p.quote && (p.eligible || p.reason?.startsWith("exceeds provider capacity")))
      .sort((a, b) => Number(a.scoreMinor - b.scoreMinor)).slice(0, 6);
    const ccy = it.amountType === "SOURCE_FIXED" ? it.srcCcy : it.destCcy, total = toMinor(it.amount, ccy);
    const dec = decimals(ccy), str = (m: bigint) => { const s = m.toString().padStart(dec + 1, "0"); return dec ? `${s.slice(0, -dec)}.${s.slice(-dec)}` : s; };
    const shares2 = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((x) => [x, 10 - x]);
    const shares3 = [[2, 2, 6], [2, 4, 4], [2, 6, 2], [4, 2, 4], [4, 4, 2], [6, 2, 2], [2, 3, 5], [3, 3, 4], [5, 3, 2], [4, 3, 3]];
    const tryCombo = (rs: Route[], shares: number[]) => {
      const amts = shares.map((s) => (total * BigInt(s)) / 10n); amts[amts.length - 1] = total - amts.slice(0, -1).reduce((x, y) => x + y, 0n);
      const kids: Priced[] = [];
      for (let i = 0; i < rs.length; i++) {
        const p = price(rs[i], it, str(amts[i]), now, deadline);
        if (!p.eligible) return;
        kids.push(p);
      }
      const score = kids.reduce((s, k) => s + k.scoreMinor, 0n);
      if (!bestSplit || better(score, bestSplit.scoreMinor)) bestSplit = { children: kids, scoreMinor: score };
    };
    const R = pool.map((p) => usable.find((r) => r.routeId === p.routeId)!);
    for (let i = 0; i < R.length; i++) for (let j = 0; j < R.length; j++) if (i !== j) for (const s of shares2) tryCombo([R[i], R[j]], s);
    for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) for (let k = j + 1; k < R.length; k++) for (const s of shares3) tryCombo([R[i], R[j], R[k]], s);
  }

  const useSplit = bestSplit && (!bestUnsplit || better(bestSplit.scoreMinor, bestUnsplit.scoreMinor));
  const chosen: Priced[] | undefined = useSplit ? bestSplit!.children : bestUnsplit ? [bestUnsplit] : undefined;
  const baselineId = it.currentBank ? "bank:current_bank" : "bank:legacy_wire";
  const baseline = priced.find((p) => p.routeId === baselineId)
    ?? routes.filter((r) => r.routeId === baselineId).map((r) => price(r, it, it.amount, now, undefined))[0];   // baseline even if filtered by liveOnly
  if (!chosen) return { status: "HOLD", reason: it.provider === "stablecoin" ? (unpriced.length ? unpriced.join("; ") : `our stablecoin rail has no published-price route to ${it.destCcy} yet`) : "no eligible route or allocation", unpriced, candidates: priced, baseline };

  const sum = (k: "sourceDebit" | "recipientNet") => chosen.reduce((s, c) => s + BigInt(c.quote[k].minor), 0n);
  const debit = sum("sourceDebit"), net = sum("recipientNet");
  // ---- value: savings vs the customer's current policy, and our fee as a share of it
  let savingsMinor = 0n;
  if (baseline?.quote) {
    savingsMinor = it.amountType === "RECIPIENT_FIXED" ? BigInt(baseline.quote.sourceDebit.minor) - debit
      : convert(net - BigInt(baseline.quote.recipientNet.minor), it.destCcy, it.srcCcy, mid(it.destCcy, it.srcCcy, it.midOverrides ?? {})).minor;
  }
  // our fee: 0.15% of the source debit sent on our stablecoin rail, never more than half the measured saving; bank routes are free
  const railDebit = chosen.filter((c) => c.kind === "stablecoin").reduce((s, c) => s + BigInt(c.quote.sourceDebit.minor), 0n);
  const pctFee = (railDebit * BigInt(PLATFORM.feeBpsOfRailVolume)) / 10000n;
  const cap = savingsMinor > 0n ? savingsMinor / 2n : 0n, feeMinor = pctFee < cap ? pctFee : cap;   // the customer keeps at least half
  const latest = chosen.map((c) => c.arrivalUtc).sort().at(-1)!;
  // cost above mid in bps (what the payer gives up vs the mid-market rate), for the plan and the bank baseline
  const atMidSrc = it.amountType === "RECIPIENT_FIXED" ? convert(net, it.destCcy, it.srcCcy, mid(it.destCcy, it.srcCcy, it.midOverrides ?? {})).minor : debit;
  const bps = (d: bigint, n: bigint) => {
    if (it.amountType === "RECIPIENT_FIXED") return atMidSrc > 0n ? Number(((d - atMidSrc) * 1000000n) / atMidSrc) / 100 : 0;
    const fair = convert(d, it.srcCcy, it.destCcy, mid(it.srcCcy, it.destCcy, it.midOverrides ?? {})).minor;
    return fair > 0n ? Number(((fair - n) * 1000000n) / fair) / 100 : 0;
  };
  const bankBasis = it.srcCcy === it.destCcy ? { bps: 0, basis: "no FX (same currency): wire fee only" } : it.currentBank?.measured ? bankMarkup(it.srcCcy, it.destCcy, it.currentBank.fxMarkupBps) : it.currentBank ? { bps: it.currentBank.fxMarkupBps, basis: "company-entered rate" } : null;
  return {
    status: "OK", decisionRecordId: `dr_${Date.now().toString(36)}`, intent: it, unpriced,
    provenance: { midRates: `${MARKET.mode}: ${it.srcCcy} ${midInfo(it.srcCcy).source}, ${it.destCcy} ${midInfo(it.destCcy).source}`,
                  bankBaseline: bankBasis ? `${bankBasis.bps} bps: ${bankBasis.basis}` : "none", ourRouteCosts: "stablecoin rail: sourced fees (Circle Mint redemption terms, network fees); local-coin conversion only at an entered venue quote" },
    costVsMidBps: { plan: bps(debit, net), bank: baseline?.quote ? bps(BigInt(baseline.quote.sourceDebit.minor), BigInt(baseline.quote.recipientNet.minor)) : null },
    objective: it.objective ?? "balanced", plan: useSplit ? "split" : "single",
    allocations: chosen.map((c) => ({ routeId: c.routeId, label: c.label, token: c.token, network: c.network,
      x402Executable: c.x402Executable, amount: c.amount, quote: c.quote, arrivalUtc: c.arrivalUtc, steps: c.steps })),
    cheapest: pick(eligible, (a, b) => Number(a.costMinor - b.costMinor)),
    fastest: pick(eligible, (a, b) => a.arrivalUtc.localeCompare(b.arrivalUtc) || Number(a.costMinor - b.costMinor)),
    bestX402: pick(eligible.filter((p) => p.x402Executable), (a, b) => Number(a.scoreMinor - b.scoreMinor)),
    execution: chosen.every((c) => c.x402Executable || c.kind === "bank")
      ? "executable: stablecoin legs fund via real x402 (testnet); bank legs simulated"
      : "winner uses a rail without a live adapter: it executes as a labeled simulation (use liveOnly for the best x402-executable plan)",
    totals: { sourceDebit: fmt(debit, it.srcCcy), recipientNet: fmt(net, it.destCcy), arrivalUtc: latest },
    bestUnsplit: bestUnsplit ? { routeId: bestUnsplit.routeId, sourceDebit: bestUnsplit.quote.sourceDebit.display, recipientNet: bestUnsplit.quote.recipientNet.display } : null,
    baseline: baseline?.quote ? { routeId: baseline.routeId, label: baseline.label, sourceDebit: baseline.quote.sourceDebit.display, sourceDebitMinor: baseline.quote.sourceDebit.minor,
      recipientNet: baseline.quote.recipientNet.display, arrivalUtc: baseline.arrivalUtc, meetsDeadline: baseline.eligible } : null,
    value: { customerSavings: fmt(savingsMinor, it.srcCcy), platformFee: fmt(feeMinor, it.srcCcy),
             customerNetSaving: fmt(savingsMinor - feeMinor, it.srcCcy), feeRule: `${(PLATFORM.feeBpsOfRailVolume / 100).toFixed(2)}% of the amount on our stablecoin rail, capped at half the measured saving; bank routes free` },
    candidates: priced.map((p) => ({ routeId: p.routeId, label: p.label, eligible: p.eligible, reason: p.reason, x402Executable: p.x402Executable,
      sourceDebit: p.quote?.sourceDebit.display, recipientNet: p.quote?.recipientNet.display, arrivalUtc: p.arrivalUtc })),
  };
}
