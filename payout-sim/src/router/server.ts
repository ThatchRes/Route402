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
import { runNetting } from "../treasury/netting.js";
import { runSweeps } from "../treasury/sweeps.js";
import { evaluate } from "../treasury/rules.js";
import { DEMO_NETTING, DEMO_RULES, DEMO_STATE, DEMO_SWEEPS } from "../treasury/demo.js";
import { runHedge } from "../company/hedge.js";
import { runDiscounts } from "../company/discounts.js";
import { validate as validateBeneficiary } from "../company/validate.js";
import { recordPayment } from "../company/payees.js";
import { DEMO_BENEFICIARIES, DEMO_DISCOUNTS, DEMO_HEDGE, DEMO_RUN } from "../company/demo.js";
import { runPaymentRun } from "../company/paymentRun.js";
import { importCsv } from "../connectors/csv.js";
import { importFromNessie } from "../connectors/nessieImport.js";
import { DEMO_COMPANY } from "../company/profile.js";
import { ask } from "../assistant/prompts.js";
import { loadLinked } from "../assistant/linked.js";
import { fmt, toMinor } from "../money.js";
import { MARKET, marketSummary } from "./market.js";
import { mountUi } from "./ui.js";
import { TOKENS } from "./registry.js";
import { issuerHeadroom, stablecoinPlanAllowed } from "./depeg.js";
import { setTokenizedConfig } from "./tokenized.js";
import { coinsOf, complianceChecks, disallowedCoins, railOf } from "./compliance.js";
import { loadPolicy, loadRequests } from "../company/controls.js";
import { exposureContext } from "./exposureState.js";
import { planningNow } from "./timing.js";
import { executionPolicy, planForDispatch } from "./dispatch.js";
import { askConversation, conversationView, recordConversationReview, ConversationConflict } from "../assistant/conversation.js";
import { validateChatRequest } from "../assistant/safety.js";

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb", strict: true }));
const TOKEN = () => process.env.ROUTER_TOKEN ?? "dev-token";
setTokenizedConfig(loadPolicy().tokenized);   // the bank's tokenized-deposit tariff, if an admin has entered one
// The compliance rules for one decided plan: country, rail, coins, the supplier's wallet when a leg pays it directly
const complianceFor = (it: any, d: any) => {
  const routeIds = (d.allocations ?? []).map((a: any) => String(a.routeId)), kind = railOf(routeIds);
  return complianceChecks({ routeKind: kind, coins: coinsOf(routeIds), destCcy: it.destCcy, country: it.beneficiary?.country,
    supplierWallet: routeIds.some((r: string) => r.includes("supplier_usdc_wallet")) ? it.beneficiary?.usdcWallet : undefined,
    amountUsd: it.srcCcy === "USD" ? Number(String(d.totals.sourceDebit).split(" ")[0]) : 0, supplierName: it.beneficiary?.name }, loadPolicy());
};
const PAYOUT = process.env.PAYOUT_URL ?? "http://localhost:8403";
const PAYOUT_H = () => ({ authorization: `Bearer ${process.env.PAYOUT_INTERNAL_TOKEN ?? "dev-token"}`, "content-type": "application/json" });
const X402_DIR = process.env.X402_DIR ?? path.resolve("..", "x402-spike");
const QUOTE_TTL_MS = 15 * 60e3;
const TREASURY_USD = toMinor(process.env.TREASURY_USD ?? "2000000.00", "USD");      // simulated operating balance
const ID = /^[A-Za-z0-9_\-:.]{1,80}$/;
const now = planningNow;

mountUi(app, Number(process.env.ROUTER_PORT ?? 8404), createIntent);   // same planner for browser release and provider quotes
app.use((req, res, next) => (req.header("authorization") === `Bearer ${TOKEN()}` ? next() : res.status(401).json({ code: "UNAUTHORIZED" })));
const err = (res: express.Response, status: number, code: string, message: string, details?: any) =>
  res.status(status).json({ code, message, details, retryable: false, correlationId: res.req.header("x-correlation-id") });

