// One company payment run = the four levers that actually save money, applied in order:
//   1. validate beneficiaries (block payments that would bounce)
//   2. timing (take early-payment discounts only when they beat the cost of cash)
//   3. natural hedge (pay foreign invoices from foreign money already received; convert only the rest)
//   4. route the remainder through the optimizer
// Every saving is measured against the company's CURRENT bank, pricing each conversion with the same exact math.
import { optimize, mid, type Intent } from "../router/optimizer.js";
import { bankMarkup, MARKET, midInfo } from "../router/market.js";
import { venueQuote } from "../router/registry.js";
import { convert, fmt, toMinor } from "../money.js";
import { validate, type Beneficiary } from "./validate.js";
import type { CompanyProfile } from "./profile.js";

export interface RunPayable { id: string; beneficiary: Beneficiary; ccy: string; amount: string; dueUtc: string; discountPct?: number; discountByUtc?: string }
export interface RunReceivable { id: string; ccy: string; amount: string; dateUtc: string; status: "confirmed" | "expected" }
export interface PaymentRunInput { company: CompanyProfile; nowUtc: string; payables: RunPayable[]; receivables: RunReceivable[];
  receivablesScope?: "all" | "matched" }   // "matched": only receipts used to pay these bills count (for a filtered request)

type Conv = { costHome: bigint; debitHome: bigint; route: string; arrivalUtc?: string; input?: any; timing?: any; blocked?: boolean; why?: string };

