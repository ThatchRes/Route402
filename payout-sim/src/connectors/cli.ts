// How a company ports its data in:
//   npm run import -- nessie seed [--fresh]               create the demo company in your Nessie sandbox (once; --fresh = new one)
//   npm run import -- nessie link [--customer ID]          link the company's bank data (then use: npm run ask)
//   npm run import -- nessie run [--customer ID] [--execute] [--writeback]
//   npm run import -- csv link <file.csv>                 link an accounting export (then use: npm run ask)
//   npm run import -- csv run <file.csv> [--execute]      e.g. samples/acme-ap-ar.csv (accounting-system export)
//   npm run import -- csv template                        print the CSV header + example rows
import "dotenv/config";
import { readFileSync } from "node:fs";
import { seedDemo, importFromNessie, writeBack } from "./nessieImport.js";
import { importCsv } from "./csv.js";
import { loadMeta } from "./nessie.js";
import { runPaymentRun } from "../company/paymentRun.js";
import { printRun, executeRun } from "../company/runner.js";
import { DEMO_COMPANY } from "../company/profile.js";
import { saveLinked } from "../assistant/linked.js";

const [src, cmd, arg] = process.argv.slice(2);
const flag = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const NOW = process.env.DEMO_NOW_UTC ?? "2026-10-26T14:00:00Z";

if (src === "nessie" && cmd === "seed") {
  const r = await seedDemo(process.argv.includes("--fresh"));
  console.log(r.created ? `created demo company in Nessie: customer ${r.customerId}` : `demo company already in Nessie: customer ${r.customerId}`);
  console.log(`next: npm run import -- nessie run --customer ${r.customerId}`);
} else if (src === "nessie" && (cmd === "run" || cmd === "link")) {
  const meta = loadMeta();
  const customerId = flag("customer") ?? Object.keys(meta).find((k) => k.startsWith("customer:"))?.split(":")[1];
  if (!customerId) { console.error("no customer: run `npm run import -- nessie seed` first or pass --customer ID"); process.exit(1); }
  const imp = await importFromNessie(customerId, DEMO_COMPANY, NOW);
  console.log(`imported from Nessie customer ${customerId}: ${imp.imported.accounts} accounts (USD available ${imp.usdAvailable}), ${imp.imported.payables} bills, ${imp.imported.receivables} deposits`);
  for (const u of imp.unmapped) console.log(`  note: ${u}`);
  saveLinked({ source: `Nessie customer ${customerId}`, linkedAt: new Date().toISOString(), usdAvailable: imp.usdAvailable, input: imp.input });
  console.log(`  linked: prompts now use this data (npm run ask -- examples)`);
  if (cmd === "link") process.exit(0);
  console.log("");
  const r = runPaymentRun(imp.input); printRun(r);
  if (process.argv.includes("--execute")) {
    const opAcct = meta[`customer:${customerId}`]?.operatingAccountId;
    await executeRun(r, imp.input.company, process.argv.includes("--writeback") && opAcct ? async (l, st) => {
      await writeBack(opAcct, st.terms.totals.sourceDebit.split(" ")[0], st.transferId);
      console.log(`      recorded USD debit in Nessie account ${opAcct}`);
    } : undefined);
  }
} else if (src === "csv" && (cmd === "run" || cmd === "link")) {
  if (!arg) { console.error("usage: npm run import -- csv run <file.csv>"); process.exit(1); }
  const imp = importCsv(readFileSync(arg, "utf8"), DEMO_COMPANY, NOW);
  console.log(`imported from ${arg}: ${imp.imported.payables} payables, ${imp.imported.receivables} receivables`);
  for (const p of imp.problems) console.log(`  skipped: ${p}`);
  saveLinked({ source: `CSV ${arg}`, linkedAt: new Date().toISOString(), input: imp.input });
  console.log(`  linked: prompts now use this data (npm run ask -- examples)`);
  if (cmd === "link") process.exit(0);
  console.log("");
  const r = runPaymentRun(imp.input); printRun(r);
  if (process.argv.includes("--execute")) await executeRun(r, imp.input.company);
} else if (src === "csv" && cmd === "template") {
  console.log(readFileSync("samples/template.csv", "utf8"));
} else console.log("usage: npm run import -- nessie seed | nessie run [--customer ID] [--execute] [--writeback] | csv run <file> [--execute] | csv template");
