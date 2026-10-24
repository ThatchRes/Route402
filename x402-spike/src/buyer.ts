// Paying side (backend only). Usage: npm run pay -- <orderId>
// Order: reconcile-check -> cap check -> validate 402 terms -> persist attempt -> sign & pay -> record evidence.
import { randomUUID } from "node:crypto";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { NETWORK, USDC, PER_PAYMENT_USDC, PER_PAYMENT_ATOMIC, TOTAL_CAP_ATOMIC, SELLER_URL, INTERNAL_TOKEN, PAY_TO, EXPLORER } from "./config.js";
import { checkRequirements, canStartAttempt, withinCap } from "./policy.js";
import { load, update } from "./store.js";
import { client as chain } from "./chain.js";

const orderId = process.argv[2];
if (!orderId) { console.error("usage: npm run pay -- <orderId>"); process.exit(1); }

// 1. The approved order (funding intent) comes from our own backend, not from the seller's 402 text.
const orderRes = await fetch(`${SELLER_URL}/orders/${orderId}`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN()}` } });
if (!orderRes.ok) { console.error("order not found:", await orderRes.text()); process.exit(1); }
const order = await orderRes.json();
if (order.status !== "AWAITING_FUNDING") { console.error(`order is ${order.status}; not paying`); process.exit(1); }

// 2. Never create a new authorization while a previous outcome is unknown; enforce cumulative cap.
const db = load();
const gate = canStartAttempt(db.attempts, orderId);
if (!gate.ok) { console.error(gate.reason); process.exit(1); }
if (!withinCap(db.attempts, PER_PAYMENT_ATOMIC, TOTAL_CAP_ATOMIC)) { console.error("cumulative spend cap reached"); process.exit(1); }

// 3. Preflight: read the 402 and validate network, token contract, exact amount, receiver, lifetime.
const url = `${SELLER_URL}/fund?orderId=${encodeURIComponent(orderId)}`;
const pre = await fetch(url);
if (pre.status !== 402) { console.error(`expected 402, got ${pre.status}: ${await pre.text()}`); process.exit(1); }
const header = pre.headers.get("payment-required");
const required = header ? decodePaymentRequiredHeader(header) : await pre.json();
const check = checkRequirements(required.accepts, {
  network: NETWORK, asset: USDC, amountAtomic: BigInt(order.amountAtomic), payTo: PAY_TO(), maxTimeoutSeconds: 300,
});
if (!check.ok) { console.error("REFUSED before signing:\n - " + check.errors.join("\n - ")); process.exit(1); }

// 4. Persist the attempt BEFORE signing, so a crash leaves an UNKNOWN to reconcile, not a silent retry.
const x402 = new CdpX402Client({
  environment: "development",
  spendControls: {                                   // second, SDK-level guard on top of checkRequirements()
    maxAmountPerPayment: { atomic: PER_PAYMENT_ATOMIC, asset: USDC },
    maxCumulativeSpend: { atomic: TOTAL_CAP_ATOMIC, asset: USDC },
    allowedNetworks: [NETWORK],
    allowedAssets: [USDC],
    allowedPayees: [PAY_TO()],
  },
});
const { evmAddress } = await x402.getAddresses();
const attemptId = randomUUID();
const startBlock = (await chain.getBlockNumber()).toString();
update((d) => { d.attempts.push({ attemptId, orderId, payer: evmAddress, amountAtomic: order.amountAtomic,
  status: "SUBMITTED", startedAt: new Date().toISOString(), startBlock }); });

const setAttempt = (patch: Record<string, unknown>) =>
  update((d) => { Object.assign(d.attempts.find((a) => a.attemptId === attemptId)!, patch); });

// 5. Sign and pay (the SDK handles the 402 -> signed retry).
try {
  const pay = wrapFetchWithPayment(globalThis.fetch, x402 as any); // same @x402/core at runtime; ESM/CJS typings differ
  const res = await pay(url, { signal: AbortSignal.timeout(90_000) });
  const raw = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  const settle = raw ? decodePaymentResponseHeader(raw) : undefined;
  if (res.ok && settle?.success && settle.transaction) {
    setAttempt({ status: "SETTLED", transaction: settle.transaction.toLowerCase() });
    console.log(`HTTP ${res.status} settled`);
    console.log(`payer   ${evmAddress}`);
    console.log(`amount  ${PER_PAYMENT_USDC} test USDC on Base Sepolia (testnet evidence, separate from the scenario amount)`);
    console.log(`tx      ${settle.transaction}`);
    console.log(`explorer ${EXPLORER}${settle.transaction}`);
    console.log("next: npm run confirm");
  } else if (res.status === 402 || (settle && !settle.success)) {
    setAttempt({ status: "REJECTED", detail: settle?.errorReason ?? `HTTP ${res.status}` });
    console.error("payment rejected:", settle?.errorReason ?? (await res.text()));
  } else {
    setAttempt({ status: "UNKNOWN", detail: `HTTP ${res.status} without settlement evidence` });
    console.error(`HTTP ${res.status} without settlement evidence -> run npm run reconcile`);
  }
} catch (e) {
  setAttempt({ status: "UNKNOWN", detail: String(e).slice(0, 300) });
  console.error("outcome UNKNOWN (timeout or crash). Do NOT pay again. Run: npm run reconcile");
}