// ------------------------------------------------------------------ intents + decisions
function currentBudget(excludeRequestId?: string, excludeTransferId?: string) {
  const context = exposureContext(loadPolicy(), excludeRequestId, excludeTransferId);
  return { exposureContext: context, issuerHeadroomUsd: Object.fromEntries(Object.entries(context.hardCapsUsd).map(([iss, cap]) => [iss, Math.max(0, cap - (context.usedUsd[iss] ?? 0))])) };
}
function freshPlan(t: any) {
  const request = Object.values(loadRequests()).find((r) => r.transferId === t.transferId || r.intentId === t.intentId);
  return planForDispatch(t.terms, now(), currentBudget(request?.id, t.transferId));
}
function createIntent(it: Intent, excludeRequestId?: string) {
  it = { ...it, costOfCashPct: loadLinked().input.company.costOfCashPct, ...currentBudget(excludeRequestId), nowUtc: now() }; // backend budgets, company settings and clock
  const decision: any = optimize(it);
  const intentId = `int_${randomUUID().slice(0, 8)}`;
  update((db) => { db.intents[intentId] = { intentId, intent: it, decision, createdAt: now() }; });
  return { intentId, decision };
}
const validIntent = (it: any) => it?.srcCcy && it?.destCcy && it?.amount && ["SOURCE_FIXED", "RECIPIENT_FIXED"].includes(it.amountType);

app.post("/v1/intents", (req, res) => {
  const it: Intent = req.body;
  if (!validIntent(it)) return err(res, 400, "INVALID_INTENT", "srcCcy, destCcy, amount, amountType required");
  try { res.status(201).json(createIntent(it)); } catch (e: any) { return err(res, 422, "INVALID_INTENT", e.message); }
});

