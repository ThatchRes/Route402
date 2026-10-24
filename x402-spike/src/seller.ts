// Receiving side: one protected funding resource per immutable order (blueprint sec 6).
// paymentFlow "upfront" = the CDP facilitator settles on-chain BEFORE our handler runs.
// The handler still never starts a payout: it only records settlement; confirm.ts checks the chain.
import express from "express";
import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { NETWORK, USDC, PER_PAYMENT_USDC, PER_PAYMENT_ATOMIC, PAY_TO, INTERNAL_TOKEN } from "./config.js";
import { load, update, type Order } from "./store.js";
import { auditOrder } from "./audit.js";

const app = express();
app.use(express.json());
const ID = /^[A-Za-z0-9_\-:.]{1,80}$/;
const inFlight = new Set<string>();

function internal(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.header("authorization") !== `Bearer ${INTERNAL_TOKEN()}`) return res.status(401).json({ error: "unauthorized" });
  next();
}

// ---- Internal API for Person A's backend: create the order BEFORE any funds are requested ----
app.post("/orders", internal, (req, res) => {
  const { orderId, transferId, planVersion, termsHash, ttlSeconds = 900 } = req.body ?? {};
  if (![orderId, transferId].every((v) => typeof v === "string" && ID.test(v)) || !Number.isInteger(planVersion)
      || typeof termsHash !== "string" || !termsHash) return res.status(400).json({ error: "invalid order" });
  const result = update((db) => {
    const existing = db.orders[orderId];
    if (existing) {
      const same = existing.transferId === transferId && existing.planVersion === planVersion && existing.termsHash === termsHash;
      return same ? { code: 200, order: existing } : { code: 409, order: null };   // idempotent, never mutated
    }
    const order: Order = {
      orderId, transferId, planVersion, termsHash, network: NETWORK, asset: USDC, payTo: PAY_TO(),
      amountAtomic: PER_PAYMENT_ATOMIC.toString(), status: "AWAITING_FUNDING",
      expiresAt: new Date(Date.now() + Math.min(ttlSeconds, 3600) * 1000).toISOString(),
      createdAt: new Date().toISOString(), provenance: "testnet",
    };
    db.orders[orderId] = order;
    return { code: 201, order };
  });
  if (!result.order) return res.status(409).json({ error: "orderId reused with different terms" });
  res.status(result.code).json(result.order);
});

app.get("/orders/:orderId/reconciliation", internal, async (req, res) => {
  const r = await auditOrder(String(req.params.orderId));
  return r ? res.json(r) : res.status(404).json({ error: "not found" });
});

app.get("/orders/:orderId", internal, (req, res) => {
  const o = load().orders[String(req.params.orderId)];
  return o ? res.json(o) : res.status(404).json({ error: "not found" });
});

// ---- Guard runs BEFORE the x402 middleware: never ask for money for a missing/funded/expired order ----
app.use("/fund", (req, res, next) => {
  const orderId = String(req.query.orderId ?? "");
  if (!ID.test(orderId)) return res.status(400).json({ error: "orderId required" });
  const o = load().orders[orderId];
  if (!o) return res.status(404).json({ error: "unknown order" });
  if (o.status !== "AWAITING_FUNDING") return res.status(409).json({ error: `order is ${o.status}`, status: o.status });
  if (Date.parse(o.expiresAt) < Date.now()) {
    update((db) => { db.orders[orderId].status = "EXPIRED"; });
    return res.status(410).json({ error: "order expired; create a new order and approval" });
  }
  const paying = Boolean(req.header("payment-signature") || req.header("x-payment"));
  if (paying) {
    if (inFlight.has(orderId)) return res.status(409).json({ error: "payment already in flight for this order" });
    inFlight.add(orderId);
    res.on("close", () => inFlight.delete(orderId));
  }
  next();
});

const server = await createX402Server({
  environment: "development",                          // Base Sepolia only; mainnet is not configurable here
  payToConfig: { type: "address", evm: PAY_TO() as `0x${string}` },
  routes: {
    "GET /fund": {
      price: `$${PER_PAYMENT_USDC}`,
      networks: [NETWORK],
      paymentFlow: "upfront",
      maxTimeoutSeconds: 120,
      description: "Fund one approved transfer order (test USDC)",
    },
  },
});
app.use(paymentMiddlewareFromHTTPServer(server as any)); // same @x402/core at runtime; ESM/CJS typings differ

app.get("/fund", (req, res) => {
  const orderId = String(req.query.orderId);
  // Record what the facilitator reported once the response (with its PAYMENT-RESPONSE header) is sent.
  res.on("finish", () => {
    const raw = res.getHeader("payment-response") ?? res.getHeader("x-payment-response");
    update((db) => {
      const o = db.orders[orderId];
      if (!o || o.status !== "AWAITING_FUNDING") return;
      if (!raw) { o.status = "SETTLEMENT_UNKNOWN"; o.failureReason = "no settlement header recorded"; return; }
      const s = decodePaymentResponseHeader(String(raw));
      const tx = s.transaction?.toLowerCase();
      if (!s.success || !tx) { o.status = "FUNDING_FAILED"; o.failureReason = s.errorReason ?? "settlement failed"; return; }
      if (db.txIndex[tx] && db.txIndex[tx] !== orderId) { o.status = "FUNDING_FAILED"; o.failureReason = "tx already used by another order"; return; }
      db.txIndex[tx] = orderId;
      o.status = "SETTLED_PENDING_CONFIRMATION";       // NOT final: confirm.ts verifies the chain transfer
      o.settlement = { transaction: tx, payer: s.payer, network: s.network, recordedAt: new Date().toISOString() };
    });
  });
  // No payout here. Person A's worker starts the payout only after FUNDING_CONFIRMED.
  res.json({ orderId, accepted: true, next: "awaiting on-chain confirmation" });
});

app.listen(8402, () => console.log(`x402 seller on :8402, receiving at ${server.payToEvmAddress} (Base Sepolia, test USDC only)`));
