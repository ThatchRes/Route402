// Three independent quote providers, each its own x402 seller with its OWN receiving wallet (port 8411-8413).
// The routing agent pays each one 0.001 test USDC per quote and then chooses between them.
// Usage: npm run providers     (needs the router running: quotes are priced by its optimizer, per provider)
import express from "express";
import { randomUUID } from "node:crypto";
import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { NETWORK, CALL_PRICE_USDC, CALL_PRICE_ATOMIC, ROUTER_URL, ROUTER_TOKEN } from "./config.js";
import { updateCalls, PROVIDER_CALLS } from "./store.js";
import { PROVIDERS, providerAddresses } from "./providerConfig.js";

const CCY = /^[A-Z]{3}$/, AMT = /^\d+(\.\d+)?$/;
const addrs = await providerAddresses();
const routerUp = async () => { try { return (await fetch(`${ROUTER_URL}/v1/market`, { headers: { authorization: `Bearer ${ROUTER_TOKEN()}` }, signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } };

for (const p of PROVIDERS) {
  const app = express();
  app.use(express.json());
  app.get("/v1/info", (_req, res) => res.json({ provider: p.id, label: p.label, payTo: addrs[p.id], priceUsdc: CALL_PRICE_USDC, network: "Base Sepolia" }));
  // Guard BEFORE x402: a malformed request, or a request while the pricing engine is down, is never charged
  app.use("/v1/quote", async (req, res, next) => {
    const b = req.body ?? {};
    if (req.method !== "POST" || !CCY.test(b.srcCcy ?? "") || !CCY.test(b.destCcy ?? "") || !AMT.test(String(b.amount ?? ""))
        || !["SOURCE_FIXED", "RECIPIENT_FIXED"].includes(b.amountType)) return res.status(400).json({ error: "srcCcy, destCcy, amount, amountType required" });
    if (!(await routerUp())) return res.status(503).json({ error: "pricing engine unavailable: not charging" });
    next();
  });
  const server = await createX402Server({
    environment: "development",
    payToConfig: { type: "address", evm: addrs[p.id] as `0x${string}` },
    routes: { "POST /v1/quote": { price: `$${CALL_PRICE_USDC}`, networks: [NETWORK], paymentFlow: "upfront", maxTimeoutSeconds: 120,
      description: `${p.label}: priced quote for one cross-border payment` } },
  });
  app.use(paymentMiddlewareFromHTTPServer(server as any));
  app.post("/v1/quote", async (req, res) => {
    res.on("finish", () => {
      const raw = res.getHeader("payment-response") ?? res.getHeader("x-payment-response");
      if (!raw) return;
      const s = decodePaymentResponseHeader(String(raw));
      updateCalls(PROVIDER_CALLS, (c) => { c.push({ callId: randomUUID(), service: `quote:${p.id}`, amountAtomic: CALL_PRICE_ATOMIC.toString(),
        status: s.success && s.transaction ? "SETTLED" : "REJECTED", transaction: s.transaction?.toLowerCase(), payer: s.payer, payTo: addrs[p.id],
        correlationId: req.header("x-correlation-id") ?? undefined, at: new Date().toISOString(), detail: s.errorReason }); });
    });
    try {
      const r = await fetch(`${ROUTER_URL}/v1/provider-quote`, { method: "POST", signal: AbortSignal.timeout(15000),
        headers: { "content-type": "application/json", authorization: `Bearer ${ROUTER_TOKEN()}` }, body: JSON.stringify({ ...req.body, provider: p.id }) });
      res.json({ ...(await r.json()), providerLabel: p.label, payTo: addrs[p.id] });
    } catch (e: any) { res.json({ provider: p.id, status: "NO_QUOTE", reason: String(e).slice(0, 200) }); }
  });
  app.listen(p.port, () => console.log(`${p.label.padEnd(26)} :${p.port}  receives at ${addrs[p.id]}  (${CALL_PRICE_USDC} test USDC per quote)`));
}
