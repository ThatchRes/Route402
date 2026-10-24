// npm run calls            -> every paid agent call: buyer record vs seller record
// npm run calls -- --chain  -> also verify each transaction on Base Sepolia (exact USDC transfer to the receiver)
import type { Hex } from "viem";
import { formatUnits } from "viem";
import { loadCalls, WALLET_CALLS, SELLER_CALLS, PROVIDER_CALLS } from "./store.js";
import { verifyTransfer } from "./chain.js";
import { USDC_DECIMALS } from "./config.js";

const wallet = loadCalls(WALLET_CALLS), seller = [...loadCalls(SELLER_CALLS), ...loadCalls(PROVIDER_CALLS)];
const chain = process.argv.includes("--chain");
const bySellerTx = new Map(seller.filter((c) => c.transaction).map((c) => [c.transaction!, c]));
let total = 0n, matched = 0, issues = 0;
for (const c of wallet) {
  let status = c.status === "SETTLED" ? (c.transaction && bySellerTx.has(c.transaction) ? "MATCHED" : "SELLER_RECORD_MISSING") : c.status;
  if (chain && c.transaction && status !== "REJECTED") {
    try {
      const v = await verifyTransfer(c.transaction as Hex, { payTo: c.payTo!, amountAtomic: BigInt(c.amountAtomic), payer: c.payer });
      if (!v.ok) status = `CHAIN_MISMATCH (${v.reason})`;
      else if (status === "SELLER_RECORD_MISSING") status = "MATCHED_ON_CHAIN (seller record missing)";
    } catch (e: any) { status += " (chain unreachable)"; }
  }
  if (["SETTLED", "UNKNOWN", "SUBMITTED"].includes(c.status)) total += BigInt(c.amountAtomic);
  status.startsWith("MATCHED") ? matched++ : c.status !== "REJECTED" && issues++;
  console.log(`${c.at.slice(0, 19)}  ${c.service.padEnd(18)} ${formatUnits(BigInt(c.amountAtomic), USDC_DECIMALS)} USDC  ${status.padEnd(24)} ${c.transaction ?? c.detail ?? ""}  ${c.correlationId ?? ""}`);
}
const orphan = seller.filter((s) => s.transaction && !wallet.some((w) => w.transaction === s.transaction));
for (const s of orphan) console.log(`${s.at.slice(0, 19)}  ${s.service.padEnd(18)} seller-only record ${s.transaction}`);
console.log(`\n${wallet.length} paid calls, ${matched} matched, ${issues} need attention, ${orphan.length} seller-only; spent ${formatUnits(total, USDC_DECIMALS)} test USDC`);
