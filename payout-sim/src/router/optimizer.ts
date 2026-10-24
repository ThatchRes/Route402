// Deterministic route optimizer (guide A2 + A6 + A8). Pure functions: no I/O, no LLM, no guessed rates.
// Every candidate is priced through the SAME quoteFor() the payout service executes, so numbers match exactly.
import { quoteFor, type QuoteInput } from "../scenarios.js";
import { convert, decimals, fmt, toMinor } from "../money.js";
import { BANKS, NETWORKS, OFFRAMPS, ONRAMPS, PLATFORM, STABILITY, SWAPS, TOKENS, MID_PER_USD, venueQuote, localBankRoutes, type Tier } from "./registry.js";
import { latestStart, planningNow } from "./timing.js";
import { div, lessBps, mul } from "./rates.js";
import { bankMarkup, MARKET, midInfo } from "./market.js";
import { networkLabel, tokenizedConfig, tokenizedUnavailable } from "./tokenized.js";
import { STABLECOINS } from "./compliance.js";
import { assessExposure, type ExposureContext, type ExposureLeg } from "./exposure.js";
import { comparePlans, searchAllocations, type ScoredPlan } from "./allocationSearch.js";
/** The stablecoin issuer a route holds money with while it is in flight (first coin of the route), or null for bank routes. */
export const issuerOfCoins = (coins: string[]) => (coins.length ? STABLECOINS[coins[0]]?.issuer ?? coins[0] : null);   // live mids overwrite the demo table before any price is computed

