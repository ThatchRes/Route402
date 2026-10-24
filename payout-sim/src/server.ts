// Payout, conversion, ledger and reconciliation service (guide prompt A5). Port 8403.
// Money only moves forward on evidence: funding confirmed -> provider accepted -> converted -> credited.
import "dotenv/config";
import express from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { SCENARIOS, OUTCOMES, quoteFor, validateInput, x402Executable, type Outcome, type QuoteInput } from "./scenarios.js";
import { verifyFunding } from "./chain.js";
import { createPayout, getStatus, resumeAll, sign } from "./provider.js";
import { assertBalanced, balance, line, type Entry, type Line } from "./ledger.js";
import { load, update, type Payout, type ProviderEvent } from "./store.js";
import { fmt, listCurrencies } from "./money.js";

export const app = express();
const TOKEN = () => process.env.PAYOUT_INTERNAL_TOKEN ?? "dev-token";
const SELLER = process.env.SELLER_URL ?? "http://localhost:8402";
const ID = /^[A-Za-z0-9_\-:.]{1,80}$/;
const now = () => new Date().toISOString();

function internal(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.header("authorization") !== `Bearer ${TOKEN()}`) return res.status(401).json({ error: "unauthorized" });
  next();
}

function post(db: ReturnType<typeof load>, transferId: string, kind: string, lines: Line[], refs: Record<string, string>,
              ledger: Entry["ledger"] = "scenario") {
  assertBalanced(lines);                                   // throws -> nothing is written
  db.entries.push({ entryId: `le_${randomUUID().slice(0, 8)}`, transferId, ledger, kind, lines, refs,
                    provenance: ledger === "testnet" ? "testnet" : "simulated", at: now() });
}

function setStatus(p: Payout, status: Payout["status"], note?: string) {
  p.status = status; p.history.push({ at: now(), status, note });
}

/** Accounts: source:<id>, clearing:funding, fees:*, counterparty:*, provider:clearing, payout:clearing, beneficiary:<id> */
function postFunding(db: any, p: Payout) {
  const q = p.quote, t = p.transferId;
  const S = BigInt(q.sourceDebit.minor), fee = BigInt(q.fundingFee.minor), src = q.sourceDebit.ccy, asset = q.funding.ccy;
  post(db, t, "SOURCE_DEBIT", [line(src, "source:US-Operating", -S), line(src, "clearing:funding", S)], { quoteId: q.quoteId });
  post(db, t, "FUNDING_FEE", [line(src, "clearing:funding", -fee), line(src, "fees:funding", fee)], { quoteId: q.quoteId });
  if (q.route === "stablecoin") {                           // linked two-asset conversion: each leg balances alone
    const conv = `cv_${randomUUID().slice(0, 6)}`;
    post(db, t, "ONRAMP_CONVERSION", [line(src, "clearing:funding", -(S - fee)), line(src, "counterparty:onramp", S - fee),
      line(asset, "counterparty:onramp", -BigInt(q.funding.minor)), line(asset, "provider:clearing", BigInt(q.funding.minor))],
      { conversionId: conv, rate: q.funding.rate ?? "", quoteId: q.quoteId });
  } else {
    post(db, t, "PROVIDER_FUNDING", [line(src, "clearing:funding", -(S - fee)), line(src, "provider:clearing", S - fee)], { quoteId: q.quoteId });
  }
}