// One provider's quote: OUR stablecoin rail, or the company's OWN bank. Each provider service calls this for its own routes only.
// The returned intentId is bound to that provider's plan, so executing it sends exactly what that provider quoted.
const RISK: Record<string, { score: number; why: string }> = {
  bank: { score: 1, why: "your own bank's wire (business days and cut-offs apply)" },
  bank_wire: { score: 1, why: "your own bank's wire (business days and cut-offs apply)" },
  tokenized_deposit: { score: 1, why: "a deposit at your own bank, moved on its ledger 24/7" },
  stablecoin_live: { score: 2, why: "USD stablecoins; USDC-on-Base legs carry an on-chain settlement proof" },
  stablecoin: { score: 3, why: "local stablecoin rail: thinner liquidity, simulated off-ramp" },
};
app.post("/v1/provider-quote", async (req, res) => {
  const { provider, ...it } = req.body ?? {};
  if (!["stablecoin", "bank", "bank_wire", "tokenized_deposit"].includes(provider) || !validIntent(it)) return err(res, 400, "INVALID_INTENT", "provider + intent required");
  let r: any;
  // the stablecoin rail plans within each issuer's remaining room under the cap, splitting across issuers when one is full
  // and skips coins the compliance rules forbid for this supplier; above every allowed issuer's cap, the rest goes by bank wire
  try { r = createIntent({ ...it, provider, objective: it.objective ?? "balanced", ...(provider === "stablecoin"
    ? { issuerHeadroomUsd: issuerHeadroom(), excludeCoins: disallowedCoins(it.beneficiary?.country, loadPolicy()), bankComplement: true } : {}) }); }
  catch (e: any) { return err(res, 422, "INVALID_INTENT", e.message); }
  const d = r.decision;
  if (d.status !== "OK") return res.json({ provider, status: "NO_QUOTE", reason: d.reason || (d.missing ?? []).join("; ") || "no route from this provider",
    deadlineUtc: it.deadlineUtc, earliestArrivalUtc: d.earliestArrivalUtc, excluded: (d.candidates ?? []).map((c: any) => ({ routeId: c.routeId, reason: c.reason })) });
  // Stablecoin safety: depeg circuit breaker + issuer cap. A paused rail returns no quote, so no agent can pick it.
  if (provider === "stablecoin") {
    const g = await stablecoinPlanAllowed(d.allocations);
    if (!g.ok) return res.json({ provider, status: "NO_QUOTE", reason: g.reason, peg: g.peg });
  }
  // Compliance: a plan that breaks a company rule returns no quote, so no agent and no person can pick it
  const compliance = await complianceFor(r.intent ?? it, d);
  if (!compliance.ok) return res.json({ provider, status: "NO_QUOTE", reason: compliance.reason, compliance: compliance.checks });
  // stablecoin risk: USD coins only (USDC/USDG/PYUSD...) = 2; any local-currency coin (thinner liquidity) = 3
  const usdOnly = d.allocations.every((a: any) => !String(a.routeId).includes(">")          // a swap into a local coin
    && (!a.token || TOKENS.find((t) => t.id === a.token)?.peg === "USD"));
  const tokenizedLeg = d.allocations.some((a: any) => String(a.routeId).startsWith("tokenized:"));
  const risk = provider !== "stablecoin" ? (tokenizedLeg ? RISK.tokenized_deposit : RISK[provider]) : usdOnly ? RISK.stablecoin_live : RISK.stablecoin;
  res.json({ provider, status: "OK", intentId: r.intentId, quoteExpiresInSec: 900,
    providerLabel: process.env.LOCAL_ROUTING === "1" ? "Local payout routes (synthetic simulation)"
      : provider === "stablecoin" && d.allocations.some((a: any) => String(a.routeId).startsWith("bank:")) ? "Our stablecoin rail + your bank wire" : tokenizedLeg ? "Your bank (tokenized deposit)" : provider === "stablecoin" ? "Our stablecoin rail" : "Your bank",
    plan: { kind: d.plan, sourceDebit: d.totals.sourceDebit, recipientNet: d.totals.recipientNet, arrivalUtc: d.totals.arrivalUtc,
            allocations: d.allocations.map((a: any) => ({ routeId: a.routeId, label: a.label, x402Executable: a.x402Executable, amount: a.amount, arrivalUtc: a.arrivalUtc })) },
    timing: d.timing, simulation: d.simulation, costVsMidBps: d.costVsMidBps, risk, exposure: d.exposure, selection: d.selection,
    alternatives: { cheapest: d.cheapest, fastest: d.fastest, balanced: d.balanced }, search: d.search, compliance: compliance.checks,
    baseline: d.baseline ? { sourceDebit: d.baseline.sourceDebit, meetsDeadline: d.baseline.meetsDeadline } : null, value: d.value, provenance: d.provenance });
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
  let policy;
  try {
    const fallbackIds = req.body?.allowReroute === true && Array.isArray(req.body?.fallbackIntentIds) ? req.body.fallbackIntentIds : [];
    const alternatives = fallbackIds.map((id: string) => load().intents[id]);
    if (alternatives.some((a: any) => !a)) throw new Error("fallback quote not found");
    policy = executionPolicy(i.intent, i.decision, req.body?.allowReroute === true, alternatives);
  } catch (e: any) { return err(res, 422, "INVALID_FALLBACK", e.message); }
  const terms = { intent: i.intent, allocations: i.decision.allocations.map((a: any) => ({ routeId: a.routeId, input: a.quote.input,
    sourceDebit: a.quote.sourceDebit.display, recipientNet: a.quote.recipientNet.display, exposure: a.exposure })), totals: i.decision.totals,
    executionPolicy: policy, dispatchAtUtc: req.body?.dispatchAtUtc ?? now() };
  const dispatchAtUtc = terms.dispatchAtUtc;
  if (!Number.isFinite(Date.parse(dispatchAtUtc)) || (i.decision.timing?.latestStartUtc && Date.parse(dispatchAtUtc) > Date.parse(i.decision.timing.latestStartUtc)))
    return err(res, 422, "DISPATCH_TOO_LATE", "dispatch must be no later than the route's latest safe start", i.decision.timing);
  const termsHash = createHash("sha256").update(canonical(terms)).digest("hex");
  const transferId = `tr_${randomUUID().slice(0, 8)}`;
  const t = { transferId, intentId: i.intentId, planVersion: 1, termsHash, terms, status: "AWAITING_APPROVAL",
    quoteExpiresAt: new Date(Date.parse(i.createdAt) + QUOTE_TTL_MS).toISOString(), decisionRecordId: i.decision.decisionRecordId,
    dispatchAtUtc, timing: i.decision.timing,
    value: i.decision.value, children: [], steps: {}, history: [{ at: now(), status: "AWAITING_APPROVAL" }] };
  update((db) => { db.transfers[transferId] = t; if (key) db.idem[`create:${key}`] = transferId; });
  res.status(201).json(t);
});

