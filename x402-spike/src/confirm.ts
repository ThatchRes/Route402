// Confirmation worker: SETTLED_PENDING_CONFIRMATION -> FUNDING_CONFIRMED only after the chain shows
// a successful USDC Transfer to the approved receiver for the exact amount, with enough confirmations.
// Usage: npm run confirm            (one pass)   |   npm run confirm -- --watch
import type { Hex } from "viem";
import { REQUIRED_CONFIRMATIONS, EXPLORER } from "./config.js";
import { load, update } from "./store.js";
import { verifyTransfer } from "./chain.js";

/** Adopt settlement evidence the buyer recorded if the seller's record missed it (crash, file race). */
function adoptBuyerEvidence() {
  update((db) => {
    for (const a of db.attempts) {
      if (!a.transaction || !["SETTLED", "RECONCILED_SETTLED"].includes(a.status)) continue;
      const o = db.orders[a.orderId];
      if (!o || !["AWAITING_FUNDING", "SETTLEMENT_UNKNOWN"].includes(o.status)) continue;
      const tx = a.transaction.toLowerCase();
      if (db.txIndex[tx] && db.txIndex[tx] !== o.orderId) continue;   // one tx can never fund two orders
      db.txIndex[tx] = o.orderId;
      o.status = "SETTLED_PENDING_CONFIRMATION";                         // still verified on-chain below
      o.settlement = { transaction: tx, payer: a.payer, network: o.network, recordedAt: new Date().toISOString() };
      console.log(`${o.orderId}: adopted buyer settlement ${tx}`);
    }
  });
}

async function pass() {
  adoptBuyerEvidence();
  const pending = Object.values(load().orders).filter((o) => o.status === "SETTLED_PENDING_CONFIRMATION");
  for (const o of pending) {
    const tx = o.settlement!.transaction as Hex;
    try {
      const v = await verifyTransfer(tx, { payTo: o.payTo, amountAtomic: BigInt(o.amountAtomic), payer: o.settlement?.payer });
      update((db) => {
        const cur = db.orders[o.orderId];
        if (!v.ok) { cur.status = "FUNDING_FAILED"; cur.failureReason = v.reason; return; }
        cur.confirmations = v.confirmations.toString();
        if (v.confirmations >= REQUIRED_CONFIRMATIONS) cur.status = "FUNDING_CONFIRMED";
      });
      console.log(`${o.orderId}: ${v.ok ? `${v.confirmations} confirmations` : v.reason} ${EXPLORER}${tx}`);
    } catch (e) {
      console.log(`${o.orderId}: receipt not available yet (${String(e).slice(0, 80)})`);   // stays pending
    }
  }
  return pending.length;
}

if (process.argv.includes("--watch")) { for (;;) { await pass(); await new Promise((r) => setTimeout(r, 5000)); } }
else { const n = await pass(); if (!n) console.log("nothing pending"); }
