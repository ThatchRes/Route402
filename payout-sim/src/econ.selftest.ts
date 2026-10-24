// Self-test for the economics math (synthetic inputs, test only). npm run econ:test
import { allInCost, dailyVol, fxRisk, timeValueUsd } from "./company/economics.js";
const eq = (a: number, b: number, tol = 1e-9) => { if (Math.abs(a - b) > tol) throw new Error(`${a} != ${b}`); };
eq(timeValueUsd(365_000, 10, 1), 100);                                     // 365k at 10% for 1 day = 100
const c = allInCost({ youPayUsd: 100_045, atMidUsd: 100_000, amountUsd: 100_000, costOfCashPct: 6, days: 2 });
eq(c.pricedUsd, 45); eq(c.sendingEarlyUsd, 100_000 * 0.06 * 2 / 365);
// alternating +1%/-1% log moves: daily vol ~1%
const h: [string, number][] = []; let r = 1;
for (let i = 0; i < 61; i++) { h.push([`d${i}`, r]); r *= Math.exp(i % 2 ? -0.01 : 0.01); }
const v = dailyVol(h)!; if (Math.abs(v - 0.01) > 0.0005) throw new Error(`vol ${v}`);
const [x] = fxRisk([{ ccy: "EUR", amountUsd: 1_000_000, dueUtc: new Date(Date.now() + 7 * 864e5).toISOString() }], { EUR: h }, Date.now(), 25_000);
eq(x.riskUsd!, 1_000_000 * 1.645 * v * Math.sqrt(5), 1e-6);
if (dailyVol(h.slice(0, 10)) !== null) throw new Error("short history should be null");
console.log(`economics self-test passed (EUR 1M, 7 days, 1% daily vol -> 95% move ${(x.movePct!).toFixed(2)}%, ${Math.round(x.riskUsd!).toLocaleString()} USD)`);