// ------------------------------------------------------------------ create payout (idempotent)
// body: {transferId, scenario?: id, custom?: QuoteInput & {outcome?}, quoteExpiresAt?, funding:{mode, orderId?}}
app.post("/payouts", internal, express.json(), async (req, res) => {
  const opRef = req.header("idempotency-key") ?? "";
  const { transferId, scenario, custom, quoteExpiresAt, funding } = req.body ?? {};
  if (!ID.test(opRef) || !ID.test(transferId ?? "")) return res.status(400).json({ error: "invalid transferId or Idempotency-Key" });
  let input: QuoteInput, outcome: Outcome, label: string;
  if (scenario) {
    if (!SCENARIOS[scenario]) return res.status(400).json({ error: `unknown scenario ${scenario}` });
    ({ input, outcome, label } = SCENARIOS[scenario]);
  } else if (custom) {
    const { outcome: o = "delivered", ...rest } = custom;
    const errs = validateInput(rest);
    if (!OUTCOMES.includes(o)) errs.push(`outcome must be one of ${OUTCOMES.join(", ")}`);
    if (errs.length) return res.status(422).json({ error: "invalid custom quote", details: errs });
    input = rest; outcome = o; label = `custom ${rest.srcCcy}->${rest.destCcy} (${rest.route})`;
  } else return res.status(400).json({ error: "scenario or custom required" });

  // x402 is mandatory wherever it can execute (USDC on Base); other stablecoin rails are labeled simulations; bank skips x402.
  if (x402Executable(input) && funding?.mode !== "x402_testnet")
    return res.status(422).json({ error: "USDC-on-Base route requires x402 funding: run x402-spike `npm run fund -- <transferId>` first" });
  if (input.route === "stablecoin" && !x402Executable(input) && funding?.mode !== "simulated_token")
    return res.status(422).json({ error: `${input.fundingAsset} on ${input.network} has no live adapter: use funding.mode simulated_token (labeled simulation)` });
  if (input.route === "bank" && funding?.mode !== "simulated_bank")
    return res.status(422).json({ error: "bank route does not use x402; use funding.mode simulated_bank" });

  const requestHash = createHash("sha256").update(JSON.stringify({ transferId, scenario, custom, quoteExpiresAt, funding })).digest("hex");
  const prior = load().byOpRef[opRef];
  if (prior) {
    const p = load().payouts[prior];
    return p.requestHash === requestHash ? res.json(p) : res.status(409).json({ error: "Idempotency-Key reused with a different body" });
  }
  let quote: any;
  try { quote = quoteFor(input, scenario ?? transferId); } catch (e: any) { return res.status(422).json({ error: e.message }); }

  // Funding evidence: the x402 audit (seller + buyer + chain must agree) AND our own chain check.
  let fundingInfo: any = { mode: funding?.mode ?? "simulated_bank", provenance: "simulated",
    note: funding?.mode === "simulated_token" ? `${input.fundingAsset} on ${input.network}: simulated rail, no live adapter yet` : undefined };
  if (funding?.mode === "x402_testnet") {
    if (!ID.test(funding.orderId ?? "")) return res.status(400).json({ error: "funding.orderId required" });
    if (Object.values(load().payouts).some((x) => x.funding?.orderId === funding.orderId && x.status !== "FUNDING_NOT_CONFIRMED"))
      return res.status(409).json({ error: "this x402 funding order already backs another payout" });
    const H = { authorization: `Bearer ${process.env.X402_INTERNAL_TOKEN}` };
    const order = await fetch(`${SELLER}/orders/${funding.orderId}`, { headers: H }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const audit = await fetch(`${SELLER}/orders/${funding.orderId}/reconciliation`, { headers: H }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const tx = order?.settlement?.transaction;
    const chain = tx ? await verifyFunding(tx, order.payTo, BigInt(order.amountAtomic)) : { status: "PENDING", observed: "no tx" };
    fundingInfo = { mode: "x402_testnet", orderId: funding.orderId, orderStatus: order?.status ?? "UNREACHABLE", x402Audit: audit?.outcome ?? "UNREACHABLE",
                    tx, payTo: order?.payTo, amountAtomic: order?.amountAtomic, chainCheck: chain, provenance: "testnet",
                    note: "testnet evidence is linked to, not a substitute for, the simulated scenario funding" };
  }

  const payoutId = `po_${randomUUID().slice(0, 8)}`;
  const p: Payout = { payoutId, transferId, opRef, requestHash, scenario: scenario ?? "custom", quote, funding: fundingInfo,
    status: "FUNDED", lastSequence: 0, creditedMinor: "0", createdAt: now(), history: [] };
  (p as any).outcome = outcome; (p as any).label = label;

  update((db) => {
    db.payouts[payoutId] = p; db.byOpRef[opRef] = payoutId;
    if (fundingInfo.mode === "x402_testnet" &&
        (fundingInfo.orderStatus !== "FUNDING_CONFIRMED" || fundingInfo.x402Audit !== "MATCHED" || fundingInfo.chainCheck.status === "MISMATCH")) {
      setStatus(p, "FUNDING_NOT_CONFIRMED", `x402 order ${fundingInfo.orderStatus}, audit ${fundingInfo.x402Audit}, chain ${fundingInfo.chainCheck.status}: no payout`);
      return;
    }
    postFunding(db, p);
    if (fundingInfo.mode === "x402_testnet")
      post(db, transferId, "TESTNET_FUNDING", [line("USDC", "wallet:buyer", -BigInt(fundingInfo.amountAtomic)),
        line("USDC", "wallet:payout-provider", BigInt(fundingInfo.amountAtomic))], { tx: fundingInfo.tx ?? "" }, "testnet");
    setStatus(p, "FUNDED", "source debited and provider funded (simulated scenario ledger)");
    if (quoteExpiresAt && Date.parse(quoteExpiresAt) < Date.now())
      setStatus(p, "HOLD_QUOTE_EXPIRED", "payout quote expired after funding: funded liability kept, needs renewed quote + approval");
  });
  if (["FUNDING_NOT_CONFIRMED", "HOLD_QUOTE_EXPIRED"].includes(load().payouts[payoutId].status)) return res.status(202).json(load().payouts[payoutId]);
  await dispatch(payoutId);
  res.status(201).json(load().payouts[payoutId]);
});

async function dispatch(payoutId: string) {
  const p = load().payouts[payoutId];
  update((db) => setStatus(db.payouts[payoutId], "PAYOUT_REQUESTED", `opRef ${p.opRef}`));
  const outcome = (p as any).outcome as Outcome;
  const r = createPayout(p.opRef, p.quote, outcome);
  if (outcome === "timeout") {        // provider accepted, but our response was lost
    update((db) => setStatus(db.payouts[payoutId], "PAYOUT_UNKNOWN", "provider call timed out: look up status with the SAME opRef; never re-create"));
    return;
  }
  update((db) => { db.payouts[payoutId].quote.providerRef = r.providerRef; });
}

// renewed approval after quote expiry (approval itself lives in Person A's backend)
app.post("/payouts/:id/requote", internal, express.json(), async (req, res) => {
  const p = load().payouts[String(req.params.id)];
  if (!p) return res.status(404).json({ error: "not found" });
  if (p.status !== "HOLD_QUOTE_EXPIRED") return res.status(409).json({ error: `payout is ${p.status}` });
  if (!ID.test(req.body?.approvalId ?? "")) return res.status(400).json({ error: "approvalId of the renewed approval required" });
  update((db) => setStatus(db.payouts[p.payoutId], "FUNDED", `renewed quote approved (${req.body.approvalId})`));
  await dispatch(p.payoutId);
  res.json(load().payouts[p.payoutId]);
});

// status lookup after timeout: same opRef, ingest whatever the provider already sent
app.post("/payouts/:id/refresh", internal, (req, res) => {
  const p = load().payouts[String(req.params.id)];
  if (!p) return res.status(404).json({ error: "not found" });
  const st = getStatus(p.opRef);
  if (!st.found) return res.json({ found: false, note: "provider has no order for this opRef: operator may re-dispatch" });
  update((db) => {
    const cur = db.payouts[p.payoutId];
    cur.quote.providerRef = st.providerRef;
    if (cur.status === "PAYOUT_UNKNOWN") setStatus(cur, "PAYOUT_REQUESTED", "status lookup found the existing provider order");
    for (const e of st.events) ingest(db, e as any);
  });
  res.json(load().payouts[p.payoutId]);
});

// ------------------------------------------------------------------ signed provider webhooks
app.post("/webhooks/provider", express.raw({ type: "*/*" }), (req, res) => {
  const raw = req.body.toString("utf8");
  const ts = req.header("x-sim-timestamp") ?? "", sig = req.header("x-sim-signature") ?? "";
  const expected = sign(ts, raw);
  const okSig = sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!okSig) return res.status(401).json({ error: "bad signature" });
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.status(401).json({ error: "stale timestamp" });
  const ev = JSON.parse(raw);
  update((db) => ingest(db, ev));
  res.json({ ok: true });
});

/** Dedupe by eventId; buffer out-of-order events and apply strictly in provider sequence. */
function ingest(db: any, ev: any) {
  if (db.events.some((x: ProviderEvent) => x.eventId === ev.eventId)) return;          // duplicate: ignore
  const payoutId = db.byOpRef[ev.opRef];
  if (!payoutId) return;
  db.events.push({ ...ev, observedAt: now(), applied: false });
  const p: Payout = db.payouts[payoutId];
  for (;;) {
    const next = db.events.find((x: ProviderEvent) => x.opRef === p.opRef && !x.applied && x.sequence === p.lastSequence + 1);
    if (!next) break;
    apply(db, p, next); next.applied = true; p.lastSequence = next.sequence;
  }
}

function apply(db: any, p: Payout, ev: ProviderEvent) {
  const q = p.quote, t = p.transferId, dest = q.recipientNet.ccy, asset = q.funding.ccy;
  switch (ev.type) {
    case "PAYOUT_ACCEPTED": setStatus(p, "PAYOUT_ACCEPTED", `provider ${ev.providerRef}`); break;
    case "CONVERSION_COMPLETED": {
      const C = BigInt(ev.amount!), fee = BigInt(q.payoutFee.minor);
      post(db, t, "PROVIDER_FX", [line(asset, "provider:clearing", -BigInt(q.funding.minor)), line(asset, "counterparty:fx", BigInt(q.funding.minor)),
        line(dest, "counterparty:fx", -C), line(dest, "payout:clearing", C)], { rate: q.converted.rate, eventId: ev.eventId });
      post(db, t, "PAYOUT_FEE", [line(dest, "payout:clearing", -fee), line(dest, "fees:payout", fee)], { eventId: ev.eventId });
      const surplus = BigInt(q.roundingSurplus?.minor ?? "0");
      if (surplus > 0n) post(db, t, "ROUNDING_SURPLUS", [line(dest, "payout:clearing", -surplus), line(dest, "provider:rounding", surplus)], { eventId: ev.eventId });
      setStatus(p, "CONVERTED", fmt(C, dest)); break;
    }
    case "BENEFICIARY_CREDITED": {
      const X = BigInt(ev.amount!);
      post(db, t, "BENEFICIARY_CREDIT", [line(dest, "payout:clearing", -X), line(dest, "beneficiary:recipient", X)], { eventId: ev.eventId });
      p.creditedMinor = (BigInt(p.creditedMinor) + X).toString();
      if (p.status === "PAYOUT_REJECTED") p.lateSuccess = true;
      const final = (ev as any).final !== false;            // provider says this credit completes the payout
      setStatus(p, final || p.lateSuccess ? "DELIVERED" : "PARTIALLY_CREDITED", fmt(X, dest));
      break;
    }
    case "PAYOUT_REJECTED": setStatus(p, "PAYOUT_REJECTED", "funded amount stays outstanding; recovery needs operator approval"); break;
  }
}

// ------------------------------------------------------------------ reads used by the dashboard and agents
async function reconciliation(transferId: string) {
  const db = load();
  const p = Object.values(db.payouts).find((x) => x.transferId === transferId);
  if (!p) return null;
  const q = p.quote, mine = db.entries.filter((e) => e.transferId === transferId);
  const debit = mine.find((e) => e.kind === "SOURCE_DEBIT");
  const fx = db.events.find((e) => e.opRef === p.opRef && e.applied && e.type === "CONVERSION_COMPLETED");
  const credited = BigInt(p.creditedMinor);
  let balanced = "balanced per asset";
  try { mine.forEach((e) => assertBalanced(e.lines)); } catch { balanced = "UNBALANCED"; }
  const creditStatus = p.lateSuccess ? "LATE_SUCCESS" : p.status === "PAYOUT_REJECTED" ? "REJECTED"
    : p.status === "DELIVERED" ? "CREDITED" : "PENDING";
  const legs: any[] = [
    { leg: "bank_debit", expected: q.sourceDebit.display, observed: debit ? q.sourceDebit.display : null, evidenceRef: debit?.entryId, provenance: "simulated" },
    { leg: "ledger_postings", expected: "balanced per asset", observed: balanced, evidenceRef: `${mine.length} entries` },
    { leg: "fx_conversion", expected: q.converted.display, observed: fx ? fmt(BigInt(fx.amount!), fx.currency!) : null, evidenceRef: fx?.eventId, provenance: "simulated" },
    { leg: "beneficiary_credit", expected: q.recipientNet.display, observed: credited > 0n ? fmt(credited, q.recipientNet.ccy) : null,
      status: creditStatus, evidenceRef: q.providerRef, provenance: "simulated" },
  ];
  if (p.funding.mode === "x402_testnet") {
    // Re-verified live on every reconciliation: our own chain read + the x402 service's own audit.
    const chain = p.funding.tx ? await verifyFunding(p.funding.tx, p.funding.payTo, BigInt(p.funding.amountAtomic)) : { status: "MISSING", observed: null };
    const audit = await fetch(`${SELLER}/orders/${p.funding.orderId}/reconciliation`, { headers: { authorization: `Bearer ${process.env.X402_INTERNAL_TOKEN}` } })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const amt = p.funding.amountAtomic ? fmt(BigInt(p.funding.amountAtomic), "USDC") : "?";
    legs.splice(2, 0,
      { leg: "chain_settlement", expected: amt, observed: chain.status === "MATCHED" || chain.status === "PENDING_CONFIRMATION" ? amt : chain.observed,
        status: chain.status === "MATCHED" ? "MATCHED" : chain.status === "PENDING_CONFIRMATION" ? "PENDING_CONFIRMATION" : chain.status === "PENDING" ? "PENDING" : "MISMATCH",
        evidenceRef: p.funding.tx, confirmations: (chain as any).confirmations ?? 0, requiredConfirmations: 3, provenance: "testnet" },
      { leg: "x402_records", expected: "MATCHED", observed: audit?.outcome ?? "UNREACHABLE", evidenceRef: p.funding.orderId,
        detail: audit?.legs?.map((l: any) => `${l.leg}:${l.status}`).join(", "), provenance: "testnet" });
  }
  const outstandingProvider = balance(db.entries.filter((e) => e.transferId === transferId), "provider:clearing", q.funding.ccy);
  const outstandingPayout = balance(db.entries.filter((e) => e.transferId === transferId), "payout:clearing", q.recipientNet.ccy);
  const creditedAtUtc = p.status === "DELIVERED" ? db.events.filter((e) => e.opRef === p.opRef && e.applied && e.type === "BENEFICIARY_CREDITED").map((e) => e.occurredAt).sort().at(-1) : undefined;
  return { transferId, payoutId: p.payoutId, status: p.status, creditedAtUtc, legs,
    outstanding: { providerClearing: fmt(outstandingProvider, q.funding.ccy), payoutClearing: fmt(outstandingPayout, q.recipientNet.ccy),
                   fundedButUnpaid: outstandingProvider > 0n || outstandingPayout > 0n } };
}

app.get("/v1/transfers/:id/reconciliation", internal, async (req, res) => {
  const r = await reconciliation(String(req.params.id)); return r ? res.json(r) : res.status(404).json({ error: "not found" });
});

app.get("/v1/transfers/:id/events", internal, (req, res) => {
  const db = load(); const t = String(req.params.id);
  const p = Object.values(db.payouts).find((x) => x.transferId === t);
  if (!p) return res.status(404).json({ error: "not found" });
  const items: any[] = [];
  if (p.funding.mode === "x402_testnet" && p.funding.orderStatus === "FUNDING_CONFIRMED") {
    items.push({ id: `${p.payoutId}-fund`, type: "FUNDING_CONFIRMED", producer: "x402", evidenceRef: p.funding.tx, provenance: "testnet" });
    items.push({ id: `${p.payoutId}-settle`, type: "SETTLED", producer: "x402", evidenceRef: p.funding.tx, provenance: "testnet" });
  } else if (p.status !== "FUNDING_NOT_CONFIRMED") {
    items.push({ id: `${p.payoutId}-fund`, type: "FUNDING_CONFIRMED", producer: "bank-sim", evidenceRef: p.payoutId, provenance: "simulated" });
  }
  const map: Record<string, string> = { PAYOUT_ACCEPTED: "PAYOUT_PENDING", CONVERSION_COMPLETED: "CONVERSION_COMPLETED",
    BENEFICIARY_CREDITED: "DELIVERED", PAYOUT_REJECTED: "PAYOUT_REJECTED" };
  for (const e of db.events.filter((x) => x.opRef === p.opRef && x.applied).sort((a, b) => a.sequence - b.sequence))
    items.push({ id: e.eventId, type: map[e.type] ?? e.type, producer: "payout-sim", evidenceRef: e.providerRef,
                 amount: (e as any).display, sequence: e.sequence, provenance: "simulated" });
  if (p.status === "PAYOUT_UNKNOWN") items.push({ id: `${p.payoutId}-unknown`, type: "SETTLEMENT_UNKNOWN", producer: "payout-service", provenance: "simulated" });
  if (p.status === "HOLD_QUOTE_EXPIRED") items.push({ id: `${p.payoutId}-qexp`, type: "QUOTE_EXPIRED", producer: "payout-service", provenance: "simulated" });
  res.json({ items });
});

app.get("/v1/transfers/:id/receipt", internal, async (req, res) => {
  const db = load(); const t = String(req.params.id);
  const p = Object.values(db.payouts).find((x) => x.transferId === t);
  if (!p) return res.status(404).json({ error: "not found" });
  const r = (await reconciliation(t))!;
  res.json({ receiptVersion: 1, transferId: t, payoutId: p.payoutId, scenario: (p as any).label,
    final: p.status === "DELIVERED" && !r.outstanding.fundedButUnpaid, status: p.status, quote: p.quote, funding: p.funding,
    reconciliation: r, ledger: db.entries.filter((e) => e.transferId === t), history: p.history,
    disclosure: "Bank debit, FX and payout are simulated. Only the x402 funding leg (if present) is a real testnet transaction." });
});

app.get("/payouts/:id", internal, (req, res) => {
  const p = load().payouts[String(req.params.id)]; return p ? res.json(p) : res.status(404).json({ error: "not found" });
});
app.get("/scenarios", (_req, res) => res.json(Object.values(SCENARIOS).map((s) => ({ id: s.id, label: s.label, outcome: s.outcome, quote: quoteFor(s.input, s.id) }))));
app.get("/currencies", (_req, res) => res.json(listCurrencies()));
// Preview any pair without creating anything (dashboard quote builder). Explicit synthetic inputs required.
app.post("/quotes/preview", express.json(), (req, res) => {
  const errs = validateInput(req.body ?? {});
  if (errs.length) return res.status(422).json({ error: "invalid custom quote", details: errs });
  try { res.json(quoteFor(req.body, "preview")); } catch (e: any) { res.status(422).json({ error: e.message }); }
});

const port = Number(process.env.PORT ?? 8403);
if (process.env.PAYOUT_NO_LISTEN !== "1") app.listen(port, process.env.LOCAL_ROUTING === "1" ? "127.0.0.1" : "0.0.0.0", () => { console.log(`payout-sim on :${port} (simulated provider, labeled synthetic rates)`); resumeAll(); });