app.post("/v1/transfers/:id/approvals", (req, res) => {
  const t = load().transfers[String(req.params.id)];
  if (!t) return err(res, 404, "NOT_FOUND", "transfer");
  const { planVersion, termsHash, approver } = req.body ?? {};
  if (planVersion !== t.planVersion || termsHash !== t.termsHash) return err(res, 409, "PLAN_CHANGED", "approval must match the displayed plan version and termsHash");
  if (t.status === "APPROVED") return res.json(t);
  if (t.status !== "AWAITING_APPROVAL") return err(res, 409, "INVALID_STATE", `cannot approve a transfer in ${t.status}; inspect existing evidence before a new plan`);
  if (Date.parse(t.quoteExpiresAt) < Date.parse(now())) return err(res, 409, "QUOTE_EXPIRED", "create a new intent for fresh quotes");
  const feasible = freshPlan(t);
  if (!feasible.ok) return err(res, 409, feasible.code!, feasible.reason!);
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
  if (["SCHEDULED", "EXECUTING", "COMPLETED", "PARTIAL", "NEEDS_RECONCILIATION"].includes(t.status)) return res.status(200).json({ ...t, note: "already scheduled/executing/executed: not re-sent" });
  if (t.status !== "APPROVED") return err(res, 409, "NOT_APPROVED", `transfer is ${t.status}`);
  const feasible = freshPlan(t);
  if (!feasible.ok) return err(res, 409, feasible.code!, feasible.reason!);
  // atomic reservation of source funds (simulated treasury), then async execution
  const debitUsd = t.terms.intent.srcCcy === "USD" ? toMinor(t.terms.totals.sourceDebit.split(" ")[0], "USD") : 0n;
  const ok = update((db) => {
    const reserved = BigInt(db.reservedUsdMinor);
    if (reserved + debitUsd + BigInt(db.spentUsdMinor ?? "0") > TREASURY_USD) return false;
    db.reservedUsdMinor = (reserved + debitUsd).toString();
    const x = db.transfers[t.transferId]; x.status = "SCHEDULED"; x.reservedUsdMinor = debitUsd.toString();
    x.history.push({ at: now(), status: "SCHEDULED", note: `reserved ${fmt(debitUsd, "USD")}; dispatch ${x.dispatchAtUtc}` }); return true;
  });
  if (!ok) return err(res, 409, "INSUFFICIENT_FUNDS", "confirmed treasury balance minus reservations is too low");
  res.status(202).json(load().transfers[t.transferId]);
  void dispatchDue().catch((e) => console.error("dispatch check:", e.message));
});

