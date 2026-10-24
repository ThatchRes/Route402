// Shared: print a payment run, and execute its converted payments through the router.
import "dotenv/config";
import type { CompanyProfile } from "./profile.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Remembers which bills were already executed, so re-running a payment run never pays the same bill twice.
const PAID = "data/executed.json";
const loadPaid = (): Record<string, any> => (existsSync(PAID) ? JSON.parse(readFileSync(PAID, "utf8")) : {});
const savePaid = (m: Record<string, any>) => { mkdirSync("data", { recursive: true }); writeFileSync(PAID, JSON.stringify(m, null, 2)); };

export function printRun(r: any) {
  console.log(`${r.company} payment run  (baseline: ${r.baseline})\n`);
  for (const l of r.lines) console.log(l.status ? `  ${l.payable.padEnd(18)} ${l.status}: ${l.why}`
    : `  ${l.payable.padEnd(18)} pay ${l.payOnUtc}  ${l.amount.padEnd(18)} wallet ${l.fromWallet.padEnd(18)} convert ${l.converted.padEnd(18)} ${l.route}${l.note ? `  [${l.note.trim()}]` : ""}`);
  for (const e of r.expectedOnly) console.log(`  note: ${e}`);
  console.log(`\n  FX volume        your bank ${r.fxVolume.withYourBank}   ->  with us ${r.fxVolume.withUs}`);
  console.log(`  cost above mid   your bank ${r.costVsMid.withYourBank}   ->  routing only ${r.costVsMid.routingOnly}   ->  routing + wallets ${r.costVsMid.routingPlusWallets}`);
  console.log(`\n  savings this run:`);
  for (const [k, v] of Object.entries(r.savings)) console.log(`    ${k.padEnd(24)} ${v}`);
  console.log(`\n  our fee ${r.ourFee}  |  company keeps ${r.companyKeeps}\n  ${r.multiEntity}`);
}

export async function executeRun(r: any, company: CompanyProfile, onDone?: (line: any, transfer: any) => Promise<void>) {
  const BASE = `http://localhost:${process.env.ROUTER_PORT ?? 8404}`;
  const H = { authorization: `Bearer ${process.env.ROUTER_TOKEN ?? "dev-token"}`, "content-type": "application/json" };
  const call = async (m: string, p: string, b?: any, x: Record<string, string> = {}) => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { ...H, ...x }, body: b ? JSON.stringify(b) : undefined }); return res.json(); };
  const bank = company.currentBank;
  console.log("\n  executing converted payments (needs: npm run server, npm run router, x402 seller)");
  const paid = loadPaid(), retry = process.argv.includes("--retry-failed");
  for (const l of r.lines.filter((x: any) => x.convertedAmount && Number(x.convertedAmount) > 0 && x.ccy !== r.homeCcy)) {
    const key = `${company.companyId}:${l.payable}`, prev = paid[key];
    if (prev && ["COMPLETED", "EXECUTING"].includes(prev.status)) { console.log(`    ${l.payable.padEnd(18)} already ${prev.status.toLowerCase()} as ${prev.transferId}: skipped (no double payment)`); continue; }
    if (prev && !retry) { console.log(`    ${l.payable.padEnd(18)} previous attempt ${prev.transferId} is ${prev.status}: resolve it, then re-run with --retry-failed`); continue; }
    const it = await call("POST", "/v1/intents", { srcCcy: r.homeCcy, destCcy: l.ccy, amountType: "RECIPIENT_FIXED", amount: l.convertedAmount,
      deadlineUtc: l.deadlineUtc, objective: "balanced", currentBank: { label: bank.label, fxMarkupBps: bank.fxMarkupBps, wireFeeUsd: bank.wireFeeUsd, businessDays: bank.businessDays } });
    if (!it.intentId) { console.log(`    ${l.payable}: ${JSON.stringify(it).slice(0, 160)}`); continue; }
    const t = await call("POST", "/v1/transfers", { intentId: it.intentId }, { "idempotency-key": `run_${l.payable}_${it.intentId}` });
    await call("POST", `/v1/transfers/${t.transferId}/approvals`, { planVersion: t.planVersion, termsHash: t.termsHash, approver: "company-treasurer" });
    await call("POST", `/v1/transfers/${t.transferId}/execute`, { planVersion: t.planVersion, termsHash: t.termsHash }, { "idempotency-key": `exec_${t.transferId}` });
    let st: any; for (let i = 0; i < 120; i++) { st = await call("GET", `/v1/transfers/${t.transferId}`); if (!["EXECUTING", "APPROVED"].includes(st.status)) break; await new Promise((z) => setTimeout(z, 2000)); }
    const live = Object.values<any>(st.steps).some((s: any) => String(s.rail ?? "").startsWith("x402"));
    paid[key] = { transferId: t.transferId, status: st.status, at: new Date().toISOString() }; savePaid(paid);
    console.log(`    ${l.payable.padEnd(18)} ${t.transferId}  ${st.status}  debit ${st.terms.totals.sourceDebit}${live ? "  (includes a real x402 testnet leg)" : ""}`);
    if (st.status !== "COMPLETED") for (const [k, v] of Object.entries<any>(st.steps)) if (v.status !== "CONFIRMED") console.log(`      ${k}: ${v.status}${v.detail ? ` - ${String(v.detail).slice(0, 160)}` : ""}`);
    if (onDone && st.status === "COMPLETED") await onDone(l, st);
  }
  console.log("    wallet-funded payments: paid from the company's currency balance (no FX; simulated domestic payout)");
}
