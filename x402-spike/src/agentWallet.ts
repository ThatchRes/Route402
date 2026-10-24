// The agents' wallet (port 8405): the only place the routing and compliance agents can spend from.
// An agent asks for ONE paid call to an allow-listed service; this service checks the seller's 402 terms
// (network, token, exact price, receiver), enforces a per-call price and a cumulative cap, pays with x402,
// and returns the service's answer together with the on-chain payment evidence.
// The agents never hold keys. Usage: npm run wallet
import express from "express";
import { randomUUID } from "node:crypto";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { formatUnits } from "viem";
import { NETWORK, USDC, USDC_DECIMALS, SELLER_URL, INTERNAL_TOKEN, PAY_TO, EXPLORER, CALL_PRICE_ATOMIC, CALL_CAP_ATOMIC, WALLET_PORT } from "./config.js";
import { checkRequirements } from "./policy.js";
import { loadCalls, updateCalls, WALLET_CALLS, type CallRecord } from "./store.js";
import { PROVIDERS, providerAddresses, providerUrl } from "./providerConfig.js";

// Allow-list: agents cannot point the wallet anywhere else. Each service has its own expected payee; provider payees
// are derived here from their named CDP accounts, never taken from what the provider says.
const provAddr = await providerAddresses();
const SERVICES: Record<string, { url: string; payTo: string }> = {
  quote: { url: `${SELLER_URL}/v1/quotes`, payTo: PAY_TO() },
  compliance: { url: `${SELLER_URL}/v1/compliance/screen`, payTo: PAY_TO() },
  ...Object.fromEntries(PROVIDERS.map((p) => [`quote:${p.id}`, { url: providerUrl(p.id), payTo: provAddr[p.id] }])),
};
const usdc = (a: bigint) => formatUnits(a, USDC_DECIMALS);
// settled + unknown count toward the cap (an unknown outcome may have moved money)
const spent = () => loadCalls(WALLET_CALLS).filter((c) => ["SUBMITTED", "SETTLED", "UNKNOWN"].includes(c.status))
  .reduce((s, c) => s + BigInt(c.amountAtomic), 0n);

const x402 = new CdpX402Client({
  environment: "development",
  spendControls: {
    maxAmountPerPayment: { atomic: CALL_PRICE_ATOMIC, asset: USDC },
    maxCumulativeSpend: { atomic: CALL_CAP_ATOMIC, asset: USDC },
    allowedNetworks: [NETWORK], allowedAssets: [USDC], allowedPayees: [PAY_TO(), ...Object.values(provAddr)],
  },
});
const { evmAddress } = await x402.getAddresses();
const pay = wrapFetchWithPayment(globalThis.fetch, x402 as any);   // same @x402/core at runtime; ESM/CJS typings differ

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => (req.header("authorization") === `Bearer ${INTERNAL_TOKEN()}` ? next() : res.status(401).json({ error: "unauthorized" })));

app.post("/pay-call", async (req, res) => {
  const { service, body, correlationId, caller } = req.body ?? {};
  const svc = SERVICES[String(service)], url = svc?.url;
  if (!svc) return res.status(400).json({ ok: false, error: `service must be one of ${Object.keys(SERVICES).join(", ")}` });
  if (spent() + CALL_PRICE_ATOMIC > CALL_CAP_ATOMIC)
    return res.status(402).json({ ok: false, error: `agent call budget reached (${usdc(spent())} of ${usdc(CALL_CAP_ATOMIC)} test USDC)` });
  const init = { method: "POST", headers: { "content-type": "application/json", "x-correlation-id": String(correlationId ?? "") }, body: JSON.stringify(body ?? {}) };

  // 1. Preflight: read the seller's terms and refuse anything other than the approved price, token, network and receiver
  const pre = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) }).catch((e) => e as Error);
  if (pre instanceof Error) return res.status(502).json({ ok: false, error: `service unreachable: ${pre.message}` });
  if (pre.status !== 402) return res.status(502).json({ ok: false, error: `expected 402 terms, got ${pre.status}`, detail: (await pre.text()).slice(0, 300) });
  const header = pre.headers.get("payment-required");
  const required = header ? decodePaymentRequiredHeader(header) : await pre.json();
  const check = checkRequirements(required.accepts, { network: NETWORK, asset: USDC, amountAtomic: CALL_PRICE_ATOMIC, payTo: svc.payTo, maxTimeoutSeconds: 300 });
  if (!check.ok) return res.status(409).json({ ok: false, error: "refused before signing", reasons: check.errors });

  // 2. Record the attempt BEFORE signing (a crash leaves an UNKNOWN that counts toward the cap, never a silent retry)
  const callId = randomUUID();
  const rec: CallRecord = { callId, service, amountAtomic: CALL_PRICE_ATOMIC.toString(), status: "SUBMITTED", at: new Date().toISOString(),
    payer: evmAddress, payTo: svc.payTo, correlationId, caller, request: JSON.stringify(body ?? {}).slice(0, 300) };
  updateCalls(WALLET_CALLS, (c) => { c.push(rec); });
  const set = (patch: Partial<CallRecord>) => updateCalls(WALLET_CALLS, (c) => { Object.assign(c.find((x) => x.callId === callId)!, patch); });

  // 3. Pay and call
  try {
    const r = await pay(url, { ...init, signal: AbortSignal.timeout(90000) });
    const raw = r.headers.get("payment-response") ?? r.headers.get("x-payment-response");
    const s = raw ? decodePaymentResponseHeader(raw) : undefined;
    const data = await r.json().catch(() => null);
    if (r.ok && s?.success && s.transaction) {
      const tx = s.transaction.toLowerCase();
      set({ status: "SETTLED", transaction: tx });
      return res.json({ ok: true, data, payment: { callId, service, priceUsdc: usdc(CALL_PRICE_ATOMIC), network: "Base Sepolia (testnet)", payer: evmAddress,
        payTo: svc.payTo, transaction: tx, explorer: `${EXPLORER}${tx}` }, budget: { spentUsdc: usdc(spent()), capUsdc: usdc(CALL_CAP_ATOMIC) } });
    }
    if (r.status === 402 || (s && !s.success)) { set({ status: "REJECTED", detail: s?.errorReason ?? `HTTP ${r.status}` }); return res.status(402).json({ ok: false, error: s?.errorReason ?? "payment rejected" }); }
    set({ status: "UNKNOWN", detail: `HTTP ${r.status} without settlement evidence` });
    return res.status(502).json({ ok: false, error: `HTTP ${r.status} without settlement evidence (counted toward the budget; check npm run calls)` });
  } catch (e: any) {
    set({ status: "UNKNOWN", detail: String(e).slice(0, 300) });
    return res.status(504).json({ ok: false, error: "payment outcome unknown (timeout); not retried. Check npm run calls" });
  }
});

app.get("/calls", (_req, res) => res.json({ payer: evmAddress, spentUsdc: usdc(spent()), capUsdc: usdc(CALL_CAP_ATOMIC), calls: loadCalls(WALLET_CALLS) }));

app.listen(WALLET_PORT, () => console.log(`agent wallet on :${WALLET_PORT}  payer ${evmAddress}  services ${Object.keys(SERVICES).join(", ")}  price ${usdc(CALL_PRICE_ATOMIC)} test USDC/call  budget ${usdc(spent())}/${usdc(CALL_CAP_ATOMIC)} used`));