function unreserve(db: ReturnType<typeof load>, t: any) {
  db.reservedUsdMinor = (BigInt(db.reservedUsdMinor) - BigInt(t.reservedUsdMinor ?? "0")).toString(); t.reservedUsdMinor = "0";
}
const dispatching = new Set<string>();
export async function dispatchDue() {
  for (const t of Object.values(load().transfers)) {
    if (t.status !== "SCHEDULED" || Date.parse(t.dispatchAtUtc) > Date.parse(now()) || dispatching.has(t.transferId)) continue;
    dispatching.add(t.transferId);
    try {
      let check = freshPlan(t);
      if (check.ok && check.decision.allocations.some((a: any) => String(a.routeId).startsWith("coin:"))) {
        const request = Object.values(loadRequests()).find((r) => r.transferId === t.transferId || r.intentId === t.intentId);
        const gate = await stablecoinPlanAllowed(check.decision.allocations, request?.id, t.transferId);
        if (!gate.ok) check = { ok: false, code: "RAIL_PAUSED", reason: gate.reason };
      }
      // Compliance again just before money moves (sanctions lists and policy can change after approval)
      if (check.ok) { const c = await complianceFor(t.terms.intent, check.decision); if (!c.ok) check = { ok: false, code: "COMPLIANCE_HOLD", reason: c.reason }; }
      // Recheck after asynchronous rail checks; nothing has been funded yet, so a pause can safely free the reservation.
      if (check.ok) check = freshPlan(t);
      if (!check.ok) {
        update((db) => { const x = db.transfers[t.transferId]; unreserve(db, x); x.status = "PAUSED"; x.note = check.reason;
          x.history.push({ at: now(), status: "PAUSED", code: check.code, note: check.reason }); });
        continue;
      }
      const d = check.decision;
      update((db) => {
        const x = db.transfers[t.transferId]; x.status = "EXECUTING"; x.dispatchedAtUtc = now();
        x.executionPlan = { allocations: d.allocations.map((a: any) => ({ routeId: a.routeId, input: a.quote.input, sourceDebit: a.quote.sourceDebit.display, exposure: a.exposure, arrivalUtc: a.arrivalUtc })), totals: d.totals, timing: d.timing, exposure: d.exposure };
        x.executionQuoteExpiresAt = new Date(Date.parse(now()) + QUOTE_TTL_MS).toISOString();
        x.history.push({ at: now(), status: "EXECUTING", note: "fresh deadline and price check passed; original signed terms retained",
          routeIds: d.allocations.map((a: any) => a.routeId) });
      });
      void execute(t.transferId).catch((e) => update((db) => { const x = db.transfers[t.transferId]; x.status = "NEEDS_RECONCILIATION";
        x.history.push({ at: now(), status: x.status, note: String(e).slice(0, 300) }); }));
    } finally { dispatching.delete(t.transferId); }
  }
}

function setStep(transferId: string, stepId: string, status: string, extra: any = {}) {
  update((db) => { const x = db.transfers[transferId]; x.steps[stepId] = { ...(x.steps[stepId] ?? {}), status, ...extra, at: now() }; });
}

function runX402Fund(childId: string): Promise<{ orderId: string; tx?: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", "src/fund.ts", childId], { cwd: X402_DIR, shell: process.platform === "win32" });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", () => { const last = out.trim().split("\n").reverse().find((l) => /^(NOT_)?FUNDED /.test(l));
      last?.startsWith("FUNDED ") ? resolve({ orderId: last.split(" ")[1], tx: last.split(" ")[2] }) : reject(new Error(`x402 funding failed: ${last ?? out.slice(-300)}`)); });
  });
}

