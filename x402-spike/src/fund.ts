// One command for the whole x402 funding leg: create order -> validated pay -> wait for on-chain confirmation.
// Usage: npm run fund -- <transferId> [planVersion] [termsHash]
// Last line printed is machine-readable:  FUNDED <orderId> <tx>   |   NOT_FUNDED <orderId> <reason>
import { spawnSync } from "node:child_process";
import { SELLER_URL, INTERNAL_TOKEN } from "./config.js";
import { auditOrder } from "./audit.js";

const [transferId, planVersion = "1", termsHash = `terms_${transferId}`] = process.argv.slice(2);
if (!transferId) { console.error("usage: npm run fund -- <transferId>"); process.exit(1); }
const orderId = `fund_${transferId}_v${planVersion}`;
const run = (file: string, ...args: string[]) =>
  spawnSync("npx", ["tsx", file, ...args], { stdio: "inherit", shell: process.platform === "win32" });

const H = { "content-type": "application/json", authorization: `Bearer ${INTERNAL_TOKEN()}` };
const r = await fetch(`${SELLER_URL}/orders`, { method: "POST", headers: H,
  body: JSON.stringify({ orderId, transferId, planVersion: Number(planVersion), termsHash }) });
if (r.status >= 300 && r.status !== 200) { console.log(`NOT_FUNDED ${orderId} order ${r.status} ${await r.text()}`); process.exit(1); }
const order = await r.json();
if (order.status === "AWAITING_FUNDING") run("src/buyer.ts", orderId);

let reconciled = 0;
for (let i = 0; i < 40; i++) {                       // up to ~2 minutes for confirmations
  run("src/confirm.ts");
  const a = await auditOrder(orderId);
  if (a?.outcome === "MATCHED") { console.log(`FUNDED ${orderId} ${a.legs.find((l) => l.leg === "chain_transfer")?.evidenceRef}`); process.exit(0); }
  // The seller and buyer write the same store; a lost buyer write leaves a settled attempt at SUBMITTED.
  // Resolve it from chain evidence (read-only, never pays again) before calling the outcome unknown.
  if (a?.outcome === "UNKNOWN_NEEDS_RECONCILE" && reconciled < 3) {
    reconciled++; run("src/reconcile.ts"); await new Promise((res) => setTimeout(res, 3000)); continue;
  }
  if (a && ["MISMATCH", "FAILED", "UNKNOWN_NEEDS_RECONCILE", "AWAITING_FUNDING"].includes(a.outcome) && i > 0) {
    console.log(`NOT_FUNDED ${orderId} ${a.outcome}`); process.exit(1);
  }
  await new Promise((res) => setTimeout(res, 3000));
}
console.log(`NOT_FUNDED ${orderId} confirmation timeout`); process.exit(1);
