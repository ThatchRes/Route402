// Route + orchestration service (port 8404). This is the "backend" the agents and the dashboard talk to:
//   intent -> optimizer decision -> plan (termsHash) -> approval -> execute each leg:
//   x402 funding (USDC on Base, real testnet) | simulated coin rail | simulated bank  -> payout-sim payout -> reconciliation
import "dotenv/config";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { optimize, type Intent } from "./optimizer.js";
import { planQueue, type QueueInput } from "./queue.js";
import { load, update } from "./store.js";
import { fmt, toMinor } from "../money.js";

const app = express();
app.use(express.json());
const TOKEN = () => process.env.ROUTER_TOKEN ?? "dev-token";
const PAYOUT = process.env.PAYOUT_URL ?? "http://localhost:8403";
const PAYOUT_H = () => ({ authorization: `Bearer ${process.env.PAYOUT_INTERNAL_TOKEN ?? "dev-token"}`, "content-type": "application/json" });
const X402_DIR = process.env.X402_DIR ?? path.resolve("..", "x402-spike");
const QUOTE_TTL_MS = 15 * 60e3;
const TREASURY_USD = toMinor(process.env.TREASURY_USD ?? "2000000.00", "USD");      // simulated operating balance
const ID = /^[A-Za-z0-9_\-:.]{1,80}$/;
const now = () => new Date().toISOString();

app.use((req, res, next) => (req.header("authorization") === `Bearer ${TOKEN()}` ? next() : res.status(401).json({ code: "UNAUTHORIZED" })));
const err = (res: express.Response, status: number, code: string, message: string, details?: any) =>
  res.status(status).json({ code, message, details, retryable: false, correlationId: res.req.header("x-correlation-id") });

// ------------------------------------------------------------------ intents + decisions
app.post("/v1/intents", (req, res) => {
  const it: Intent = req.body;
  if (!it?.srcCcy || !it?.destCcy || !it?.amount || !["SOURCE_FIXED", "RECIPIENT_FIXED"].includes(it.amountType))
    return err(res, 400, "INVALID_INTENT", "srcCcy, destCcy, amount, amountType required");
  let decision: any;
  try { decision = optimize(it); } catch (e: any) { return err(res, 422, "INVALID_INTENT", e.message); }
  const intentId = `int_${randomUUID().slice(0, 8)}`;
  update((db) => { db.intents[intentId] = { intentId, intent: it, decision, createdAt: now() }; });
  res.status(201).json({ intentId, decision });
});
app.get("/v1/intents/:id", (req, res) => { const i = load().intents[String(req.params.id)]; return i ? res.json(i) : err(res, 404, "NOT_FOUND", "intent"); });