async function execute(transferId: string) {
  const t = load().transfers[transferId];
  for (const [i, a] of (t.executionPlan ?? t.terms).allocations.entries()) {
    const childId = `${transferId}_c${i + 1}`, input = a.input;
    const fundStep = `fund_${i + 1}`, payStep = `payout_${i + 1}`;
    let funding: any;
    const live = input.route === "stablecoin" && input.fundingAsset === "USDC" && (input.network ?? "base") === "base";
    if (live) {
      const rail = "x402 settlement proof: 0.01 test USDC on Base Sepolia (proves the settlement path; not the transfer amount)";
      setStep(transferId, fundStep, "REQUESTED", { rail });
      try { const { orderId, tx } = await runX402Fund(childId); funding = { mode: "x402_testnet", orderId };
        setStep(transferId, fundStep, "CONFIRMED", { rail, orderId, proofTx: tx, explorer: tx ? `https://sepolia.basescan.org/tx/${tx}` : undefined,
          transferAmountRail: `${input.route === "stablecoin" ? "stablecoin" : "bank"} payout of the full amount: simulated` }); }
      catch (e: any) { setStep(transferId, fundStep, "UNKNOWN", { detail: e.message }); throw e; }   // never re-funds blindly
    } else {
      funding = { mode: input.route === "stablecoin" ? "simulated_token" : "simulated_bank" };
      setStep(transferId, fundStep, "CONFIRMED", { rail: `${funding.mode} (labeled simulation)` });
    }
    const deadline = t.terms.intent.deadlineUtc;
    const remaining: any = optimize({ ...t.terms.intent, amount: input.amount, nowUtc: now(), allowedRouteIds: [a.routeId], allowSplit: false });
    if (remaining.status !== "OK") throw new Error(`route can no longer meet its approved deadline after funding: ${remaining.reason}. Reconcile existing funds; do not resend`);
    setStep(transferId, payStep, "REQUESTED");
    // Persist the deterministic child before submission: a crash or timeout after provider acceptance must still be recoverable by reads.
    update((db) => { const x = db.transfers[transferId]; if (!x.children.includes(childId)) x.children.push(childId); });
    const r = await fetch(`${PAYOUT}/payouts`, { method: "POST", headers: { ...PAYOUT_H(), "idempotency-key": `op_${childId}` },
      body: JSON.stringify({ transferId: childId, custom: { ...input, outcome: "delivered" }, quoteExpiresAt: t.executionQuoteExpiresAt ?? t.quoteExpiresAt, funding }) });
    const p = await r.json();
    if (!r.ok && r.status !== 202) { setStep(transferId, payStep, "REJECTED", { detail: p.error }); throw new Error(p.error); }
    setStep(transferId, payStep, p.status === "FUNDING_NOT_CONFIRMED" ? "REJECTED" : "PENDING", { payoutId: p.payoutId });
  }
  await monitorTransfers();
}