export interface Intent {
  srcCcy: string; destCcy: string; amountType: "SOURCE_FIXED" | "RECIPIENT_FIXED"; amount: string;
  deadlineUtc?: string; objective?: "balanced" | "cheapest" | "fastest";   // default balanced = cost + speed
  allowSplit?: boolean; nowUtc?: string; midOverrides?: Record<string, string>;     // e.g. {"USD/XOF": "605.2"}
  costOfCashPct?: number; // annual company cost of cash; balanced prices the actual expected transit time
  liveOnly?: boolean;   // only routes whose funding can really execute today (x402 USDC on Base) or bank routes
  provider?: "stablecoin" | "bank" | "bank_wire" | "tokenized_deposit";   // one provider's routes only (each provider quotes separately)
  beneficiaryAcceptsUsdc?: boolean;   // supplier has a USDC wallet on file (USD-invoiced suppliers)
  reference?: string;                 // invoice reference carried with the payment (kept on the receipt)
  beneficiary?: any;                  // supplier details (payee history is updated when the payment completes)
  deadlineBufferMinutes?: number;
  issuerHeadroomUsd?: Record<string, number>;   // how much more each stablecoin issuer may hold under the company's per-issuer cap
  exposureContext?: ExposureContext; // attached by the backend, refreshed before approval/dispatch
  excludeCoins?: string[];      // coins the company's compliance rules forbid for this supplier (e.g. non-MiCA tokens to the EEA)
  bankComplement?: boolean;     // the stablecoin plan may send the part above its issuers' caps through the company's bank wire
  allowedRouteIds?: string[];         // dispatcher restricts re-planning to the user's approved routes
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
    : [...BANKS];
  banks.push(...localBankRoutes());
  for (const b of banks) {
    if (b.dest !== "*" && !b.dest.includes(it.destCcy)) continue;
    routes.push({ routeId: `bank:${b.id}`, kind: "bank", label: b.label, x402Executable: false, capacityUsd: b.capacityUsd,
      steps: [`${it.srcCcy} debit`, `${b.label} FX ${it.srcCcy}->${it.destCcy}`, `${it.destCcy} credit`], pegDeviation: 0, coins: [],
      build: (amountType, amount, usd) => ({ route: "bank", srcCcy: it.srcCcy, destCcy: it.destCcy, amountType, amount,
        fxRate: lessBps(mid(it.srcCcy, it.destCcy, o), sameCcy ? 0 : tierBps(b.tiers, usd)), fundingFee: usdToCcy(b.fixedUsd, it.srcCcy, o), payoutFee: "0" }),
      arrival: (now) => {
        if (b.id === "local_express") return new Date(now.getTime() + 4 * 3600e3); // fixture: 24/7, 4h, synthetic
        if (b.sameDayBeforeUtcHour !== undefined && isBiz(now) && now.getUTCHours() < b.sameDayBeforeUtcHour) return new Date(now.getTime() + 4 * 3600e3);
        const start = isBiz(now) && now.getUTCHours() < b.cutoffUtcHour ? now : nextBiz(now, 9);
        return addBizDays(start, b.businessDays);
      } });
  }
  // Tokenized deposit at the company's own bank: the bank converts at the margin in its tariff, the ledger settles 24/7
  // in the bank's stated time, and the supplier is credited in its local account. Offered only when an admin has entered
  // that tariff and it covers this corridor and the supplier's country (tokenized.ts).
  const tk = tokenizedConfig();
  if (tk && !tokenizedUnavailable(it.srcCcy, it.destCcy, it.beneficiary?.country)) {
    const label = `${networkLabel(tk.network)} (tokenized deposit at your bank)`;
    routes.push({ routeId: `tokenized:${tk.network}`, kind: "bank", label, x402Executable: false, capacityUsd: Infinity, pegDeviation: 0, coins: [],
      steps: [`${it.srcCcy} deposit token at your bank`, `${networkLabel(tk.network)} ${sameCcy ? "transfer" : `FX ${it.srcCcy}->${it.destCcy} at ${tk.fxMarginBps} bps`} (${tk.tariffSource})`, `${it.destCcy} credit to the supplier's account`],
      build: (amountType, amount) => ({ route: "bank", srcCcy: it.srcCcy, destCcy: it.destCcy, amountType, amount,
        fxRate: lessBps(mid(it.srcCcy, it.destCcy, o), sameCcy ? 0 : tk.fxMarginBps), fundingFee: usdToCcy(tk.feeUsd, it.srcCcy, o), payoutFee: "0" }),
      arrival: (now) => new Date(now.getTime() + tk.settlementMinutes * 60e3) });   // 24/7: no cut-offs or business days
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
            token: t1.id, network: netId, x402Executable: live, capacityUsd: Math.min(on.capacityUsd, sw.capacityUsd, off.capacityUsd, vq.capacityUsd ?? Infinity),
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
  const banned = new Set(it.excludeCoins ?? []), allowed = routes.filter((r) => !r.coins.some((c) => banned.has(c)));
  for (const c of new Set(routes.flatMap((r) => r.coins).filter((c) => banned.has(c)))) unpriced.push(`${c}: not allowed for this supplier under your compliance rules`);
  return { routes: allowed, missing, unpriced: [...new Set(unpriced)] };
}

export interface Priced {
  routeId: string; label: string; kind: string; token?: string; network?: string; x402Executable: boolean; steps: string[];
  amount: string; quote: any; arrivalUtc: string; costMinor: bigint; timeCostMinor: bigint; scoreMinor: bigint; eligible: boolean; reason?: string; exposure?: ExposureLeg;
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
  const dailyBps = it.costOfCashPct === undefined ? PLATFORM.timeValueBpsPerDay : it.costOfCashPct * 100 / 365;
  const time = (S * BigInt(Math.round(dailyBps * days * 100))) / 1_000_000n;
  const netInSrc = convert(net, it.destCcy, it.srcCcy, mid(it.destCcy, it.srcCcy, o)).minor;
  const binding = it.amountType === "RECIPIENT_FIXED" ? S : -netInSrc;
  // balanced (default): money cost + time value of a slower arrival. cheapest: money only. fastest: sorted by arrival.
  const score = binding + ((it.objective ?? "balanced") === "cheapest" ? 0n : time);
  const out: Priced = { ...base, quote, arrivalUtc: arrival.toISOString(), costMinor: binding, timeCostMinor: time, scoreMinor: score, eligible: true };
  const fail = (reason: string) => ({ ...out, eligible: false, reason });
  if (sizeUsd > r.capacityUsd) return fail(`exceeds provider capacity (${r.capacityUsd.toLocaleString()} USD-eq); a split may help`);
  const issuer = issuerOfCoins(r.coins), room = issuer ? it.issuerHeadroomUsd?.[issuer] : undefined;
  if (room !== undefined && sizeUsd > room) return fail(`exceeds provider capacity (${issuer} issuer cap: ${Math.max(0, Math.round(room)).toLocaleString()} USD left); a split across issuers may help`);
  if (issuer) {
    out.exposure = { issuer, issuers: [...new Set(r.coins.map((c) => STABLECOINS[c]?.issuer ?? c))], amountUsd: usdOf(quote.sourceDebit.display.split(" ")[0], it.srcCcy, o),
      durationHours: Math.max(0, days * 24), capacityUsd: r.capacityUsd,
      liquidityKey: `${r.coins.join(">")}:${r.routeId.split(":").at(-1)}` };
    if (it.exposureContext) {
      const check = assessExposure(it.exposureContext, [out.exposure]);
      if (!check.ok) return fail(`exceeds provider capacity (${check.reason}); a split may help`);
    }
  }
  if (deadline && arrival.getTime() + (it.deadlineBufferMinutes ?? 0) * 60_000 > deadline.getTime()) return fail(`arrives ${arrival.toISOString()}, cannot meet recipient deadline ${deadline.toISOString()}${it.deadlineBufferMinutes ? ` with ${it.deadlineBufferMinutes} min buffer` : ""}`);
  if (r.pegDeviation > STABILITY.maxPegDeviation) return fail(`${r.coins.join("/")} is ${r.pegDeviation} off peg (limit ${STABILITY.maxPegDeviation}): not stable enough`);
  return out;
}

const pick = (xs: Priced[], cmp: (a: Priced, b: Priced) => number) => {
  const p = [...xs].sort(cmp)[0];
  return p ? { routeId: p.routeId, label: p.label, sourceDebit: p.quote.sourceDebit.display, recipientNet: p.quote.recipientNet.display, arrivalUtc: p.arrivalUtc } : null;
};

export function optimize(it: Intent) {
  const now = new Date(it.nowUtc ?? planningNow());
  const deadline = it.deadlineUtc ? new Date(it.deadlineUtc) : undefined;
  if (!Number.isFinite(now.getTime()) || (deadline && !Number.isFinite(deadline.getTime()))
    || !Number.isFinite(it.deadlineBufferMinutes ?? 0) || (it.deadlineBufferMinutes ?? 0) < 0
    || (it.costOfCashPct !== undefined && (!Number.isFinite(it.costOfCashPct) || it.costOfCashPct < 0)))
    return { status: "MISSING_INPUT", missing: ["valid planning time, recipient deadline and non-negative buffer are required"] };
  const { routes, missing, unpriced } = enumerateRoutes(it);
  if (missing.length) return { status: "MISSING_INPUT", missing };
  // Providers: our stablecoin rail; the company's bank, which offers its wire and, when switched on, its tokenized deposits.
  // "bank" covers both (the agents' bank quote picks the better of the two); "bank_wire" and "tokenized_deposit" isolate one.
  const ofProvider = (id: string) => (id.startsWith("coin:") ? "stablecoin" : id.startsWith("tokenized:") ? "tokenized_deposit" : "bank_wire");
  // the bank wire as a complement: only inside a split with at least one stablecoin leg, never as the stablecoin plan on its own
  const complement = (id: string) => it.provider === "stablecoin" && !!it.bankComplement && ofProvider(id) === "bank_wire";
  const fromProvider = (id: string) => !it.provider || ofProvider(id) === it.provider || (it.provider === "bank" && ofProvider(id) !== "stablecoin") || complement(id);
  const usable = routes.filter((r) => (!it.liveOnly || r.kind === "bank" || r.x402Executable) && fromProvider(r.routeId)
    && (!it.allowedRouteIds || it.allowedRouteIds.includes(r.routeId)) && (process.env.LOCAL_ROUTING !== "1" || r.kind === "bank"));
  const priced = usable.map((r) => price(r, it, it.amount, now, deadline));
  const baselineId = it.currentBank ? "bank:current_bank" : "bank:legacy_wire";
  const baseline = priced.find((p) => p.routeId === baselineId)
    ?? routes.filter((r) => r.routeId === baselineId).map((r) => price(r, it, it.amount, now, undefined))[0];
  const eligible = priced.filter((p) => p.eligible && !complement(p.routeId));
  const scorePlan = (children: Priced[]): ScoredPlan => {
    const debit = children.reduce((s, c) => s + BigInt(c.quote.sourceDebit.minor), 0n);
    const net = children.reduce((s, c) => s + BigInt(c.quote.recipientNet.minor), 0n);
    const savingsMinor = !baseline?.quote ? 0n : it.amountType === "RECIPIENT_FIXED" ? BigInt(baseline.quote.sourceDebit.minor) - debit
      : convert(net - BigInt(baseline.quote.recipientNet.minor), it.destCcy, it.srcCcy, mid(it.destCcy, it.srcCcy, it.midOverrides ?? {})).minor;
    const railDebit = children.filter((c) => c.kind === "stablecoin").reduce((s, c) => s + BigInt(c.quote.sourceDebit.minor), 0n);
    const pctFee = railDebit * BigInt(PLATFORM.feeBpsOfRailVolume) / 10000n, feeCap = savingsMinor > 0n ? savingsMinor / 2n : 0n;
    const feeMinor = pctFee < feeCap ? pctFee : feeCap;
    const moneyCostMinor = children.reduce((s, c) => s + c.costMinor, 0n) + feeMinor;
    const timeCostMinor = children.reduce((s, c) => s + c.timeCostMinor, 0n);
    return { children, savingsMinor, feeMinor, moneyCostMinor, timeCostMinor, scoreMinor: moneyCostMinor + timeCostMinor,
      arrivalUtc: children.map((c) => c.arrivalUtc).sort().at(-1)! };
  };
  const feasible = (kids: Priced[], complete: boolean) => {
    if (!kids.length || kids.some((p) => !p.eligible)) return false;
    if (complete && kids.every((p) => complement(p.routeId))) return false;
    const issuers: Record<string, number> = {}, venues: Record<string, { used: number; cap: number }> = {};
    for (const kid of kids) {
      const e = kid.exposure; if (!e) continue;
      for (const issuer of e.issuers ?? [e.issuer]) issuers[issuer] = (issuers[issuer] ?? 0) + e.amountUsd;
      if (e.liquidityKey && e.capacityUsd !== undefined) {
        const v = venues[e.liquidityKey] ??= { used: 0, cap: e.capacityUsd };
        v.used += e.amountUsd; v.cap = Math.min(v.cap, e.capacityUsd);
      }
    }
    if (Object.entries(issuers).some(([issuer, used]) => it.issuerHeadroomUsd?.[issuer] !== undefined && used > it.issuerHeadroomUsd[issuer] + 0.000001)) return false;
    if (Object.values(venues).some((v) => v.used > v.cap + 0.000001)) return false;
    return !it.exposureContext || assessExposure(it.exposureContext, kids.flatMap((k) => k.exposure ? [k.exposure] : [])).ok;
  };
  const ccy = it.amountType === "SOURCE_FIXED" ? it.srcCcy : it.destCcy, total = toMinor(it.amount, ccy), dec = decimals(ccy);
  const str = (m: bigint) => { const s = m.toString().padStart(dec + 1, "0"); return dec ? `${s.slice(0, -dec)}.${s.slice(-dec)}` : s; };
  const byId = new Map(usable.map((r) => [r.routeId, r])), memo = new Map<string, Priced>();
  for (const p of priced) memo.set(`${p.routeId}:${total}`, p);
  const searched = searchAllocations({ total, allowSplit: it.allowSplit !== false,
    routeIds: priced.filter((p) => p.quote && (p.eligible || p.reason?.startsWith("exceeds provider capacity"))).map((p) => p.routeId),
    price: (id, amount) => { const key = `${id}:${amount}`; let p = memo.get(key);
      if (!p) { p = price(byId.get(id)!, it, str(amount), now, deadline); memo.set(key, p); } return p; },
    feasible, score: scorePlan });
  const objective = it.objective ?? "balanced", winner = searched.best[objective];
  const bestUnsplit = searched.singles[objective]?.children[0];
  const chosen = winner?.children, useSplit = chosen && chosen.length > 1;

  if (!chosen) return { status: "HOLD", reason: process.env.LOCAL_ROUTING === "1" && it.provider === "stablecoin" ? "stablecoin settlement disabled in LOCAL_ROUTING; use simulated bank routes"
    : priced.length ? [...new Set(priced.map((p) => `${p.label}: ${p.reason}`))].join("; ")
    : it.provider === "tokenized_deposit" ? (tokenizedUnavailable(it.srcCcy, it.destCcy, it.beneficiary?.country) ?? "no tokenized route meets this payment's deadline") : it.provider === "stablecoin" ? (unpriced.length ? unpriced.join("; ") : `our stablecoin rail has no published-price route to ${it.destCcy} yet`) : "no eligible route or allocation",
    deadlineUtc: it.deadlineUtc, earliestArrivalUtc: priced.filter((p) => p.quote).map((p) => p.arrivalUtc).sort()[0] ?? null,
    unpriced, candidates: priced, baseline };

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
  const summary = (p?: ScoredPlan) => p ? { routeId: p.children.map((c) => c.routeId).join("+"),
    sourceDebit: fmt(p.children.reduce((s, c) => s + BigInt(c.quote.sourceDebit.minor), 0n), it.srcCcy),
    recipientNet: fmt(p.children.reduce((s, c) => s + BigInt(c.quote.recipientNet.minor), 0n), it.destCcy), arrivalUtc: p.arrivalUtc,
    moneyCostMinor: p.moneyCostMinor.toString(), timeCostMinor: p.timeCostMinor.toString(), combinedCostMinor: p.scoreMinor.toString(),
    platformFee: fmt(p.feeMinor, it.srcCcy), sourceCcy: it.srcCcy, legs: p.children.length } : null;
  return {
    status: "OK", decisionRecordId: `dr_${Date.now().toString(36)}`, intent: it, unpriced,
    exposure: it.exposureContext ? assessExposure(it.exposureContext, chosen.flatMap((c) => c.exposure ? [c.exposure] : [])) : null,
    timing: { plannedAtUtc: now.toISOString(), deadlineUtc: it.deadlineUtc ?? null, bufferMinutes: it.deadlineBufferMinutes ?? 0,
      latestStartUtc: deadline ? chosen.map((c) => latestStart(usable.find((r) => r.routeId === c.routeId)!.arrival, now, deadline, it.deadlineBufferMinutes)).sort()[0] : null,
      dispatch: "immediate_after_approval", arrivalUtc: latest, meetsDeadline: true },
    simulation: process.env.LOCAL_ROUTING === "1",
    provenance: { midRates: `${MARKET.mode}: ${it.srcCcy} ${midInfo(it.srcCcy).source}, ${it.destCcy} ${midInfo(it.destCcy).source}`,
                  bankBaseline: bankBasis ? `${bankBasis.bps} bps: ${bankBasis.basis}` : "none", ourRouteCosts: "stablecoin rail: sourced fees (Circle Mint redemption terms, network fees); local-coin conversion only at an entered venue quote" },
    costVsMidBps: { plan: bps(debit, net), withPlatformFee: bps(debit + feeMinor, net), bank: baseline?.quote ? bps(BigInt(baseline.quote.sourceDebit.minor), BigInt(baseline.quote.recipientNet.minor)) : null },
    objective: it.objective ?? "balanced", plan: useSplit ? "split" : "single",
    selection: summary(winner),
    search: { method: "all available routes, capacity boundaries and interior samples", maxLegs: 3, plansEvaluated: searched.evaluated,
      assurance: "Best evaluated feasible plan; quotes, available routes and the three-leg search limit define the comparison." },
    allocations: chosen.map((c) => ({ routeId: c.routeId, label: c.label, token: c.token, network: c.network, exposure: c.exposure,
      x402Executable: c.x402Executable, amount: c.amount, quote: c.quote, arrivalUtc: c.arrivalUtc, steps: c.steps })),
    cheapest: summary(searched.best.cheapest), fastest: summary(searched.best.fastest), balanced: summary(searched.best.balanced),
    bestX402: pick(eligible.filter((p) => p.x402Executable), (a, b) => comparePlans(scorePlan([a]), scorePlan([b]), objective)),
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
