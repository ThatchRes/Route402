// npm run treasury -- netting | sweeps | rules        (demo multinational group, synthetic data, advisory only)
import { runNetting } from "./netting.js";
import { runSweeps } from "./sweeps.js";
import { evaluate } from "./rules.js";
import { DEMO_NETTING, DEMO_RULES, DEMO_STATE, DEMO_SWEEPS } from "./demo.js";
const cmd = process.argv[2];
if (cmd === "netting") {
  const r = runNetting(DEMO_NETTING);
  console.log(`positions balance to zero: ${r.balanced}\n`);
  console.log(`                gross (invoice by invoice)      net (multilateral)`);
  console.log(`payments        ${String(r.gross.payments).padEnd(32)}${r.net.payments}`);
  console.log(`FX trades       ${String(r.gross.fxTrades).padEnd(32)}${r.net.fxTrades}`);
  console.log(`FX notional     ${r.gross.fxNotional.padEnd(32)}${r.net.fxNotional}`);
  console.log(`FX cost         ${r.gross.fxCost.padEnd(32)}${r.net.fxCost}`);
  console.log(`\nsavings: ${r.savings.payments} payments, FX notional -${r.savings.fxNotional}, FX cost ${r.savings.fxCost}\n`);
  for (const s of r.net.settlements) console.log(`  ${s.entity.padEnd(8)} ${s.direction.padEnd(22)} ${s.amount.padEnd(20)} via ${s.route}`);
} else if (cmd === "sweeps") {
  const r = runSweeps(DEMO_SWEEPS);
  for (const p of r.pools) {
    console.log(`\n${p.pool} (header ${p.header}, after sweeps ${p.headerBalanceAfter})`);
    for (const s of p.proposedSweeps) console.log(`  sweep ${s.amount} ${s.from} -> ${s.to}`);
    console.log(`  interest per year: without pooling ${p.interestPerYear.withoutPooling} | with pooling ${p.interestPerYear.withPooling} | improvement ${p.interestPerYear.improvement}`);
  }
} else if (cmd === "rules") {
  const r = evaluate(DEMO_RULES, DEMO_STATE);
  for (const p of r.proposals) console.log(`  ${p.rule.padEnd(22)} ${(p.status ?? "").padEnd(32)} ${p.action}${p.amount ? `  [${p.amount}]` : ""}${p.saves ? `  saves ${p.saves}` : ""}${p.missing ? `  missing: ${p.missing.join(",")}` : ""}`);
} else console.log("usage: npm run treasury -- netting | sweeps | rules");
