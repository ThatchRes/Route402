// npm run company -- hedge | discounts | validate | report
import { runHedge } from "./hedge.js";
import { runDiscounts } from "./discounts.js";
import { validate } from "./validate.js";
import { runNetting } from "../treasury/netting.js";
import { runSweeps } from "../treasury/sweeps.js";
import { DEMO_BENEFICIARIES, DEMO_DISCOUNTS, DEMO_HEDGE, DEMO_RUN } from "./demo.js";
import { runPaymentRun } from "./paymentRun.js";
import "dotenv/config";
import { printRun, executeRun } from "./runner.js";
import { DEMO_NETTING, DEMO_SWEEPS } from "../treasury/demo.js";
import { planningNow } from "../router/timing.js";
const cmd = process.argv[2];
const hedge = () => runHedge(DEMO_HEDGE), disc = () => runDiscounts(DEMO_DISCOUNTS);
if (cmd === "run" || cmd === "report") {
  const r = runPaymentRun({ ...DEMO_RUN, nowUtc: planningNow() });
  printRun(r);
  if (process.argv.includes("--execute")) await executeRun(r, DEMO_RUN.company);
} else if (cmd === "hedge") {
  const r = hedge();
  for (const c of r.perCurrency) console.log(`  ${c.ccy}: matched ${c.matchedWithoutFx} with no FX | buy ${c.bought} | sell leftover ${c.soldToHome}`);
  for (const s of r.skipped) console.log(`  note: ${s}`);
  console.log(`\n  FX volume  baseline ${r.fxVolume.baseline}  ->  with wallets ${r.fxVolume.withWallets}`);
  console.log(`  FX cost    baseline ${r.fxCost.baseline}  ->  with wallets ${r.fxCost.withWallets}   saving ${r.fxCost.saving}`);
} else if (cmd === "discounts") {
  const r = disc();
  for (const d of r.decisions) console.log(`  ${d.invoice.padEnd(24)} ${d.decision.padEnd(26)} ${d.annualizedReturn ? `${d.annualizedReturn}/yr, net gain ${d.netGainAfterCashCost}` : d.reason}`);
  console.log(`\n  net gain from discounts this cycle: ${r.netGain} (cost of cash ${r.costOfCashPct}%)`);
} else if (cmd === "validate") {
  for (const b of DEMO_BENEFICIARIES) { const v = validate(b); console.log(`  ${v.status.padEnd(7)} ${v.beneficiary.padEnd(28)} ${[...v.errors, ...v.warnings].join("; ")}`); }
} else if (cmd === "levers") {
  const h = hedge(), d = disc(), n = runNetting(DEMO_NETTING), s = runSweeps(DEMO_SWEEPS);
  const v = DEMO_BENEFICIARIES.map(validate), blocked = v.filter((x) => x.status === "BLOCK").length;
  console.log("COMPANY SAVINGS REPORT (synthetic demo data, advisory)\n");
  console.log(`  1. Route optimizer (per payment)        see: npm run route -- quote ...   (~0.45-0.5% kept per payment after fee in tests)`);
  console.log(`  2. Wallets + natural hedge              FX cost ${h.fxCost.baseline} -> ${h.fxCost.withWallets}  (saves ${h.fxCost.saving}); FX volume ${h.fxVolume.baseline} -> ${h.fxVolume.withWallets}`);
  console.log(`  3. Intercompany netting (per cycle)     FX notional -${n.savings.fxNotional}, FX cost saves ${n.savings.fxCost}, ${n.savings.payments} payments`);
  console.log(`  4. Cash pooling (per year)              ${s.pools.map((p: any) => `${p.pool} +${p.interestPerYear.improvement}`).join(", ")}`);
  console.log(`  5. Early-payment discounts (this cycle) net gain ${d.netGain}`);
  console.log(`  6. Beneficiary validation               ${blocked} of ${v.length} payments blocked before sending (each return typically costs fees + a second FX conversion + days)`);
} else console.log("usage: npm run company -- run | hedge | discounts | validate | levers");
