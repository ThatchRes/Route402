// Advisory queue optimizer (guide A9 / blueprint sec 4). Compares a joint plan against routing each payment
// independently, with identical inputs. Never moves money. No look-ahead: only CONFIRMED inflows count, and only
// once they have arrived before a payment's dispatch time; forecasts are shown but never spent.
import { optimize, mid } from "./optimizer.js";
import { convert, fmt, toMinor } from "../money.js";

export interface QueuePayment { id: string; destCcy: string; amount: string; deadlineUtc: string; pool: string }
export interface Inflow { id: string; ccy: string; amount: string; arrivalUtc: string; pool: string; status: "confirmed" | "forecast" }
export interface QueueInput {
  queueId: string; nowUtc?: string; srcCcy: string; payments: QueuePayment[];
  balances: { pool: string; ccy: string; amount: string }[]; inflows: Inflow[];
  domesticPayoutFeeUsd?: number;    // paying a same-currency obligation from an existing balance
}

const H = 3600e3;
export function planQueue(q: QueueInput) {
  const now = q.nowUtc ? new Date(q.nowUtc) : new Date();
  const fee = q.domesticPayoutFeeUsd ?? 1.5;
  const usdMinor = (amt: bigint, ccy: string) => convert(amt, ccy, q.srcCcy, mid(ccy, q.srcCcy)).minor;
  const feeMinor = toMinor(fee.toFixed(2), q.srcCcy);
  const sorted = [...q.payments].sort((a, b) => a.deadlineUtc.localeCompare(b.deadlineUtc));

  // ---------- baseline: each payment routed independently NOW, all funded externally up front
  const base = sorted.map((p) => {
    const r: any = optimize({ srcCcy: q.srcCcy, destCcy: p.destCcy, amountType: "RECIPIENT_FIXED", amount: p.amount, deadlineUtc: p.deadlineUtc, nowUtc: now.toISOString(), objective: "cheapest" });
    return { p, debit: r.status === "OK" ? toMinor(r.totals.sourceDebit.split(" ")[0], q.srcCcy) : null, route: r.allocations?.map((a: any) => a.routeId).join("+") };
  });
  const baseTotal = base.reduce((s, b) => s + (b.debit ?? 0n), 0n);
  const baseOnTime = base.filter((b) => b.debit !== null).length;

  // ---------- joint plan
  const bal = new Map(q.balances.map((b) => [`${b.pool}/${b.ccy}`, toMinor(b.amount, b.ccy)]));
  const usedInflows = new Set<string>(), notes: string[] = [], blocked: string[] = [];
  const steps: any[] = [];
  const remaining: { p: QueuePayment; need: bigint; dispatch: Date }[] = [];
  let ownFundsValue = 0n;                                                  // own balances used, valued at mid (not free)
  for (const p of sorted) {
    const deadline = new Date(p.deadlineUtc);
    const latestDispatch = new Date(deadline.getTime() - 2 * H);        // keep a 2h buffer for the domestic payout
    // confirmed inflows in the SAME pool that arrive before we must dispatch
    for (const f of q.inflows) {
      if (usedInflows.has(f.id) || f.ccy !== p.destCcy) continue;
      if (f.pool !== p.pool) { if (!blocked.includes(f.id)) blocked.push(f.id); continue; }
      if (f.status !== "confirmed") continue;                              // forecasts never authorize spending
      if (new Date(f.arrivalUtc) > latestDispatch) { notes.push(`${p.id}: inflow ${f.id} arrives ${f.arrivalUtc}, too late to use`); continue; }
      bal.set(`${f.pool}/${f.ccy}`, (bal.get(`${f.pool}/${f.ccy}`) ?? 0n) + toMinor(f.amount, f.ccy)); usedInflows.add(f.id);
      notes.push(`${p.id}: waits for confirmed inflow ${f.id} (${f.amount} ${f.ccy}) arriving ${f.arrivalUtc}`);
    }
    const key = `${p.pool}/${p.destCcy}`, need = toMinor(p.amount, p.destCcy), have = bal.get(key) ?? 0n;
    const fromBal = have >= need ? need : have;
    if (fromBal > 0n) {
      bal.set(key, have - fromBal);
      ownFundsValue += usdMinor(fromBal, p.destCcy);
      steps.push({ payment: p.id, action: "pay from existing balance (no FX)", amount: fmt(fromBal, p.destCcy), costUsd: fmt(feeMinor, q.srcCcy) });
    }
    if (need - fromBal > 0n) remaining.push({ p, need: need - fromBal, dispatch: latestDispatch < now ? now : latestDispatch });
  }

  // batch the FX remainder per destination currency (bigger tier, fixed fees once), if every deadline still holds
  let fxCost = 0n, extFunding: { at: Date; amt: bigint }[] = [];
  const byCcy = new Map<string, typeof remaining>();
  for (const r of remaining) byCcy.set(r.p.destCcy, [...(byCcy.get(r.p.destCcy) ?? []), r]);
  for (const [ccy, group] of byCcy) {
    const total = group.reduce((s, g) => s + g.need, 0n);
    const earliest = group.map((g) => g.p.deadlineUtc).sort()[0];
    const batch: any = optimize({ srcCcy: q.srcCcy, destCcy: ccy, amountType: "RECIPIENT_FIXED", amount: fmt(total, ccy).split(" ")[0], deadlineUtc: earliest, nowUtc: now.toISOString(), objective: "cheapest" });
    const singles = group.map((g) => ({ g, r: optimize({ srcCcy: q.srcCcy, destCcy: ccy, amountType: "RECIPIENT_FIXED", amount: fmt(g.need, ccy).split(" ")[0], deadlineUtc: g.p.deadlineUtc, nowUtc: now.toISOString(), objective: "cheapest" }) as any }));
    const singleCost = singles.reduce((s, x) => s + (x.r.status === "OK" ? toMinor(x.r.totals.sourceDebit.split(" ")[0], q.srcCcy) : 0n), 0n);
    const batchCost = batch.status === "OK" ? toMinor(batch.totals.sourceDebit.split(" ")[0], q.srcCcy) + feeMinor * BigInt(group.length) : null;
    if (batchCost !== null && group.length > 1 && batchCost < singleCost) {
      fxCost += batchCost;
      const at = group.map((g) => g.dispatch).sort((a, b) => +a - +b)[0];
      extFunding.push({ at, amt: batchCost });
      steps.push({ payment: group.map((g) => g.p.id).join("+"), action: `batch one ${q.srcCcy}->${ccy} conversion via ${batch.allocations.map((a: any) => a.routeId).join("+")}, then domestic payouts`,
                   amount: fmt(total, ccy), costUsd: fmt(batchCost, q.srcCcy), dispatchUtc: at.toISOString() });
    } else {
      for (const x of singles) {
        if (x.r.status !== "OK") { steps.push({ payment: x.g.p.id, action: "HOLD: no eligible route", amount: fmt(x.g.need, ccy) }); continue; }
        const c = toMinor(x.r.totals.sourceDebit.split(" ")[0], q.srcCcy); fxCost += c; extFunding.push({ at: x.g.dispatch, amt: c });
        steps.push({ payment: x.g.p.id, action: `convert via ${x.r.allocations.map((a: any) => a.routeId).join("+")}`, amount: fmt(x.g.need, ccy), costUsd: fmt(c, q.srcCcy), dispatchUtc: x.g.dispatch.toISOString() });
      }
    }
  }
  const balanceCost = steps.filter((s) => s.action.startsWith("pay from existing")).length;
  const planTotal = fxCost + feeMinor * BigInt(balanceCost);
  const peakPlan = extFunding.reduce((m, f) => (f.amt > m ? f.amt : m), 0n);          // just-in-time funding per dispatch
  const fxVolumeBase = base.reduce((s, b) => s + (b.debit ?? 0n), 0n), fxVolumePlan = fxCost;
  const forecastShown = q.inflows.filter((f) => f.status === "forecast").map((f) => `${f.id}: ${f.amount} ${f.ccy} (forecast, not spendable)`);

  return {
    queueId: q.queueId, status: steps.some((s) => s.action.startsWith("HOLD")) ? "partial_hold" : "ok", proposalId: `qp_${Date.now().toString(36)}`,
    advisoryOnly: true, provenance: "synthetic",
    baseline: "each payment routed independently at its cheapest eligible route, funded externally up front",
    steps, notes, blockedPools: blocked.map((id) => `${id}: different ownership pool, not usable`), forecastShown,
    metrics: {
      // economic cost counts own balances used at their mid-rate value, so netting is not shown as "free money"
      economicCost: { plan: fmt(planTotal + ownFundsValue, q.srcCcy), baseline: fmt(baseTotal, q.srcCcy) },
      netCostDelta: fmt(planTotal + ownFundsValue - baseTotal, q.srcCcy),
      externalFunding: { plan: fmt(planTotal, q.srcCcy), baseline: fmt(baseTotal, q.srcCcy) },
      peakPrefunding: { plan: fmt(peakPlan, q.srcCcy), baseline: fmt(baseTotal, q.srcCcy) },
      fxVolume: { plan: fmt(fxVolumePlan, q.srcCcy), baseline: fmt(fxVolumeBase, q.srcCcy) },
      ownBalancesUsed: fmt(ownFundsValue, q.srcCcy),
      onTime: { plan: `${sorted.length - steps.filter((s) => s.action.startsWith("HOLD")).length}/${sorted.length}`, baseline: `${baseOnTime}/${sorted.length}` },
    },
    assumptions: ["no look-ahead: inflows count only if confirmed and arrived before dispatch", "2h payout buffer before each deadline",
                  `domestic payout from balance costs ${fee} ${q.srcCcy}`, "synthetic rates and fees"],
  };
}
