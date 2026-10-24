// Early-payment discount optimizer. Pay early only when the discount beats what the cash earns (or costs) meanwhile;
// otherwise pay on the due date. Example 2/10 net 30: 2% for paying 20 days early = ~37% annualized.
import { fmt, toMinor } from "../money.js";

export interface PayableTerms { id: string; ccy: string; amount: string; invoiceUtc: string; dueUtc: string;
  discountPct?: number; discountByUtc?: string }
export interface DiscountInput { payables: PayableTerms[]; costOfCashPct: number; nowUtc: string }

export function runDiscounts(d: DiscountInput) {
  const now = new Date(d.nowUtc); let captured = 0n; const ccy = d.payables[0]?.ccy ?? "USD";
  const decisions = d.payables.map((p) => {
    const amt = toMinor(p.amount, p.ccy);
    if (!p.discountPct || !p.discountByUtc || new Date(p.discountByUtc) < now)
      return { invoice: p.id, decision: "pay on due date", payOnUtc: p.dueUtc, reason: p.discountPct ? "discount window passed" : "no discount offered" };
    const daysEarly = (Date.parse(p.dueUtc) - Date.parse(p.discountByUtc)) / 86400e3;
    const annualized = (p.discountPct / (100 - p.discountPct)) * (365 / daysEarly) * 100;
    const discount = (amt * BigInt(Math.round(p.discountPct * 100))) / 10000n;
    const cashCost = (amt * BigInt(Math.round(d.costOfCashPct * 100)) * BigInt(Math.round(daysEarly))) / (10000n * 365n);
    if (annualized > d.costOfCashPct) {
      if (p.ccy === ccy) captured += discount - cashCost;
      return { invoice: p.id, decision: `pay early by ${p.discountByUtc.slice(0, 10)}`, discount: fmt(discount, p.ccy),
               annualizedReturn: `${annualized.toFixed(1)}%`, netGainAfterCashCost: fmt(discount - cashCost, p.ccy) };
    }
    return { invoice: p.id, decision: "pay on due date", payOnUtc: p.dueUtc, reason: `discount = ${annualized.toFixed(1)}%/yr, below cost of cash ${d.costOfCashPct}%` };
  });
  return { advisoryOnly: true, costOfCashPct: d.costOfCashPct, decisions, netGain: fmt(captured, ccy) };
}