let monitoring = false;
export async function monitorTransfers() {
  if (monitoring) return; monitoring = true;
  try { for (const t of Object.values(load().transfers)) {
    if (!["EXECUTING", "NEEDS_RECONCILIATION"].includes(t.status) || !t.children.length) continue;
    const expected = (t.executionPlan ?? t.terms).allocations.length;
    const recs = await Promise.all(t.children.map(async (c: string) => { const r = await fetch(`${PAYOUT}/v1/transfers/${c}/reconciliation`, { headers: PAYOUT_H(), signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error(`reconciliation HTTP ${r.status}`); return r.json(); })).catch(() => null);
    if (!recs) continue; // read failure is never permission to resend
    const reconciled = (r: any) => Array.isArray(r.legs) && r.legs.some((l: any) => l.leg === "beneficiary_credit")
      && r.legs.some((l: any) => l.leg === "ledger_postings") && r.legs.every((l: any) => {
        if (/REJECTED|MISMATCH|UNKNOWN|PENDING/.test(l.status ?? "")) return false;
        if (l.leg === "ledger_postings") return l.observed === "balanced per asset";
        if (l.leg === "chain_settlement") return l.status === "MATCHED";
        if (l.leg === "x402_records") return l.observed === "MATCHED";
        return l.observed != null && l.observed === l.expected;
      });
    const complete = recs.length === expected && recs.every((r: any) => r.status === "DELIVERED" && r.outstanding?.fundedButUnpaid === false && reconciled(r));
    const terminalProblem = recs.some((r: any) => ["PAYOUT_REJECTED", "FUNDING_NOT_CONFIRMED", "PAYOUT_UNKNOWN", "HOLD_QUOTE_EXPIRED"].includes(r.status) || (r.status === "DELIVERED" && !reconciled(r)));
    recs.forEach((r: any, i: number) => setStep(t.transferId, `payout_${i + 1}`, r.status === "DELIVERED" && reconciled(r) ? "CONFIRMED" : r.status === "PAYOUT_UNKNOWN" ? "UNKNOWN" : terminalProblem ? "REVIEW" : "PENDING"));
    update((db) => {
      const x = db.transfers[t.transferId], deadline = x.terms.intent.deadlineUtc;
      const creditTimes = recs.map((r: any) => r.creditedAtUtc).filter((v: any) => typeof v === "string" && Number.isFinite(Date.parse(v)));
      const creditedAtUtc = creditTimes.length === recs.length ? creditTimes.sort().at(-1) : null;
      x.deadlineStatus = !deadline ? "NOT_SET" : complete ? (creditedAtUtc ? (Date.parse(creditedAtUtc) <= Date.parse(deadline) ? "MET" : "MISSED") : "UNVERIFIED")
        : Date.parse(now()) > Date.parse(deadline) ? "OVERDUE" : "IN_PROGRESS";
      x.creditedAtUtc = creditedAtUtc;
      if (complete) {
        const actualDebit = x.terms.intent.srcCcy === "USD" ? toMinor((x.executionPlan ?? x.terms).totals.sourceDebit.split(" ")[0], "USD") : 0n;
        db.spentUsdMinor = (BigInt(db.spentUsdMinor ?? "0") + actualDebit).toString();
        unreserve(db, x); x.status = "COMPLETED"; x.confirmedAtUtc = now();
      }
      else if (terminalProblem) x.status = "NEEDS_RECONCILIATION";
      if (complete || (terminalProblem && t.status !== x.status)) x.history.push({ at: now(), status: x.status, deadlineStatus: x.deadlineStatus });
    });
    if (complete && t.terms.intent.beneficiary?.name) recordPayment(t.terms.intent.beneficiary, t.transferId);
  } } finally { monitoring = false; }
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
  res.json({ transferId: id, status: t.status, reference: t.terms.intent.reference ?? null, supplier: t.terms.intent.beneficiary?.name ?? null,
    plan: t.terms, executionPlan: t.executionPlan, timing: t.timing, dispatchedAtUtc: t.dispatchedAtUtc,
    creditedAtUtc: t.creditedAtUtc, deadlineStatus: t.deadlineStatus, termsHash: t.termsHash, approval: t.approval, value: t.value, children: kids,
    disclosure: `Mid rates: ${MARKET.mode} (ECB reference rates via Frankfurter when live). Bank baseline: measured bank pricing (Wise comparison data) when live. `
      + "Stablecoin rail: sourced fees (Circle Mint redemption terms, network fees); local-coin conversion only at an entered venue quote. Payouts: simulated. Each USDC-on-Base leg carries an x402 settlement proof: "
      + "a real 0.01 test USDC payment on Base Sepolia tied to this transfer's order and reconciled on chain. It proves the settlement path; it is not the transfer amount." });
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
  return { snapshotId: `snap_${Date.now().toString(36)}`, confirmed: { "US-Operating/USD": fmt(TREASURY_USD - BigInt(load().spentUsdMinor ?? "0"), "USD"), "acme-ca/CAD": "15000.00 CAD" },
    reserved: { "US-Operating/USD": fmt(reserved, "USD") }, pendingIncoming: { "acme-ca/CAD": "70000.00 CAD (confirmed, arrives 2026-10-27T15:00Z)" },
    forecast: { "acme-eu/EUR": "40000.00 EUR (forecast only)" }, provenance: "simulated" };
}
app.post("/internal/funding/check", (req, res) => {
  const i = load().intents[String(req.body?.intentId)];
  if (!i || i.decision.status !== "OK") return res.json({ feasible: false, notes: ["no decision for intent"] });
  const inv = inventory(), need = i.intent.srcCcy === "USD" ? toMinor(i.decision.totals.sourceDebit.split(" ")[0], "USD") : 0n;
  const avail = TREASURY_USD - BigInt(load().reservedUsdMinor) - BigInt(load().spentUsdMinor ?? "0");
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

// ------------------------------------------------------------------ treasury (advisory; execution via /v1/transfers)
const safe = (res: express.Response, f: () => any) => { try { res.json(f()); } catch (e: any) { err(res, 422, "INVALID_INPUT", e.message); } };
app.post("/v1/treasury/netting", (req, res) => safe(res, () => runNetting(req.body?.invoices ? req.body : DEMO_NETTING)));
app.post("/v1/treasury/sweeps", (req, res) => safe(res, () => runSweeps(req.body?.accounts ? req.body : DEMO_SWEEPS)));
app.post("/v1/treasury/rules/evaluate", (req, res) => safe(res, () => evaluate(req.body?.rules ?? DEMO_RULES, req.body?.state ?? DEMO_STATE)));

app.get("/v1/market", (_req, res) => res.json(marketSummary()));
app.post("/v1/company/payment-run", (req, res) => safe(res, () => runPaymentRun(req.body?.payables ? req.body : DEMO_RUN, currentBudget())));
// Port company data in: CSV text (accounting export) or a Nessie customer (bank sandbox), then run the payment run.
app.post("/v1/company/import", async (req, res) => {
  try {
    const now = planningNow();
    const imp: any = req.body?.source === "nessie" ? await importFromNessie(String(req.body.customerId), DEMO_COMPANY, now)
      : req.body?.source === "csv" ? importCsv(String(req.body.csv ?? ""), DEMO_COMPANY, now) : null;
    if (!imp) return err(res, 400, "INVALID_SOURCE", "source must be csv or nessie");
    res.json({ imported: imp.imported, problems: imp.problems ?? imp.unmapped ?? [], run: runPaymentRun(imp.input, currentBudget()) });
  } catch (e: any) { err(res, 422, "IMPORT_FAILED", e.message); }
});
// Everyday prompts -> ready-made plan from the linked data (preview only; execution needs approval)
app.post("/v1/assistant/ask", (req, res) => {
  try { validateChatRequest(req.body); res.json(askConversation(req.header("x-tenant-id") ?? "demo-tenant", req.body.text, req.body.conversationId ?? undefined, req.body.conversationRevision)); }
  catch (e: any) { err(res, e instanceof ConversationConflict ? 409 : 422, "CONVERSATION_ERROR", e.message); }
});
app.get("/v1/assistant/conversations/:id", (req, res) => safe(res, () => conversationView(req.header("x-tenant-id") ?? "demo-tenant", String(req.params.id))));
app.post("/v1/assistant/conversations/:id/review", (req, res) => safe(res, () => ({ recorded: recordConversationReview(req.header("x-tenant-id") ?? "demo-tenant", String(req.params.id), req.body?.conversationRevision, (req.body?.decisions ?? []).slice(0, 25)) })));
app.post("/v1/company/hedge", (req, res) => safe(res, () => runHedge(req.body?.payables ? req.body : DEMO_HEDGE)));
app.post("/v1/company/discounts", (req, res) => safe(res, () => runDiscounts(req.body?.payables ? req.body : DEMO_DISCOUNTS)));
app.post("/v1/company/beneficiaries/validate", (req, res) => safe(res, () => (Array.isArray(req.body) && req.body.length ? req.body : DEMO_BENEFICIARIES).map(validateBeneficiary)));

const port = Number(process.env.ROUTER_PORT ?? 8404);
if (process.env.ROUTER_NO_LISTEN !== "1") {
  app.listen(port, process.env.LOCAL_ROUTING === "1" ? "127.0.0.1" : "0.0.0.0", () => console.log(`router on :${port} (optimizer + orchestration; market data: ${MARKET.mode}${process.env.LOCAL_ROUTING === "1" ? "; LOCAL simulation" : ""})`));
  // Recover scheduled work, but never replay an in-flight funding or payout request after a restart.
  update((db) => { for (const t of Object.values(db.transfers)) if (t.status === "EXECUTING") {
    t.status = "NEEDS_RECONCILIATION"; t.history.push({ at: now(), status: t.status, note: "router restarted; inspect existing evidence before any further send" });
  } });
  const tick = () => { void dispatchDue().catch((e) => console.error("dispatch check:", e.message)); void monitorTransfers().catch((e) => console.error("reconciliation check:", e.message)); };
  setInterval(tick, 2000).unref(); tick();
}
