// Receiving side: one protected funding resource per immutable order (blueprint sec 6).
// paymentFlow "upfront" = the CDP facilitator settles on-chain BEFORE our handler runs.
// The handler still never starts a payout: it only records settlement; confirm.ts checks the chain.
import express from "express";
import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { randomUUID } from "node:crypto";
import { NETWORK, USDC, PER_PAYMENT_USDC, PER_PAYMENT_ATOMIC, PAY_TO, INTERNAL_TOKEN, CALL_PRICE_USDC, CALL_PRICE_ATOMIC, ROUTER_URL, ROUTER_TOKEN } from "./config.js";
import { load, update, updateCalls, SELLER_CALLS, type Order } from "./store.js";
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

// ---- Paid services: guard runs BEFORE the x402 middleware, so a malformed request is never charged ----
const CCY = /^[A-Z]{3}$/, AMT = /^\d+(\.\d+)?$/;
async function routerUp(): Promise<boolean> {
  try { return (await fetch(`${ROUTER_URL}/v1/market`, { headers: { authorization: `Bearer ${ROUTER_TOKEN()}` }, signal: AbortSignal.timeout(3000) })).ok; }
  catch { return false; }
}
app.use("/v1/quotes", async (req, res, next) => {
  const b = req.body ?? {};
  if (req.method !== "POST" || !CCY.test(b.srcCcy ?? "") || !CCY.test(b.destCcy ?? "") || !AMT.test(String(b.amount ?? ""))
      || !["SOURCE_FIXED", "RECIPIENT_FIXED"].includes(b.amountType)) return res.status(400).json({ error: "srcCcy, destCcy, amount, amountType required" });
  if (!(await routerUp())) return res.status(503).json({ error: "quote engine unavailable: not charging" });
  next();
});
app.use("/v1/compliance/screen", async (req, res, next) => {
  const b = req.body?.beneficiary;
  if (req.method !== "POST" || !b || typeof b.name !== "string" || typeof b.country !== "string") return res.status(400).json({ error: "beneficiary {name, country, ...} required" });
  if (!(await routerUp())) return res.status(503).json({ error: "screening service unavailable: not charging" });
  next();
});
// Record every settled paid call (seller side). The agent wallet keeps its own record; `npm run calls` reconciles both.
function recordCall(service: string, req: express.Request, res: express.Response) {
  res.on("finish", () => {
    const raw = res.getHeader("payment-response") ?? res.getHeader("x-payment-response");
    if (!raw) return;
    const s = decodePaymentResponseHeader(String(raw));
    updateCalls(SELLER_CALLS, (calls) => { calls.push({ callId: randomUUID(), service, amountAtomic: CALL_PRICE_ATOMIC.toString(),
      status: s.success && s.transaction ? "SETTLED" : "REJECTED", transaction: s.transaction?.toLowerCase(), payer: s.payer, payTo: PAY_TO(),
      correlationId: req.header("x-correlation-id") ?? undefined, at: new Date().toISOString(), detail: s.errorReason }); });
  });
}
const routerPost = async (path: string, body: unknown) => {
  const r = await fetch(`${ROUTER_URL}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ROUTER_TOKEN()}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { ok: r.ok, status: r.status, json: await r.json() };
};

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
    "POST /v1/quotes": {
      price: `$${CALL_PRICE_USDC}`, networks: [NETWORK], paymentFlow: "upfront", maxTimeoutSeconds: 120,
      description: "Route quote for one cross-border payment: candidates, recommended plan, cost vs mid, measured bank baseline",
    },
    "POST /v1/compliance/screen": {
      price: `$${CALL_PRICE_USDC}`, networks: [NETWORK], paymentFlow: "upfront", maxTimeoutSeconds: 120,
      description: "Beneficiary pre-send screen: account/IBAN/routing checks for one supplier",
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

app.post("/v1/quotes", async (req, res) => {
  recordCall("quote", req, res);
  const b = req.body;
  try {
    const r = await routerPost("/v1/intents", { srcCcy: b.srcCcy, destCcy: b.destCcy, amountType: b.amountType, amount: String(b.amount),
      deadlineUtc: b.deadlineUtc, objective: b.objective ?? "balanced", currentBank: b.currentBank });
    if (!r.ok) return res.status(200).json({ status: "NO_QUOTE", detail: r.json });
    const d = r.json.decision;
    res.json({ status: d.status, intentId: r.json.intentId, quoteExpiresInSec: 900, reason: d.reason,
      plan: d.status === "OK" ? { kind: d.plan, sourceDebit: d.totals.sourceDebit, recipientNet: d.totals.recipientNet, arrivalUtc: d.totals.arrivalUtc,
        allocations: d.allocations.map((a: any) => ({ routeId: a.routeId, label: a.label, x402Executable: a.x402Executable, amount: a.amount, arrivalUtc: a.arrivalUtc })) } : null,
      costVsMidBps: d.costVsMidBps, baseline: d.baseline ? { routeId: d.baseline.routeId, sourceDebit: d.baseline.sourceDebit, meetsDeadline: d.baseline.meetsDeadline } : null,
      bestX402: d.bestX402, cheapest: d.cheapest, fastest: d.fastest, value: d.value, provenance: d.provenance,
      alternatives: (d.candidates ?? []).filter((c: any) => c.eligible).slice(0, 5) });
  } catch (e: any) { res.status(200).json({ status: "NO_QUOTE", detail: String(e).slice(0, 200) }); }
});

app.post("/v1/compliance/screen", async (req, res) => {
  recordCall("compliance", req, res);
  try {
    const r = await routerPost("/v1/company/beneficiaries/validate", [req.body.beneficiary]);
    const v = Array.isArray(r.json) ? r.json[0] : null;
    if (!v) return res.status(200).json({ status: "REVIEW", checks: [], detail: "validator returned no result" });
    res.json({ status: v.status === "OK" ? "PASS" : v.status, beneficiary: req.body.beneficiary.name, errors: v.errors ?? [], warnings: v.warnings ?? [],
      checks: ["account details present", "IBAN mod-97 / US routing checksum / CLABE check digit / Canadian transit format", "currency matches country"],
      notCovered: ["sanctions screening", "business identity verification"] });
  } catch (e: any) { res.status(200).json({ status: "REVIEW", detail: String(e).slice(0, 200) }); }
});

app.listen(8402, () => console.log(`x402 seller on :8402, receiving at ${server.payToEvmAddress} (Base Sepolia, test USDC only)\n  paid: POST /v1/quotes, POST /v1/compliance/screen at ${CALL_PRICE_USDC} test USDC per call | funding: GET /fund (settlement proof)`));