export function runPaymentRun(r: PaymentRunInput, budget: Pick<Intent, "exposureContext" | "issuerHeadroomUsd" | "objective"> = {}) {
  const co = r.company, H = co.homeCcy, now = r.nowUtc;
  const bank = { label: co.currentBank.label, fxMarkupBps: co.currentBank.fxMarkupBps, wireFeeUsd: co.currentBank.wireFeeUsd, businessDays: co.currentBank.businessDays, measured: co.currentBank.measured };
  const midHome = (m: bigint, c: string) => convert(m, c, H, mid(c, H)).minor;

  // cost (vs mid) of buying `amount` of ccy from home currency: via the company's bank, or via our best route
  const HOME_COUNTRY = "US";
  const buy = (ccy: string, amountMinor: bigint, deadline: string | undefined, viaBank: boolean, ben?: Beneficiary): Conv => {
    if (amountMinor === 0n) return { costHome: 0n, debitHome: 0n, route: "-" };
    const amt = fmt(amountMinor, ccy).split(" ")[0];
    // Domestic home-currency payment: the company's bank either way (no saving claimed)
    if (ccy === H && (!ben || ben.country === HOME_COUNTRY)) {
      const fee = toMinor(co.currentBank.wireFeeUsd.toFixed(2), H);
      return { costHome: fee, debitHome: amountMinor + fee, route: "bank:current_bank (domestic)" };
    }
    // Cross-border (incl. USD-invoiced suppliers abroad): our rail vs the company's bank
    const o: any = optimize({ ...(!viaBank ? budget : {}), srcCcy: H, destCcy: ccy, amountType: "RECIPIENT_FIXED", amount: amt, deadlineUtc: viaBank ? undefined : deadline,
      objective: budget.objective ?? "balanced", costOfCashPct: co.costOfCashPct, nowUtc: now, currentBank: bank, beneficiaryAcceptsUsdc: !!ben?.usdcWallet });
    const atMid = midHome(amountMinor, ccy);
    if (viaBank) { const d = BigInt(o.baseline.sourceDebitMinor); return { costHome: d - atMid, debitHome: d, route: o.baseline.routeId }; }
    if (o.status !== "OK") {
      // Retain the bank cost only for baseline accounting, never present a late fallback as a sendable plan.
      const bm = o.baseline?.sourceDebitMinor ?? o.baseline?.quote?.sourceDebit?.minor;   // HOLD returns the raw priced baseline
      if (bm) { const d = BigInt(bm);
        return { costHome: d - atMid, debitHome: d, route: "HOLD", blocked: true, why: o.reason ?? String(o.missing) }; }
      return { costHome: 0n, debitHome: 0n, route: "HOLD", blocked: true, why: o.reason ?? String(o.missing) };
    }
    const d = toMinor(o.totals.sourceDebit.split(" ")[0], H);
    return { costHome: d - atMid, debitHome: d, route: o.allocations.map((a: any) => a.routeId).join("+"), arrivalUtc: o.totals.arrivalUtc,
             input: o.allocations.map((a: any) => a.quote.input), timing: o.timing };
  };
  // cost of selling leftover foreign receivables back to home currency
  const sell = (ccy: string, amountMinor: bigint, viaBank: boolean): bigint => {
    if (amountMinor === 0n || ccy === H) return 0n;
    const o: any = optimize({ srcCcy: ccy, destCcy: H, amountType: "SOURCE_FIXED", amount: fmt(amountMinor, ccy).split(" ")[0], objective: "cheapest", nowUtc: now, currentBank: bank });
    // our rail only buys from USD; selling foreign receipts goes through the company's bank either way
    const net = viaBank || o.status !== "OK" ? toMinor(o.baseline.recipientNet.split(" ")[0], H) : toMinor(o.totals.recipientNet.split(" ")[0], H);
    return midHome(amountMinor, ccy) - net;
  };

  const lines: any[] = [];
  let validationAvoided = 0n, discountGain = 0n;
  // ---------- 1 + 2: validation and timing
  const sendable: (RunPayable & { payOnUtc: string })[] = [];
  for (const p of r.payables) {
    const v = validate(p.beneficiary);
    if (v.status === "BLOCK") {
      // a bounced payment costs the return fee plus converting twice at the bank's markup
      const c = buy(p.ccy, toMinor(p.amount, p.ccy), undefined, true, p.beneficiary);
      validationAvoided += toMinor(co.currentBank.returnFeeUsd.toFixed(2), H) + (p.ccy === H ? 0n : c.costHome);
      lines.push({ payable: p.id, status: "BLOCKED before sending", why: v.errors.join("; ") }); continue;
    }
    let payOn = p.dueUtc, note = "";
    if (p.discountPct && p.discountByUtc && new Date(p.discountByUtc) > new Date(now)) {
      const daysEarly = (Date.parse(p.dueUtc) - Date.parse(p.discountByUtc)) / 86400e3;
      const annual = (p.discountPct / (100 - p.discountPct)) * (365 / daysEarly) * 100;
      if (annual > co.costOfCashPct) {
        const amt = toMinor(p.amount, p.ccy), disc = (amt * BigInt(Math.round(p.discountPct * 100))) / 10000n;
        const cash = (amt * BigInt(Math.round(co.costOfCashPct * 100)) * BigInt(Math.round(daysEarly))) / (10000n * 365n);
        const route = buy(p.ccy, amt, p.discountByUtc, false, p.beneficiary);
        if (!route.blocked) { discountGain += midHome(disc - cash, p.ccy); payOn = p.discountByUtc; note = `early-pay discount ${p.discountPct}% (${annual.toFixed(0)}%/yr)`; }
        else note = "early-payment deadline unavailable: use original invoice deadline; no discount saving claimed";
      } else note = `discount ${annual.toFixed(1)}%/yr < cost of cash: pay on due date`;
    }
    if (v.status === "REVIEW") note = [note, `REVIEW: ${v.warnings.join("; ")}`].filter(Boolean).join(" | ");
    sendable.push({ ...p, payOnUtc: payOn, _note: note } as any);
  }

  // ---------- 3 + 4: scenarios A (bank, no wallet), B (our routes, no wallet), C (our routes + natural hedge)
  const feeBps = co.pricing.feeBpsOfRailVolume ?? 15;
  let A = 0n, B = 0n, C = 0n, volA = 0n, volC = 0n, railVol = 0n, railPayments = 0, xbUsd = 0n, fee = 0n, feeCapped = 0;   // railVol: volume on OUR rail; xbUsd: USD paid to suppliers abroad
  const ccys = [...new Set([...sendable.map((p) => p.ccy), ...r.receivables.map((x) => x.ccy)])];
  for (const ccy of ccys) {
    const pays = sendable.filter((p) => p.ccy === ccy).sort((a, b) => a.payOnUtc.localeCompare(b.payOnUtc));
    const recs = r.receivables.filter((x) => x.ccy === ccy).sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
    const recConfirmed = recs.filter((x) => x.status === "confirmed");
    const totalRec = recConfirmed.reduce((s, x) => s + toMinor(x.amount, ccy), 0n);
    // C first: wallet in ccy, receivables that arrived before each payment fund it; buy the shortfall via our route
    let wallet = 0n, ri = 0, matchedRec = 0n;
    for (const p of pays) {
      while (ri < recs.length && recs[ri].dateUtc <= now) { if (recs[ri].status === "confirmed") wallet += toMinor(recs[ri].amount, ccy); ri++; }
      const need = toMinor(p.amount, ccy), use = ccy === H ? 0n : (wallet >= need ? need : wallet); wallet -= use; matchedRec += use;
      const c = buy(ccy, need - use, p.payOnUtc, false, p.beneficiary); C += c.costHome; if (ccy !== H) volC += midHome(need - use, ccy);
      if (c.route.startsWith("coin:")) {
        // our fee: 0.15% of the amount sent on our rail, but never more than half of what this payment saves vs the company's bank
        const v = midHome(need - use, ccy), bankCost = buy(ccy, need - use, p.payOnUtc, true, p.beneficiary).costHome;
        const pctFee = (v * BigInt(feeBps)) / 10000n, saved = bankCost - c.costHome > 0n ? (bankCost - c.costHome) / 2n : 0n;   // cap: half the saving, so the company always keeps at least half
        fee += pctFee < saved ? pctFee : saved; if (pctFee > saved) feeCapped++;
        railVol += v; railPayments++;
      }
      const crossBorder = ccy !== H || p.beneficiary.country !== HOME_COUNTRY;
      lines.push({ payable: p.id, ccy, crossBorder, reference: p.id, beneficiary: p.beneficiary, convertedAmount: fmt(need - use, ccy).split(" ")[0], deadlineUtc: p.payOnUtc,
                   payOnUtc: p.payOnUtc.slice(0, 10), amount: `${p.amount} ${ccy}`, fromWallet: fmt(use, ccy), converted: fmt(need - use, ccy),
                   route: need - use > 0n ? c.route : "wallet only", arrivesUtc: c.arrivalUtc, note: (p as any)._note || undefined, plan: c.input });
      const line = lines[lines.length - 1];
      line.timing = c.timing; line.planningStatus = c.blocked ? "HOLD" : "READY";
      if (c.blocked) { line.status = "HOLD"; line.why = c.why; }
    }
    for (; ri < recs.length; ri++) if (recs[ri].status === "confirmed") wallet += toMinor(recs[ri].amount, ccy);
    const scopeAll = (r.receivablesScope ?? "all") === "all";
    const recCounted = scopeAll ? totalRec : matchedRec;            // receipts that are part of this request
    if (scopeAll) { C += sell(ccy, wallet, false); if (ccy !== H) volC += midHome(wallet, ccy); }
    // A (your bank) and B (our routes, no wallets): every payable bought separately, counted receipts sold on arrival
    for (const p of pays) { const a = buy(ccy, toMinor(p.amount, ccy), p.payOnUtc, true, p.beneficiary), b = buy(ccy, toMinor(p.amount, ccy), p.payOnUtc, false, p.beneficiary); A += a.costHome; B += b.costHome; if (ccy !== H) volA += midHome(toMinor(p.amount, ccy), ccy);
      else if (p.beneficiary.country !== HOME_COUNTRY) xbUsd += toMinor(p.amount, ccy); }
    A += sell(ccy, recCounted, true); B += sell(ccy, recCounted, false); if (ccy !== H) volA += midHome(recCounted, ccy);
  }
  const routing = A - B, hedge = B - C, total = routing + hedge + discountGain + validationAvoided;
  // Our fee (computed per rail payment above): 0.15% of rail volume, capped at that payment's saving. Balances, discounts and checks are free.
  const pctOf = (x: bigint, base: bigint) => base > 0n ? `${(Number((x * 1_000_000n) / base) / 10000).toFixed(2)}%` : "0.00%";
  const f = (x: bigint) => fmt(x, H);
  return {
    company: co.name, homeCcy: H,
    baseline: co.currentBank.measured
      ? `${co.currentBank.label}: measured bank FX markup per corridor, ${co.currentBank.wireFeeUsd} USD/wire, T+${co.currentBank.businessDays}`
      : `${co.currentBank.label}: ${co.currentBank.fxMarkupBps} bps FX markup, ${co.currentBank.wireFeeUsd} USD/wire, T+${co.currentBank.businessDays}`,
    market: {
      mode: MARKET.mode, loadedAt: MARKET.loadedAt, sources: MARKET.sources, notes: MARKET.notes,
      corridors: ccys.filter((c) => c !== H).map((c) => {
        const b = co.currentBank.measured ? bankMarkup(H, c, co.currentBank.fxMarkupBps) : { bps: co.currentBank.fxMarkupBps, basis: "company-entered rate" };
        const m = midInfo(c), vq = venueQuote(c);
        return { pair: `${H}/${c}`, mid: m.rate, midSource: `${m.source}${m.date !== "-" ? ` ${m.date}` : ""}`, bankMarkupBps: b.bps, bankBasis: b.basis,
                 stablecoin: c === H ? "USDC to supplier wallet: network fee only" : vq ? `venue quote ${(vq.bps / 100).toFixed(2)}% (${vq.source})` : "needs a live venue quote (not published)" };
      }),
    },
    provenance: `mid rates: ${MARKET.mode}; bank baseline: ${co.currentBank.measured ? "measured (Wise comparison data)" : "company-entered"}; stablecoin rail: sourced fees; local-coin conversion only at an entered venue quote`, lines,
    expectedOnly: r.receivables.filter((x) => x.status === "expected").map((x) => `${x.id} ${x.amount} ${x.ccy} (expected, not relied on)`),
    fxVolume: { withYourBank: f(volA), withUs: f(volC) },
    costVsMid: { withYourBank: f(A), routingOnly: f(B), routingPlusWallets: f(C) },
    savingsStatus: "projected_before_agent_review", heldPayments: lines.filter((l) => l.planningStatus === "HOLD").length,
    savings: { routing: f(routing), naturalHedge: f(hedge), earlyPayDiscounts: f(discountGain), failedPaymentsAvoided: f(validationAvoided), total: f(total) },
    savingsGroups: {
      routing: { label: "routing savings (our stablecoin rail vs your bank: FX markup + wire fees)", total: f(routing) },
      treasury: { label: "treasury suggestions (free)", items: { "pay from existing balances": f(hedge), "early-pay discounts": f(discountGain) }, total: f(hedge + discountGain) },
      checks: { label: "pre-send checks (free)", items: { "failed payments avoided": f(validationAvoided) }, total: f(validationAvoided) },
    },
    ourFee: f(fee), feeRule: `${(feeBps / 100).toFixed(2)}% of ${f(railVol)} sent on our stablecoin rail (${railPayments} payment(s)), capped at half of each payment's measured saving${feeCapped ? ` (cap applied to ${feeCapped})` : ""}; payments through your bank and treasury suggestions are free`, companyKeeps: f(total - fee),
    // percentages are of cross-border volume: foreign-currency payments + USD paid to suppliers abroad
    percent: { savedOfFxVolume: pctOf(total, volA + xbUsd), keptOfFxVolume: pctOf(total - fee, volA + xbUsd), routingOfFxVolume: pctOf(routing, volA + xbUsd),
               bankCostOfFxVolume: pctOf(A, volA + xbUsd), ourCostOfFxVolume: pctOf(C, volA + xbUsd), feeOfFxVolume: pctOf(fee, volA + xbUsd) },
    crossBorderVolume: f(volA + xbUsd),
    multiEntity: (co.entities?.length ?? 0) > 1 ? "netting and cash pooling available: npm run treasury" : "single entity: netting/pooling not applicable",
  };
}