// ------------------------------------------------------------------ plans, approval, execution
const canonical = (x: any): string => (Array.isArray(x) ? `[${x.map(canonical).join(",")}]` : x && typeof x === "object"
  ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(",")}}` : JSON.stringify(x));

app.post("/v1/transfers", (req, res) => {
  const i = load().intents[String(req.body?.intentId)];
  if (!i) return err(res, 404, "NOT_FOUND", "intent");
  if (i.decision.status !== "OK") return err(res, 422, "NO_ROUTE", i.decision.reason ?? "no eligible route", i.decision.missing);
  const key = req.header("idempotency-key");
  if (key && load().idem[`create:${key}`]) return res.json(load().transfers[load().idem[`create:${key}`]]);
  const terms = { intent: i.intent, allocations: i.decision.allocations.map((a: any) => ({ routeId: a.routeId, input: a.quote.input,
    sourceDebit: a.quote.sourceDebit.display, recipientNet: a.quote.recipientNet.display })), totals: i.decision.totals };
  const termsHash = createHash("sha256").update(canonical(terms)).digest("hex");
  const transferId = `tr_${randomUUID().slice(0, 8)}`;
  const t = { transferId, intentId: i.intentId, planVersion: 1, termsHash, terms, status: "AWAITING_APPROVAL",
    quoteExpiresAt: new Date(Date.parse(i.createdAt) + QUOTE_TTL_MS).toISOString(), decisionRecordId: i.decision.decisionRecordId,
    value: i.decision.value, children: [], steps: {}, history: [{ at: now(), status: "AWAITING_APPROVAL" }] };
  update((db) => { db.transfers[transferId] = t; if (key) db.idem[`create:${key}`] = transferId; });
  res.status(201).json(t);
});

app.post("/v1/transfers/:id/approvals", (req, res) => {
  const t = load().transfers[String(req.params.id)];
  if (!t) return err(res, 404, "NOT_FOUND", "transfer");
  const { planVersion, termsHash, approver } = req.body ?? {};
  if (planVersion !== t.planVersion || termsHash !== t.termsHash) return err(res, 409, "PLAN_CHANGED", "approval must match the displayed plan version and termsHash");
  if (Date.parse(t.quoteExpiresAt) < Date.now()) return err(res, 409, "QUOTE_EXPIRED", "create a new intent for fresh quotes");
  if (!ID.test(approver ?? "")) return err(res, 400, "INVALID", "approver required");
  update((db) => { const x = db.transfers[t.transferId]; x.status = "APPROVED"; x.approval = { approver, planVersion, termsHash, at: now() };
    x.history.push({ at: now(), status: "APPROVED", note: approver }); });
  res.json(load().transfers[t.transferId]);
});

app.post("/v1/transfers/:id/execute", (req, res) => {
  const t = load().transfers[String(req.params.id)];
  if (!t) return err(res, 404, "NOT_FOUND", "transfer");
  const { planVersion, termsHash } = req.body ?? {};
  if (planVersion !== t.planVersion || termsHash !== t.termsHash) return err(res, 409, "PLAN_CHANGED", "execute must reference the approved plan");
  if (["EXECUTING", "COMPLETED", "PARTIAL", "NEEDS_RECONCILIATION"].includes(t.status)) return res.status(200).json({ ...t, note: "already executing/executed: not re-sent" });
  if (t.status !== "APPROVED") return err(res, 409, "NOT_APPROVED", `transfer is ${t.status}`);
  if (Date.parse(t.quoteExpiresAt) < Date.now()) return err(res, 409, "QUOTE_EXPIRED", "approved quote expired before execution");
  // atomic reservation of source funds (simulated treasury), then async execution
  const debitUsd = t.terms.intent.srcCcy === "USD" ? toMinor(t.terms.totals.sourceDebit.split(" ")[0], "USD") : 0n;
  const ok = update((db) => {
    const reserved = BigInt(db.reservedUsdMinor);
    if (reserved + debitUsd > TREASURY_USD) return false;
    db.reservedUsdMinor = (reserved + debitUsd).toString();
    const x = db.transfers[t.transferId]; x.status = "EXECUTING"; x.reservedUsdMinor = debitUsd.toString();
    x.history.push({ at: now(), status: "EXECUTING", note: `reserved ${fmt(debitUsd, "USD")}` }); return true;
  });
  if (!ok) return err(res, 409, "INSUFFICIENT_FUNDS", "confirmed treasury balance minus reservations is too low");
  res.status(202).json(load().transfers[t.transferId]);
  execute(t.transferId).catch((e) => update((db) => { const x = db.transfers[t.transferId]; x.status = "NEEDS_RECONCILIATION"; x.history.push({ at: now(), status: "NEEDS_RECONCILIATION", note: String(e).slice(0, 200) }); }));
});

function setStep(transferId: string, stepId: string, status: string, extra: any = {}) {
  update((db) => { const x = db.transfers[transferId]; x.steps[stepId] = { ...(x.steps[stepId] ?? {}), status, ...extra, at: now() }; });
}

function runX402Fund(childId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", "src/fund.ts", childId], { cwd: X402_DIR, shell: process.platform === "win32" });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", () => { const last = out.trim().split("\n").reverse().find((l) => /^(NOT_)?FUNDED /.test(l));
      last?.startsWith("FUNDED ") ? resolve(last.split(" ")[1]) : reject(new Error(`x402 funding failed: ${last ?? out.slice(-300)}`)); });
  });
}

async function execute(transferId: string) {
  const t = load().transfers[transferId];
  for (const [i, a] of t.terms.allocations.entries()) {
    const childId = `${transferId}_c${i + 1}`, input = a.input;
    const fundStep = `fund_${i + 1}`, payStep = `payout_${i + 1}`;
    let funding: any;
    const live = input.route === "stablecoin" && input.fundingAsset === "USDC" && (input.network ?? "base") === "base";
    if (live) {
      setStep(transferId, fundStep, "REQUESTED", { rail: "x402 USDC on Base Sepolia (real testnet)" });
      try { const orderId = await runX402Fund(childId); funding = { mode: "x402_testnet", orderId }; setStep(transferId, fundStep, "CONFIRMED", { orderId }); }
      catch (e: any) { setStep(transferId, fundStep, "UNKNOWN", { detail: e.message }); throw e; }   // never re-funds blindly
    } else {
      funding = { mode: input.route === "stablecoin" ? "simulated_token" : "simulated_bank" };
      setStep(transferId, fundStep, "CONFIRMED", { rail: `${funding.mode} (labeled simulation)` });
    }
    setStep(transferId, payStep, "REQUESTED");
    const r = await fetch(`${PAYOUT}/payouts`, { method: "POST", headers: { ...PAYOUT_H(), "idempotency-key": `op_${childId}` },
      body: JSON.stringify({ transferId: childId, custom: { ...input, outcome: "delivered" }, quoteExpiresAt: t.quoteExpiresAt, funding }) });
    const p = await r.json();
    if (!r.ok && r.status !== 202) { setStep(transferId, payStep, "REJECTED", { detail: p.error }); throw new Error(p.error); }
    setStep(transferId, payStep, p.status === "FUNDING_NOT_CONFIRMED" ? "REJECTED" : "PENDING", { payoutId: p.payoutId });
    update((db) => { const x = db.transfers[transferId]; if (!x.children.includes(childId)) x.children.push(childId); });
  }
  // wait for terminal payout states, then release the reservation
  for (let k = 0; k < 40; k++) {
    const recs = await Promise.all(load().transfers[transferId].children.map((c: string) => fetch(`${PAYOUT}/v1/transfers/${c}/reconciliation`, { headers: PAYOUT_H() }).then((r) => r.json())));
    const done = recs.every((r: any) => ["DELIVERED", "PAYOUT_REJECTED", "FUNDING_NOT_CONFIRMED", "PAYOUT_UNKNOWN", "HOLD_QUOTE_EXPIRED"].includes(r.status));
    recs.forEach((r: any, i: number) => setStep(transferId, `payout_${i + 1}`, r.status === "DELIVERED" ? "CONFIRMED" : r.status === "PAYOUT_REJECTED" ? "REJECTED" : r.status === "PAYOUT_UNKNOWN" ? "UNKNOWN" : "PENDING"));
    if (done) {
      const all = recs.every((r: any) => r.status === "DELIVERED" && !r.outstanding.fundedButUnpaid);
      update((db) => { const x = db.transfers[transferId]; db.reservedUsdMinor = (BigInt(db.reservedUsdMinor) - BigInt(x.reservedUsdMinor ?? "0")).toString();
        x.reservedUsdMinor = "0"; x.status = all ? "COMPLETED" : "NEEDS_RECONCILIATION"; x.history.push({ at: now(), status: x.status }); });
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

app.get("/v1/transfers/:id", (req, res) => { const t = load().transfers[String(req.params.id)]; return t ? res.json(t) : err(res, 404, "NOT_FOUND", "transfer"); });
app.get("/v1/transfers/:id/steps/:stepId", (req, res) => {
  const s = load().transfers[String(req.params.id)]?.steps?.[String(req.params.stepId)];
  return s ? res.json({ stepStatus: s.status, ...s }) : res.json({ stepStatus: "NOT_STARTED" });
});

// ------------------------------------------------------------------ evidence (merged across split children)
async function children(id: string) { const t = load().transfers[id]; return t ? t.children as string[] : null; }
app.get("/v1/transfers/:id/events", async (req, res) => {
  const id = String(req.params.id), kids = await children(id);
  if (!kids) return err(res, 404, "NOT_FOUND", "transfer");
  const t = load().transfers[id];
  const items: any[] = t.history.map((h: any, n: number) => ({ id: `${id}-h${n}`, type: h.status, producer: "router", occurredAt: h.at, note: h.note, provenance: "platform" }));
  for (const c of kids) { const r = await fetch(`${PAYOUT}/v1/transfers/${c}/events`, { headers: PAYOUT_H() }).then((x) => x.json());
    for (const e of r.items ?? []) items.push({ ...e, child: c }); }
  for (const o of load().observations.filter((o) => o.subjectId === id)) items.push({ ...o, type: "AGENT_OBSERVATION" });
  res.json({ items });
});
app.get("/v1/transfers/:id/reconciliation", async (req, res) => {
  const id = String(req.params.id), kids = await children(id);
  if (!kids) return err(res, 404, "NOT_FOUND", "transfer");
  const recs = await Promise.all(kids.map((c) => fetch(`${PAYOUT}/v1/transfers/${c}/reconciliation`, { headers: PAYOUT_H() }).then((r) => r.json())));
  if (recs.length === 1) return res.json({ ...recs[0], transferId: id, children: kids });
  // split: one leg per kind, MATCHED only if every child matches; outstanding listed per child
  const kinds = [...new Set(recs.flatMap((r: any) => r.legs.map((l: any) => l.leg)))];
  const statusOf = (l: any) => l.status ?? (l.expected === l.observed ? "MATCHED" : l.observed ? "MISMATCH" : "PENDING");
  const legs = kinds.map((k) => {
    const ls = recs.map((r: any) => r.legs.find((l: any) => l.leg === k)).filter(Boolean), st = ls.map(statusOf);
    // worst status wins: MISMATCH/REJECTED > UNKNOWN > PENDING* > MATCHED/CREDITED
    const status = st.find((x) => ["MISMATCH", "REJECTED"].includes(x)) ?? st.find((x) => x === "UNKNOWN") ?? st.find((x) => x.startsWith("PENDING"))
      ?? (k === "beneficiary_credit" ? (st.includes("LATE_SUCCESS") ? "LATE_SUCCESS" : "CREDITED") : "MATCHED");
    return { leg: k, legsFromChildren: ls.length, expected: ls.map((l: any) => l.expected).join(" + "), observed: ls.map((l: any) => l.observed ?? "-").join(" + "),
             status, evidenceRef: ls.map((l: any) => l.evidenceRef).filter(Boolean).join(",") };
  });
  res.json({ transferId: id, children: kids, legs, outstanding: { fundedButUnpaid: recs.some((r: any) => r.outstanding.fundedButUnpaid),
    perChild: recs.map((r: any, n: number) => ({ child: kids[n], payoutClearing: r.outstanding.payoutClearing })) } });
});
app.get("/v1/transfers/:id/receipt", async (req, res) => {
  const id = String(req.params.id), t = load().transfers[id];
  if (!t) return err(res, 404, "NOT_FOUND", "transfer");
  const kids = await Promise.all(t.children.map((c: string) => fetch(`${PAYOUT}/v1/transfers/${c}/receipt`, { headers: PAYOUT_H() }).then((r) => r.json())));
  res.json({ transferId: id, status: t.status, plan: t.terms, termsHash: t.termsHash, approval: t.approval, value: t.value, children: kids,
    disclosure: "Synthetic rates. Bank and non-USDC coin rails simulated. USDC-on-Base legs funded by real x402 testnet payments (0.01 test USDC each)." });
});

// ------------------------------------------------------------------ agent contract (/internal/*)
app.post("/internal/quotes/collect", (req, res) => {
  const i = load().intents[String(req.body?.intentId)];
  if (!i) return err(res, 404, "NOT_FOUND", "intent");
  const amt = (d?: string) => d ? { amount: d.split(" ")[0], currency: d.split(" ")[1] } : null;
  res.json((i.decision.candidates ?? []).map((c: any) => ({ id: c.routeId, label: c.label, sourceDebit: amt(c.sourceDebit), recipientNet: amt(c.recipientNet),
    arrivalUtc: c.arrivalUtc, x402Executable: c.x402Executable, eligible: c.eligible, provenance: "synthetic" })));
});
app.post("/internal/quotes/rank", (req, res) => {
  const i = load().intents[String(req.body?.intentId)];
  if (!i) return err(res, 404, "NOT_FOUND", "intent");
  const d = i.decision;
  if (d.status !== "OK") return res.json({ mode: i.intent.amountType, decisionRecordId: null, ranked: [], allocations: [], excluded: (d.candidates ?? []).map((c: any) => ({ quoteId: c.routeId, reason: c.reason })), baseline: null });
  const chosen = new Set(d.allocations.map((a: any) => a.routeId));
  const ranked = [...d.allocations.map((a: any) => a.routeId), ...d.candidates.filter((c: any) => c.eligible && !chosen.has(c.routeId)).map((c: any) => c.routeId)];
  res.json({ mode: i.intent.amountType, decisionRecordId: d.decisionRecordId, ranked,
    allocations: d.allocations.map((a: any) => ({ quoteId: a.routeId, sourceAmount: a.quote.sourceDebit.display, destAmount: a.quote.recipientNet.display })),
    excluded: d.candidates.filter((c: any) => !c.eligible).map((c: any) => ({ quoteId: c.routeId, reason: c.reason })),
    baseline: d.baseline ? { policy: "customer's current correspondent wire", quoteId: d.baseline.routeId, sourceDebit: d.baseline.sourceDebit, recipientNet: d.baseline.recipientNet } : null,
    value: d.value, bestX402: d.bestX402, execution: d.execution });
});
app.post("/internal/jobs/:id/result", (req, res) => { update((db) => { db.jobs[String(req.params.id)] = { ...req.body, at: now() }; }); res.json({ ok: true }); });
app.get("/v1/jobs/:id", (req, res) => { const j = load().jobs[String(req.params.id)]; return j ? res.json(j) : res.status(404).json({ status: "pending" }); });
app.post("/internal/events", (req, res) => { update((db) => { db.observations.push({ ...req.body, id: `obs_${randomUUID().slice(0, 8)}`, observedAt: now() }); }); res.json({ ok: true }); });

function inventory() {
  const reserved = BigInt(load().reservedUsdMinor);
  return { snapshotId: `snap_${Date.now().toString(36)}`, confirmed: { "US-Operating/USD": fmt(TREASURY_USD, "USD"), "acme-ca/CAD": "15000.00 CAD" },
    reserved: { "US-Operating/USD": fmt(reserved, "USD") }, pendingIncoming: { "acme-ca/CAD": "70000.00 CAD (confirmed, arrives 2026-10-27T15:00Z)" },
    forecast: { "acme-eu/EUR": "40000.00 EUR (forecast only)" }, provenance: "simulated" };
}
app.post("/internal/funding/check", (req, res) => {
  const i = load().intents[String(req.body?.intentId)];
  if (!i || i.decision.status !== "OK") return res.json({ feasible: false, notes: ["no decision for intent"] });
  const inv = inventory(), need = i.intent.srcCcy === "USD" ? toMinor(i.decision.totals.sourceDebit.split(" ")[0], "USD") : 0n;
  const avail = TREASURY_USD - BigInt(load().reservedUsdMinor);
  res.json({ feasible: need <= avail, snapshotId: inv.snapshotId, confirmedAvailable: { "US-Operating/USD": fmt(avail, "USD") }, reserved: inv.reserved,
    forecast: inv.forecast, blockedPools: ["client-trust (different owner)"], notes: [`needs ${fmt(need, "USD")}`, "forecast inflows excluded from available funds"] });
});
app.get("/internal/inventory", (_req, res) => res.json(inventory()));

export const DEMO_QUEUE: QueueInput = { queueId: "demo", srcCcy: "USD",
  payments: [
    { id: "pay_supplier_A", destCcy: "CAD", amount: "40000.00", deadlineUtc: "2026-10-26T22:00:00Z", pool: "acme-ca" },
    { id: "pay_supplier_B", destCcy: "CAD", amount: "120000.00", deadlineUtc: "2026-10-28T22:00:00Z", pool: "acme-ca" },
    { id: "pay_supplier_C", destCcy: "CAD", amount: "60000.00", deadlineUtc: "2026-10-28T22:00:00Z", pool: "acme-ca" },
    { id: "pay_vendor_EU", destCcy: "EUR", amount: "30000.00", deadlineUtc: "2026-10-27T22:00:00Z", pool: "acme-eu" },
    { id: "pay_vendor_EU2", destCcy: "EUR", amount: "25000.00", deadlineUtc: "2026-10-28T22:00:00Z", pool: "acme-eu" }],
  balances: [{ pool: "acme-ca", ccy: "CAD", amount: "15000.00" }],
  inflows: [
    { id: "in_customer_ca", ccy: "CAD", amount: "70000.00", arrivalUtc: "2026-10-27T15:00:00Z", pool: "acme-ca", status: "confirmed" },
    { id: "in_late_ca", ccy: "CAD", amount: "50000.00", arrivalUtc: "2026-10-28T21:30:00Z", pool: "acme-ca", status: "confirmed" },
    { id: "in_other_owner", ccy: "CAD", amount: "90000.00", arrivalUtc: "2026-10-26T15:00:00Z", pool: "client-trust", status: "confirmed" },
    { id: "in_forecast", ccy: "EUR", amount: "40000.00", arrivalUtc: "2026-10-27T10:00:00Z", pool: "acme-eu", status: "forecast" }] };

app.post("/internal/queue/proposals", (req, res) => {
  const q = planQueue({ ...DEMO_QUEUE, queueId: req.body?.queueId ?? "demo", nowUtc: "2026-10-26T14:00:00Z" });
  res.json({ ...q, metrics: { ...q.metrics, balanceDays: { plan: "n/a", baseline: "n/a" } } });
});
app.post("/v1/queues/plan", (req, res) => { try { res.json(planQueue(req.body?.payments ? req.body : { ...DEMO_QUEUE, nowUtc: "2026-10-26T14:00:00Z" })); } catch (e: any) { err(res, 422, "INVALID_QUEUE", e.message); } });

const port = Number(process.env.ROUTER_PORT ?? 8404);
app.listen(port, () => console.log(`router on :${port} (optimizer + orchestration; synthetic rates)`));
