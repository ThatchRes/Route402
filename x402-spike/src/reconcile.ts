// Resolve UNKNOWN attempts from chain evidence before any new authorization is allowed.
// Usage: npm run reconcile
import type { Hex } from "viem";
import { getAddress } from "viem";
import { USDC } from "./config.js";
import { load, update } from "./store.js";
import { client, TRANSFER, verifyTransfer } from "./chain.js";

const db = load();
const unknown = db.attempts.filter((a) => a.status === "UNKNOWN" || a.status === "SUBMITTED");
if (!unknown.length) console.log("no unknown attempts");

for (const a of unknown) {
  const order = db.orders[a.orderId];
  let txFound: string | undefined;
  // Known hash first: the attempt's own, else the one the seller recorded for this order (seller write won, buyer write lost).
  const known = a.transaction ?? order.settlement?.transaction;
  if (known) {
    const v = await verifyTransfer(known as Hex, { payTo: order.payTo, amountAtomic: BigInt(a.amountAtomic), payer: a.payer });
    if (v.ok) txFound = known.toLowerCase();
  }
  if (!txFound && !a.transaction) {
    // Search USDC transfers payer -> receiver for the exact amount since the attempt started.
    const from = BigInt(a.startBlock ?? "0");
    const head = await client.getBlockNumber();
    const logs = await client.getLogs({ address: USDC, event: TRANSFER, fromBlock: from, toBlock: head,
      args: { from: getAddress(a.payer), to: getAddress(order.payTo) } });
    // Exclude transactions that back OTHER orders; this order's own settlement is still a valid match.
    const used = new Set(Object.entries(load().txIndex).filter(([, id]) => id !== a.orderId).map(([h]) => h.toLowerCase()));
    const hits = logs.filter((l) => l.args.value === BigInt(a.amountAtomic) && !used.has(l.transactionHash!.toLowerCase()));
    if (hits.length > 1) { console.log(`${a.attemptId}: ${hits.length} candidate transfers -> operator review`); continue; }
    txFound = hits[0]?.transactionHash?.toLowerCase();
  }
  update((d) => {
    const at = d.attempts.find((x) => x.attemptId === a.attemptId)!;
    const o = d.orders[a.orderId];
    if (txFound) {
      at.status = "RECONCILED_SETTLED"; at.transaction = txFound;
      d.txIndex[txFound] = a.orderId;
      if (o.status === "AWAITING_FUNDING" || o.status === "SETTLEMENT_UNKNOWN") {
        o.status = "SETTLED_PENDING_CONFIRMATION";
        o.settlement = { transaction: txFound, payer: a.payer, network: o.network, recordedAt: new Date().toISOString() };
      }
    } else {
      at.status = "RECONCILED_NOT_SETTLED";        // only now may a new attempt be created
      if (o.status === "SETTLEMENT_UNKNOWN") o.status = "AWAITING_FUNDING";
    }
  });
  console.log(`${a.attemptId}: ${txFound ? `settled in ${txFound} (run npm run confirm)` : "no transfer found; a new attempt is allowed"}`);
}