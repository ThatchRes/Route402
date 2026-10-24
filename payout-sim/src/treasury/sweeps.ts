// Cash pooling / target-balance sweeps. Advisory: shows proposed sweeps and the annual interest effect.
// Without pooling: idle surplus earns a low credit rate while deficit accounts pay overdraft interest.
// With pooling: per currency, surpluses above target are swept to the header to cover deficits first;
// only the true net position earns/pays at the header rate. Same-currency only (no hidden FX).
import { fmt, toMinor, toMinorSigned } from "../money.js";

export interface Account { id: string; entity: string; bank: string; ccy: string; balance: string; target: string;
  creditRatePct: number; debitRatePct: number; isHeader?: boolean; pool: string }
export interface SweepInput { accounts: Account[]; sweepFeeMinorPerTransfer?: Record<string, string>; days?: number }

const yearly = (minor: bigint, ratePct: number, days: number) => (minor * BigInt(Math.round(ratePct * 10000)) * BigInt(days)) / (1_000_000n * 365n);

export function runSweeps(s: SweepInput) {
  const days = s.days ?? 365, out: any[] = [], byCcy = new Map<string, Account[]>();
  for (const a of s.accounts) byCcy.set(`${a.pool}/${a.ccy}`, [...(byCcy.get(`${a.pool}/${a.ccy}`) ?? []), a]);
  for (const [key, accts] of byCcy) {
    const ccy = key.split("/")[1], header = accts.find((a) => a.isHeader) ?? accts[0];
    const fee = toMinor(s.sweepFeeMinorPerTransfer?.[ccy] ?? "0", ccy);
    let before = 0n, sweeps: any[] = [];
    for (const a of accts) {
      const b = toMinorSigned(a.balance, ccy);
      before += b >= 0n ? yearly(b, a.creditRatePct, days) : -yearly(-b, a.debitRatePct, days);
      if (a === header) continue;
      const diff = b - toMinor(a.target, ccy);                      // >0 sweep up to header, <0 fund from header
      if (diff !== 0n) sweeps.push({ from: diff > 0n ? a.id : header.id, to: diff > 0n ? header.id : a.id, amount: fmt(diff < 0n ? -diff : diff, ccy) });
    }
    const total = accts.reduce((s2, a) => s2 + toMinorSigned(a.balance, ccy), 0n), targets = accts.filter((a) => a !== header).reduce((s2, a) => s2 + toMinor(a.target, ccy), 0n);
    const headerBal = total - targets;
    const afterTargets = accts.filter((a) => a !== header).reduce((s2, a) => { const t = toMinor(a.target, ccy); return s2 + (t >= 0n ? yearly(t, a.creditRatePct, days) : 0n); }, 0n);
    const after = afterTargets + (headerBal >= 0n ? yearly(headerBal, header.creditRatePct, days) : -yearly(-headerBal, header.debitRatePct, days)) - fee * BigInt(sweeps.length) * BigInt(days);
    out.push({ pool: key, header: header.id, proposedSweeps: sweeps, headerBalanceAfter: fmt(headerBal, ccy),
      interestPerYear: { withoutPooling: fmt(before, ccy), withPooling: fmt(after, ccy), improvement: fmt(after - before, ccy) },
      note: sweeps.length ? `daily sweeps assumed; ${fmt(fee, ccy)} per sweep included` : "already at target" });
  }
  return { advisoryOnly: true, provenance: "synthetic", horizonDays: days, pools: out,
    notes: ["physical same-currency sweeps within one ownership pool; cross-currency pooling would need notional pooling or FX (not assumed)",
            "rates are synthetic; real rates come from the bank agreements"] };
}
