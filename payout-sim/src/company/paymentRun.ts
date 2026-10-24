// One company payment run = the four levers that actually save money, applied in order:
//   1. validate beneficiaries (block payments that would bounce)
//   2. timing (take early-payment discounts only when they beat the cost of cash)
//   3. natural hedge (pay foreign invoices from foreign money already received; convert only the rest)
//   4. route the remainder through the optimizer
// Every saving is measured against the company's CURRENT bank, pricing each conversion with the same exact math.
import { optimize, mid } from "../router/optimizer.js";
import { convert, fmt, toMinor } from "../money.js";
import { validate, type Beneficiary } from "./validate.js";
import type { CompanyProfile } from "./profile.js";

export interface RunPayable { id: string; beneficiary: Beneficiary; ccy: string; amount: string; dueUtc: string; discountPct?: number; discountByUtc?: string }
export interface RunReceivable { id: string; ccy: string; amount: string; dateUtc: string; status: "confirmed" | "expected" }
export interface PaymentRunInput { company: CompanyProfile; nowUtc: string; payables: RunPayable[]; receivables: RunReceivable[];
  receivablesScope?: "all" | "matched" }   // "matched": only receipts used to pay these bills count (for a filtered request)

type Conv = { costHome: bigint; debitHome: bigint; route: string; arrivalUtc?: string; input?: any };

