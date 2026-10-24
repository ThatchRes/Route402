// x402 reconciliation for one funding order: approved terms vs seller record vs buyer record vs the chain.
// Read-only. Outcomes: MATCHED | PENDING_CONFIRMATION | AWAITING_FUNDING | MISMATCH | UNKNOWN_NEEDS_RECONCILE | FAILED
import type { Hex } from "viem";
import { NETWORK, USDC, PER_PAYMENT_ATOMIC, REQUIRED_CONFIRMATIONS, EXPLORER } from "./config.js";
import { load } from "./store.js";
import { verifyTransfer } from "./chain.js";

export async function auditOrder(orderId: string) {
  const db = load();
  const o = db.orders[orderId];
  if (!o) return null;
  const attempts = db.attempts.filter((a) => a.orderId === orderId);
  const settled = attempts.filter((a) => a.transaction && ["SETTLED", "RECONCILED_SETTLED"].includes(a.status));
  const sellerTx = o.settlement?.transaction?.toLowerCase();
  const buyerTx = settled[0]?.transaction?.toLowerCase();
  const legs: any[] = [];

  const termsOk = o.network === NETWORK && o.asset.toLowerCase() === USDC.toLowerCase() && BigInt(o.amountAtomic) === PER_PAYMENT_ATOMIC;
  legs.push({ leg: "order_terms", expected: `${NETWORK} USDC ${PER_PAYMENT_ATOMIC}`, observed: `${o.network} ${o.asset === USDC ? "USDC" : o.asset} ${o.amountAtomic}`,
              status: termsOk ? "MATCHED" : "MISMATCH" });
  legs.push({ leg: "single_settlement", expected: "at most one settled attempt", observed: `${settled.length} settled attempt(s)`,
              status: settled.length <= 1 ? "MATCHED" : "MISMATCH" });
  legs.push({ leg: "seller_vs_buyer", expected: sellerTx ?? "(none yet)", observed: buyerTx ?? "(none yet)",
              status: !sellerTx && !buyerTx ? "PENDING" : sellerTx && buyerTx && sellerTx !== buyerTx ? "MISMATCH" : "MATCHED" });

  const tx = (sellerTx ?? buyerTx) as Hex | undefined;
  let chain: any = { leg: "chain_transfer", expected: `${PER_PAYMENT_ATOMIC} USDC units to ${o.payTo}`, observed: null, status: "PENDING" };
  if (tx) {
    try {
      const v = await verifyTransfer(tx, { payTo: o.payTo, amountAtomic: BigInt(o.amountAtomic), payer: o.settlement?.payer ?? settled[0]?.payer });
      chain = v.ok
        ? { ...chain, observed: `${o.amountAtomic} USDC units to ${o.payTo}`, confirmations: Number(v.confirmations),
            requiredConfirmations: Number(REQUIRED_CONFIRMATIONS), status: v.confirmations >= REQUIRED_CONFIRMATIONS ? "MATCHED" : "PENDING_CONFIRMATION",
            evidenceRef: tx, explorer: `${EXPLORER}${tx}` }
        : { ...chain, observed: v.reason, status: "MISMATCH", evidenceRef: tx };
    } catch (e) { chain = { ...chain, observed: `chain unreachable: ${String(e).split("\n")[0].slice(0, 60)}`, status: "PENDING", evidenceRef: tx }; }
  }
  legs.push(chain);

  const unknown = attempts.some((a) => ["SUBMITTED", "UNKNOWN"].includes(a.status));
  const outcome = legs.some((l) => l.status === "MISMATCH") ? "MISMATCH"
    : o.status === "FUNDING_FAILED" ? "FAILED"
    : unknown ? "UNKNOWN_NEEDS_RECONCILE"
    : !tx ? "AWAITING_FUNDING"
    : chain.status === "MATCHED" && o.status === "FUNDING_CONFIRMED" ? "MATCHED"
    : "PENDING_CONFIRMATION";
  return { orderId, transferId: o.transferId, orderStatus: o.status, outcome, legs, provenance: "testnet",
           ledger: tx ? [{ asset: "USDC(testnet)", account: "wallet:buyer", amountAtomic: `-${o.amountAtomic}` },
                         { asset: "USDC(testnet)", account: "wallet:payout-provider", amountAtomic: o.amountAtomic }] : [] };
}
