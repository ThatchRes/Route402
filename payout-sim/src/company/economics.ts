// Economic models for supplier payments. Each uses only inputs we have: quotes, mid rates, the company's own cost of
// cash, due dates, and ECB rate history. Nothing here assumes a failure rate or a price we cannot source.
//
// 1. All-in cost of a route = (what you pay - the invoice valued at mid-market) + the cost of sending early.
//    Cost of sending early: a route that takes d calendar days must leave d days before the due date, so the company
//    gives up d days of its cash: amount x cost of cash x d / 365. A 24/7 rail can leave on the due date itself.
// 2. Send-by date: the latest moment to send on a route and still arrive by the due date.
// 3. FX risk on open bills: for each foreign currency still to be bought, a 95% one-sided move over the days left to
//    the due date, from the daily volatility of ECB reference rates (log returns). It sizes risk; it is not a forecast.

const DAY = 86_400_000;

export function transitDays(sendAtMs: number, arrivalUtc: string) {
  return Math.max(0, (Date.parse(arrivalUtc) - sendAtMs) / DAY);
}

export function timeValueUsd(amountUsd: number, costOfCashPct: number, days: number) {
  return amountUsd * (costOfCashPct / 100) * (days / 365);
}

export function allInCost(o: { youPayUsd: number; atMidUsd: number; amountUsd: number; costOfCashPct: number; days: number }) {
  const priced = o.youPayUsd - o.atMidUsd, early = timeValueUsd(o.amountUsd, o.costOfCashPct, o.days);
  return { pricedUsd: priced, sendingEarlyUsd: early, allInUsd: priced + early };
}

export function sendBy(dueUtc: string, days: number) {
  return new Date(Date.parse(dueUtc) - days * DAY).toISOString();
}

/** Daily log-return volatility from [date, rate] pairs (rate = units per USD). null when history is too short. */
export function dailyVol(history: [string, number][] | undefined) {
  if (!history || history.length < 30) return null;
  const rs: number[] = [];
  for (let i = 1; i < history.length; i++) rs.push(Math.log(history[i][1] / history[i - 1][1]));
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  return Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1));
}

const Z95 = 1.645;   // one-sided 95% normal quantile

export function fxRisk(exposures: { ccy: string; amountUsd: number; dueUtc: string }[], history: Record<string, [string, number][]>, nowMs: number, limitUsd: number) {
  const byCcy = new Map<string, { amountUsd: number; days: number }>();
  for (const e of exposures) {
    const days = Math.max(1, (Date.parse(e.dueUtc) - nowMs) / DAY), cur = byCcy.get(e.ccy) ?? { amountUsd: 0, days: 0 };
    // weight the horizon by amount so one number per currency stays meaningful
    byCcy.set(e.ccy, { amountUsd: cur.amountUsd + e.amountUsd, days: (cur.days * cur.amountUsd + days * e.amountUsd) / (cur.amountUsd + e.amountUsd) });
  }
  return [...byCcy.entries()].map(([ccy, x]) => {
    const vol = dailyVol(history[ccy]), tradingDays = x.days * 5 / 7;
    if (vol === null) return { ccy, exposureUsd: x.amountUsd, days: Math.round(x.days), status: "no-history" as const,
      note: "rate history unavailable (offline or currency not published by the ECB): risk not computed" };
    const move = Z95 * vol * Math.sqrt(tradingDays), riskUsd = x.amountUsd * move;
    return { ccy, exposureUsd: x.amountUsd, days: Math.round(x.days), dailyVolPct: vol * 100, movePct: move * 100, riskUsd,
      status: riskUsd > limitUsd ? "over-limit" as const : "ok" as const, points: history[ccy].length };
  });
}
