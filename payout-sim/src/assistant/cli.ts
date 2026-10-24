// npm run ask -- "pay my German suppliers this week" [--execute] [--direct] [--policy cheapest|fastest|lowest_risk]
// npm run ask -- examples
// Default path goes through the Fetch.ai agents: concierge -> calculator preview -> routing agent buys quotes and
// compliance agent buys supplier screens with x402 -> approve/hold per payment. --execute sends only approved payments.
// --direct skips the agents (local calculator only; nothing is paid for, nothing is reviewed).
import "dotenv/config";
import { ask, TEMPLATES } from "./prompts.js";
import { loadLinked } from "./linked.js";
import { printRun, executeRun } from "../company/runner.js";
import { askAgents, printAgents, policyFlag } from "./agents.js";

const pf = policyFlag();
const text = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== pf).join(" ");
const l = loadLinked();
const execute = process.argv.includes("--execute"), direct = process.argv.includes("--direct");
if (!text || text === "examples") { console.log(`linked data: ${l.source}\n\ntry:`); TEMPLATES.forEach((t) => console.log(`  npm run ask -- "${t.example}"`)); process.exit(0); }

let r: any, agents: any = null;
if (direct) r = ask(text, l);
else {
  try { agents = await askAgents(text, pf); }
  catch (e: any) { console.error(`  ${e.message}`); process.exit(1); }
  if (agents.status === "error") { console.error(`  agents: ${agents.error}`); process.exit(1); }
  r = agents.preview ?? { template: agents.template, clarification: agents.clarification, blocked: agents.status === "blocked" ? [agents.clarification] : undefined, beneficiary: agents.title };
}
console.log(`> ${text}\n  template: ${r.template ?? "none"}   data: ${r.source ?? l.source}   path: ${direct ? "direct (no agents)" : "Fetch.ai agents"}\n`);
if (r.clarification) { console.log(`  ? ${r.clarification}`); process.exit(0); }
if (r.blocked) { console.log(`  BLOCKED (${r.beneficiary}): ${r.blocked.join("; ")}`); process.exit(0); }
console.log(`  ${r.title}\n`);

if (r.template === "pay_bills") {
  printRun(r.preview);
  if (agents) printAgents(agents);
  if (execute) await executeRun(r.preview, l.input.company, undefined, agents?.decisions);
  else console.log(`\n  ${r.nextStep}`);
} else if (r.template === "send_to") {
  console.log(JSON.stringify(r.preview, null, 2));
  if (agents) printAgents(agents);
  if (execute) {
    const it = r.intent;
    const line = { payable: agents?.decisions?.[0]?.payable ?? `send:${r.beneficiary?.name}`, ccy: it.destCcy, convertedAmount: it.amount, deadlineUtc: it.deadlineUtc };
    await executeRun({ homeCcy: it.srcCcy, lines: [line] }, l.input.company, undefined, agents?.decisions);
  } else console.log(`\n  ${r.nextStep}`);
} else { const { template, source, title, company, ...rest } = r; console.log(JSON.stringify(rest, null, 2)); }
