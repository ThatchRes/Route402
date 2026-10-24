// npm run ask -- "pay my German suppliers this week" [--execute]
// npm run ask -- examples
import "dotenv/config";
import { ask, TEMPLATES } from "./prompts.js";
import { loadLinked } from "./linked.js";
import { printRun, executeRun } from "../company/runner.js";
const text = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ");
const l = loadLinked();
if (!text || text === "examples") { console.log(`linked data: ${l.source}\n\ntry:`); TEMPLATES.forEach((t) => console.log(`  npm run ask -- "${t.example}"`)); process.exit(0); }
const r: any = ask(text, l);
console.log(`> ${text}\n  template: ${r.template ?? "none"}   data: ${r.source ?? l.source}\n`);
if (r.clarification) { console.log(`  ? ${r.clarification}`); process.exit(0); }
if (r.blocked) { console.log(`  BLOCKED (${r.beneficiary}): ${r.blocked.join("; ")}`); process.exit(0); }
console.log(`  ${r.title}\n`);
if (r.template === "pay_bills") { printRun(r.preview); if (process.argv.includes("--execute")) await executeRun(r.preview, l.input.company); else console.log(`\n  ${r.nextStep}`); }
else if (r.template === "send_to" && process.argv.includes("--execute")) {
  const BASE = `http://localhost:${process.env.ROUTER_PORT ?? 8404}`, H = { authorization: `Bearer ${process.env.ROUTER_TOKEN ?? "dev-token"}`, "content-type": "application/json" };
  const call = async (m: string, p: string, b?: any) => (await fetch(`${BASE}${p}`, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })).json();
  console.log(JSON.stringify(r.preview, null, 2));
  const it = await call("POST", "/v1/intents", { ...r.intent, objective: "balanced", currentBank: l.input.company.currentBank });
  const t = await call("POST", "/v1/transfers", { intentId: it.intentId });
  await call("POST", `/v1/transfers/${t.transferId}/approvals`, { planVersion: t.planVersion, termsHash: t.termsHash, approver: "company-treasurer" });
  await call("POST", `/v1/transfers/${t.transferId}/execute`, { planVersion: t.planVersion, termsHash: t.termsHash });
  let st: any; for (let i = 0; i < 120; i++) { st = await call("GET", `/v1/transfers/${t.transferId}`); if (!["EXECUTING", "APPROVED"].includes(st.status)) break; await new Promise((z) => setTimeout(z, 2000)); }
  console.log(`\n  ${t.transferId}: ${st.status}`);
} else { const { template, source, title, ...rest } = r; console.log(JSON.stringify(rest, null, 2)); }