export function runPaymentRun(r: PaymentRunInput) {
  const co = r.company, H = co.homeCcy, now = r.nowUtc;
  const bank = { label: co.currentBank.label, fxMarkupBps: co.currentBank.fxMarkupBps, wireFeeUsd: co.currentBank.wireFeeUsd, businessDays: co.currentBank.businessDays };
  const midHome = (m: bigint, c: string) => convert(m, c, H, mid(c, H)).minor;

  // cost (vs mid) of buying `amount` of ccy from home currency: via the company's bank, or via our best route
  const buy = (ccy: string, amountMinor: bigint, deadline: string | undefined, viaBank: boolean): Conv => {
    if (amountMinor === 0n) return { costHome: 0n, debitHome: 0n, route: "-" };
    const amt = fmt(amountMinor, ccy).split(" ")[0];
    if (ccy === H) return viaBank ? { costHome: toMinor(co.currentBank.wireFeeUsd.toFixed(2), H), debitHome: amountMinor, route: "bank:current_bank (domestic)" }
                                  : { costHome: 0n, debitHome: amountMinor, route: "domestic (no FX)" };
    const o: any = optimize({ srcCcy: H, destCcy: ccy, amountType: "RECIPIENT_FIXED", amount: amt, deadlineUtc: viaBank ? undefined : deadline,
      objective: "balanced", nowUtc: now, currentBank: bank });
    const atMid = midHome(amountMinor, ccy);
    if (viaBank) { const d = BigInt(o.baseline.sourceDebitMinor); return { costHome: d - atMid, debitHome: d, route: o.baseline.routeId }; }
    if (o.status !== "OK") return { costHome: 0n, debitHome: 0n, route: `HOLD: ${o.reason ?? o.missing}` };
    const d = toMinor(o.totals.sourceDebit.split(" ")[0], H);
    return { costHome: d - atMid, debitHome: d, route: o.allocations.map((a: any) => a.routeId).join("+"), arrivalUtc: o.totals.arrivalUtc,
             input: o.allocations.map((a: any) => a.quote.input) };
  };
  // cost of selling leftover foreign receivables back to home currency
  const sell = (ccy: string, amountMinor: bigint, viaBank: boolean): bigint => {
    if (amountMinor === 0n || ccy === H) return 0n;
    const o: any = optimize({ srcCcy: ccy, destCcy: H, amountType: "SOURCE_FIXED", amount: fmt(amountMinor, ccy).split(" ")[0], objective: "cheapest", nowUtc: now, currentBank: bank });
    const net = viaBank ? toMinor(o.baseline.recipientNet.split(" ")[0], H) : o.status === "OK" ? toMinor(o.totals.recipientNet.split(" ")[0], H) : 0n;
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
      const c = buy(p.ccy, toMinor(p.amount, p.ccy), undefined, true);
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
        discountGain += midHome(disc - cash, p.ccy); payOn = p.discountByUtc; note = `early-pay discount ${p.discountPct}% (${annual.toFixed(0)}%/yr)`;
      } else note = `discount ${annual.toFixed(1)}%/yr < cost of cash: pay on due date`;
    }
    if (v.status === "REVIEW") note = [note, `REVIEW: ${v.warnings.join("; ")}`].filter(Boolean).join(" | ");
    sendable.push({ ...p, payOnUtc: payOn, _note: note } as any);
  }

  // ---------- 3 + 4: scenarios A (bank, no wallet), B (our routes, no wallet), C (our routes + natural hedge)
  let A = 0n, B = 0n, C = 0n, volA = 0n, volC = 0n;
  const ccys = [...new Set([...sendable.map((p) => p.ccy), ...r.receivables.map((x) => x.ccy)])];
  for (const ccy of ccys) {
    const pays = sendable.filter((p) => p.ccy === ccy).sort((a, b) => a.payOnUtc.localeCompare(b.payOnUtc));
    const recs = r.receivables.filter((x) => x.ccy === ccy).sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
    const recConfirmed = recs.filter((x) => x.status === "confirmed");
    const totalRec = recConfirmed.reduce((s, x) => s + toMinor(x.amount, ccy), 0n);
    // C first: wallet in ccy, receivables that arrived before each payment fund it; buy the shortfall via our route
    let wallet = 0n, ri = 0, matchedRec = 0n;
    for (const p of pays) {
      while (ri < recs.length && recs[ri].dateUtc <= p.payOnUtc) { if (recs[ri].status === "confirmed") wallet += toMinor(recs[ri].amount, ccy); ri++; }
      const need = toMinor(p.amount, ccy), use = ccy === H ? 0n : (wallet >= need ? need : wallet); wallet -= use; matchedRec += use;
      const c = buy(ccy, need - use, p.payOnUtc, false); C += c.costHome; if (ccy !== H) volC += midHome(need - use, ccy);
      lines.push({ payable: p.id, ccy, convertedAmount: fmt(need - use, ccy).split(" ")[0], deadlineUtc: p.payOnUtc,
                   payOnUtc: p.payOnUtc.slice(0, 10), amount: `${p.amount} ${ccy}`, fromWallet: fmt(use, ccy), converted: fmt(need - use, ccy),
                   route: need - use > 0n ? c.route : "wallet only", arrivesUtc: c.arrivalUtc, note: (p as any)._note || undefined, plan: c.input });
    }
    for (; ri < recs.length; ri++) if (recs[ri].status === "confirmed") wallet += toMinor(recs[ri].amount, ccy);
    const scopeAll = (r.receivablesScope ?? "all") === "all";
    const recCounted = scopeAll ? totalRec : matchedRec;            // receipts that are part of this request
    if (scopeAll) { C += sell(ccy, wallet, false); if (ccy !== H) volC += midHome(wallet, ccy); }
    // A (your bank) and B (our routes, no wallets): every payable bought separately, counted receipts sold on arrival
    for (const p of pays) { const a = buy(ccy, toMinor(p.amount, ccy), p.payOnUtc, true), b = buy(ccy, toMinor(p.amount, ccy), p.payOnUtc, false); A += a.costHome; B += b.costHome; if (ccy !== H) volA += midHome(toMinor(p.amount, ccy), ccy); }
    A += sell(ccy, recCounted, true); B += sell(ccy, recCounted, false); if (ccy !== H) volA += midHome(recCounted, ccy);
  }
  const routing = A - B, hedge = B - C, total = routing + hedge + discountGain + validationAvoided;
  const fee = total > 0n ? (total * BigInt(co.pricing.savingsSharePct)) / 100n : 0n;
  const f = (x: bigint) => fmt(x, H);
  return {
    company: co.name, homeCcy: H, baseline: `${co.currentBank.label}: ${co.currentBank.fxMarkupBps} bps FX markup, ${co.currentBank.wireFeeUsd} USD/wire, T+${co.currentBank.businessDays}`,
    provenance: "synthetic rates; baseline from company bank terms", lines,
    expectedOnly: r.receivables.filter((x) => x.status === "expected").map((x) => `${x.id} ${x.amount} ${x.ccy} (expected, not relied on)`),
    fxVolume: { withYourBank: f(volA), withUs: f(volC) },
    costVsMid: { withYourBank: f(A), routingOnly: f(B), routingPlusWallets: f(C) },
    savings: { routing: f(routing), naturalHedge: f(hedge), earlyPayDiscounts: f(discountGain), failedPaymentsAvoided: f(validationAvoided), total: f(total) },
    ourFee: f(fee), companyKeeps: f(total - fee),
    multiEntity: (co.entities?.length ?? 0) > 1 ? "netting and cash pooling available: npm run treasury" : "single entity: netting/pooling not applicable",
  };
}
