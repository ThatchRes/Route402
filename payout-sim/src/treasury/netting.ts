// Multilateral intercompany netting (treasury-centre model). Advisory: nothing moves until approved.
// Gross: every intercompany invoice is settled on its own (one payment, and one FX trade when currencies differ).
// Net:   each entity settles ONE net amount with the netting centre in its own functional currency;
//        the centre converts only the net position per currency. Every FX leg is priced by the same optimizer.
import { optimize, mid } from "../router/optimizer.js";
import { convert, fmt, toMinor } from "../money.js";

export interface Entity { id: string; functionalCcy: string }
export interface Invoice { id: string; from: string; to: string; ccy: string; amount: string }   // `from` pays `to`
export interface NettingInput { centreCcy: string; entities: Entity[]; invoices: Invoice[]; nowUtc?: string }

function fxCost(src: string, dest: string, destAmountMinor: bigint, nowUtc?: string) {
  // cost of delivering `destAmount` of dest when paying in src: debit at best route minus mid value
  if (src === dest || destAmountMinor === 0n) return { debit: convert(destAmountMinor, dest, src, "1").minor, costMinor: 0n, route: "none (same currency)" };
  const amt = fmt(destAmountMinor, dest).split(" ")[0];
  const r: any = optimize({ srcCcy: src, destCcy: dest, amountType: "RECIPIENT_FIXED", amount: amt, objective: "cheapest", nowUtc });
  if (r.status !== "OK") return { debit: null, costMinor: null, route: r.missing?.join("; ") ?? r.reason };
  const debit = toMinor(r.totals.sourceDebit.split(" ")[0], src);
  const atMid = convert(destAmountMinor, dest, src, mid(dest, src)).minor;
  return { debit, costMinor: debit - atMid, route: r.allocations.map((a: any) => a.routeId).join("+") };
}

export function runNetting(n: NettingInput) {
  const ent = new Map(n.entities.map((e) => [e.id, e]));
  const toCentre = (amt: string, ccy: string) => convert(toMinor(amt, ccy), ccy, n.centreCcy, mid(ccy, n.centreCcy)).minor;

  // ---------- gross settlement
  let grossCost = 0n, grossFxNotional = 0n, grossFxTrades = 0;
  const gross = n.invoices.map((inv) => {
    const payer = ent.get(inv.from)!;
    const c = fxCost(payer.functionalCcy, inv.ccy, toMinor(inv.amount, inv.ccy), n.nowUtc);
    const costCentre = c.costMinor === null ? 0n : convert(c.costMinor, payer.functionalCcy, n.centreCcy, mid(payer.functionalCcy, n.centreCcy)).minor;
    if (payer.functionalCcy !== inv.ccy) { grossFxTrades++; grossFxNotional += toCentre(inv.amount, inv.ccy); }
    grossCost += costCentre;
    return { invoice: inv.id, payer: inv.from, payee: inv.to, amount: `${inv.amount} ${inv.ccy}`, route: c.route, fxCost: fmt(costCentre, n.centreCcy) };
  });

  // ---------- multilateral net position per entity (in centre currency)
  const pos = new Map<string, bigint>(n.entities.map((e) => [e.id, 0n]));
  for (const inv of n.invoices) {
    const v = toCentre(inv.amount, inv.ccy);
    pos.set(inv.from, pos.get(inv.from)! - v); pos.set(inv.to, pos.get(inv.to)! + v);
  }
  let netCost = 0n, netFxNotional = 0n, netFxTrades = 0;
  const settlements = [...pos.entries()].filter(([, v]) => v !== 0n).map(([id, v]) => {
    const e = ent.get(id)!, abs = v < 0n ? -v : v;
    // entity pays (v<0) or receives (v>0) its net in its functional currency; centre converts the net only
    const local = convert(abs, n.centreCcy, e.functionalCcy, mid(n.centreCcy, e.functionalCcy)).minor;
    let cost = 0n, route = "none (centre currency)";
    if (e.functionalCcy !== n.centreCcy) {
      netFxTrades++; netFxNotional += abs;
      const c = v < 0n ? fxCost(e.functionalCcy, n.centreCcy, abs, n.nowUtc) : fxCost(n.centreCcy, e.functionalCcy, local, n.nowUtc);
      const srcCcy = v < 0n ? e.functionalCcy : n.centreCcy;
      cost = c.costMinor === null ? 0n : convert(c.costMinor, srcCcy, n.centreCcy, mid(srcCcy, n.centreCcy)).minor; route = c.route;
    }
    netCost += cost;
    return { entity: id, direction: v < 0n ? "pays centre" : "receives from centre", amount: fmt(local, e.functionalCcy),
             centreValue: fmt(abs, n.centreCcy), route, fxCost: fmt(cost, n.centreCcy) };
  });
  const sumCheck = [...pos.values()].reduce((s, v) => s + v, 0n);   // must be 0: every invoice is one entity's payable and another's receivable
  const pct = (a: bigint, b: bigint) => (b === 0n ? "0%" : `${(Number(((b - a) * 10000n) / b) / 100).toFixed(1)}%`);
  return {
    advisoryOnly: true, provenance: "synthetic", centreCcy: n.centreCcy, balanced: sumCheck === 0n,
    gross: { payments: n.invoices.length, fxTrades: grossFxTrades, fxNotional: fmt(grossFxNotional, n.centreCcy), fxCost: fmt(grossCost, n.centreCcy), detail: gross },
    net: { payments: settlements.length, fxTrades: netFxTrades, fxNotional: fmt(netFxNotional, n.centreCcy), fxCost: fmt(netCost, n.centreCcy), settlements },
    savings: { payments: `${n.invoices.length - settlements.length} fewer (${pct(BigInt(settlements.length), BigInt(n.invoices.length))})`,
               fxNotional: pct(netFxNotional, grossFxNotional), fxCost: fmt(grossCost - netCost, n.centreCcy) },
    notes: ["netting only between entities of the same group under an intercompany netting agreement",
            "FX legs priced with the route optimizer (synthetic rates); positions valued at mid"],
  };
}
