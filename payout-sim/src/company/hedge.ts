// Multi-currency wallets + natural-hedge matching. A company that RECEIVES a currency and also PAYS in it
// should not convert both ways. Incoming receivables in a currency fund that currency's payables first
// (respecting dates: money must arrive before it is spent, no look-ahead), and only the shortfall or surplus is converted.
import { optimize, mid } from "../router/optimizer.js";
import { convert, fmt, toMinor } from "../money.js";

export interface Flow { id: string; ccy: string; amount: string; dateUtc: string; status?: "confirmed" | "expected" }
export interface HedgeInput { homeCcy: string; receivables: Flow[]; payables: Flow[]; nowUtc?: string; holdSurplus?: boolean }

function fxCostVsMid(src: string, dest: string, amount: string, type: "SOURCE_FIXED" | "RECIPIENT_FIXED", nowUtc?: string) {
  const r: any = optimize({ srcCcy: src, destCcy: dest, amountType: type, amount, objective: "cheapest", nowUtc });
  if (r.status !== "OK") return { costHomeMinor: null as bigint | null, route: r.missing?.join(";") ?? r.reason };
  const debit = toMinor(r.totals.sourceDebit.split(" ")[0], src), net = toMinor(r.totals.recipientNet.split(" ")[0], dest);
  const midValueOfNet = convert(net, dest, src, mid(dest, src)).minor;
  return { costHomeMinor: debit - midValueOfNet, route: r.allocations.map((a: any) => a.routeId).join("+"), src };
}

export function runHedge(h: HedgeInput) {
  const ccys = [...new Set([...h.receivables, ...h.payables].map((f) => f.ccy))].filter((c) => c !== h.homeCcy);
  const toHome = (m: bigint, c: string) => convert(m, c, h.homeCcy, mid(c, h.homeCcy)).minor;
  let baseCost = 0n, planCost = 0n, baseVol = 0n, planVol = 0n;
  const perCcy: any[] = [], skipped: string[] = [];
  for (const c of ccys) {
    const rec = h.receivables.filter((f) => f.ccy === c).sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
    const pay = h.payables.filter((f) => f.ccy === c).sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
    // baseline: convert every receivable to home on arrival, buy every payable from home when due
    for (const f of rec) { const x = fxCostVsMid(c, h.homeCcy, f.amount, "SOURCE_FIXED", h.nowUtc); if (x.costHomeMinor !== null) { baseCost += x.costHomeMinor; baseVol += toHome(toMinor(f.amount, c), c); } }
    for (const f of pay) { const x = fxCostVsMid(h.homeCcy, c, f.amount, "RECIPIENT_FIXED", h.nowUtc); if (x.costHomeMinor !== null) { baseCost += x.costHomeMinor; baseVol += toHome(toMinor(f.amount, c), c); } }
    // plan: wallet in c; each payable is funded by confirmed receivables that arrived before it; shortfall bought, surplus kept or sold
    let wallet = 0n, ri = 0, matched = 0n, bought = 0n; const steps: string[] = [];
    for (const p of pay) {
      while (ri < rec.length && rec[ri].dateUtc <= p.dateUtc) {
        if (rec[ri].status === "expected") { skipped.push(`${rec[ri].id}: expected, not yet confirmed, so not relied on`); ri++; continue; }
        wallet += toMinor(rec[ri].amount, c); ri++;
      }
      const need = toMinor(p.amount, c), use = wallet >= need ? need : wallet;
      wallet -= use; matched += use;
      if (need - use > 0n) bought += need - use;
      steps.push(`${p.id}: ${fmt(use, c)} from wallet${need - use > 0n ? `, buy ${fmt(need - use, c)}` : ""}`);
    }
    for (; ri < rec.length; ri++) if (rec[ri].status !== "expected") wallet += toMinor(rec[ri].amount, c);
    let costC = 0n;
    if (bought > 0n) { const x = fxCostVsMid(h.homeCcy, c, fmt(bought, c).split(" ")[0], "RECIPIENT_FIXED", h.nowUtc); costC += x.costHomeMinor ?? 0n; planVol += toHome(bought, c); }
    const sold = h.holdSurplus ? 0n : wallet;
    if (sold > 0n) { const x = fxCostVsMid(c, h.homeCcy, fmt(sold, c).split(" ")[0], "SOURCE_FIXED", h.nowUtc); costC += x.costHomeMinor ?? 0n; planVol += toHome(sold, c); }
    planCost += costC;
    perCcy.push({ ccy: c, matchedWithoutFx: fmt(matched, c), bought: fmt(bought, c), soldToHome: fmt(sold, c), keptInWallet: fmt(h.holdSurplus ? wallet : 0n, c), steps });
  }
  return { homeCcy: h.homeCcy, advisoryOnly: true, provenance: "synthetic", perCurrency: perCcy, skipped,
    fxVolume: { baseline: fmt(baseVol, h.homeCcy), withWallets: fmt(planVol, h.homeCcy) },
    fxCost: { baseline: fmt(baseCost, h.homeCcy), withWallets: fmt(planCost, h.homeCcy), saving: fmt(baseCost - planCost, h.homeCcy) },
    notes: ["FX cost = what the route pays above the mid-rate value, from the same optimizer", "only confirmed receivables fund payables; dates respected"] };
}
