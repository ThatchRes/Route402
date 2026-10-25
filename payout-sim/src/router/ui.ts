// Browser API for the demo frontend (served at /app). Mounted BEFORE the router's token check and accepted only from
// this machine (loopback), so the page needs no secret. It reuses the router's own endpoints and the agents' concierge.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadLinked, saveLinked } from "../assistant/linked.js";
import { importFromNessie, seedDemo, writeBack } from "../connectors/nessieImport.js";
import { loadMeta } from "../connectors/nessie.js";
import { importCsv } from "../connectors/csv.js";
import { runPaymentRun } from "../company/paymentRun.js";
import { validate } from "../company/validate.js";
import { loadPayees } from "../company/payees.js";
import * as C from "../company/controls.js";
import { DEMO_COMPANY } from "../company/profile.js";
import { marketSummary } from "./market.js";
import { OFFRAMPS, PLATFORM, SOURCES } from "./registry.js";
import { optimize } from "./optimizer.js";
import { load } from "./store.js";
import { deliveryCondition, documentsCondition, enforcementOn } from "../company/conditions.js";
import { cleanTerms, DOC_LABEL, EBL_PLATFORMS, lcComparison, simulateCarrierIssue, verifyDocuments } from "../company/documents.js";
import { cleanTokenizedConfig, setTokenizedConfig, TOKENIZED_CATALOG, tokenizedConfig, tokenizedUnavailable } from "./tokenized.js";
import { cleanCompliance, coinsOf, complianceChecks, compliancePolicy, railOf, sanctionsList, STABLECOINS, travelRuleRecord } from "./compliance.js";
import { kybFor, recordKyb } from "../company/kyb.js";
import { monitorRequest } from "../company/monitoring.js";
import { pain001, readiness } from "../company/iso20022.js";
import { RAILS, TOKENIZED_NETWORKS, tokenizedQuote } from "./rails.js";
import { usdcPeg, usdcInFlight, usdcRouteAllowed, stablecoinPlanAllowed, issuerInFlight, issuerHeadroom } from "./depeg.js";
import { allInCost, fxRisk, sendBy, transitDays } from "../company/economics.js";
import { midInfo, rateHistory } from "./market.js";
import { planningNow } from "./timing.js";
import { executionPolicy, planForDispatch, validateDispatchDecision, providerForAllocations, reviewedRouteIds } from "./dispatch.js";
import { confirmSupplier, conversationView, ConversationConflict } from "../assistant/conversation.js";
import { supplierDirectory } from "../company/suppliers.js";
import { publicData, validateChatRequest } from "../assistant/safety.js";
import { recordUiReview, reviewedIntent, trustedUiDecision } from "../assistant/reviews.js";
import { browserSecurity, browserRateLimit } from "./browserSecurity.js";
import { cleanAdaptiveExposure } from "./exposure.js";
import { exposureContext } from "./exposureState.js";
import type { Intent } from "./optimizer.js";
import { mountAsi } from "./asi.js";

const NOW = planningNow;
const PAID = "data/executed.json";
const loadPaid = (): Record<string, any> => (existsSync(PAID) ? JSON.parse(readFileSync(PAID, "utf8")) : {});
const savePaid = (m: Record<string, any>) => { mkdirSync("data", { recursive: true }); writeFileSync(PAID, JSON.stringify(m, null, 2)); };

const mask = (b: any) => { const a = String(b.iban ?? b.accountNumber ?? b.usdcWallet ?? "").replace(/\s+/g, ""); return a ? `${a.slice(0, 2)}•• •••• ${a.slice(-4)}` : "no account on file"; };

export function mountUi(app: express.Express, port: number, reprice?: (intent: Intent, excludeRequestId?: string) => any) {
  C.reconcileApprovalPolicy();
  const self = async (method: string, p: string, body?: any, extra: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, body: body ? JSON.stringify(body) : undefined,
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ROUTER_TOKEN ?? "dev-token"}`, ...extra } });
    const json = await r.json();
    if (!r.ok) throw new Error(json.message ?? json.error ?? `router HTTP ${r.status}`);
    return json;
  };
  // Release-on-delivery escrow service (x402-spike: npm run escrow), internal token like the agent wallet
  const esc = async (method: string, p: string, body?: any) => {
    const r = await fetch(`${process.env.ESCROW_URL ?? "http://127.0.0.1:8416"}${p}`, { method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.X402_INTERNAL_TOKEN ?? ""}` } });
    const j: any = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? `escrow HTTP ${r.status}`); return j;
  };
  // The payment-run plan for all open bills takes ~1.3 s to compute and only changes when the company's data does, so the
  // dashboard reuses it for the same input (bills, balances, settings) for up to 2 minutes. The planning clock (nowUtc)
  // is left out of the key: it changes on every call, and two minutes of drift does not change a plan's timing meaningfully.
  let runCache: { key: string; at: number; run: any } | null = null;
  const paymentRun = (input: any) => {
    const budget = exposureContext();
    const key = JSON.stringify({ ...input, nowUtc: undefined, exposureBudget: budget });
    if (runCache?.key === key && Date.now() - runCache.at < 120_000) return runCache.run;
    const run = runPaymentRun(input, { exposureContext: budget }); runCache = { key, at: Date.now(), run }; return run;
  };
  // Escrow status for the dashboard, cached: on Windows a refused localhost connection takes ~2 s to fail, and every page
  // load used to wait for it when the escrow service is not running. After the first check, the last status is served at
  // once and refreshed in the background (every 15 s when up, 30 s when down). Escrow actions themselves never use this.
  let escrowCache: { at: number; ttl: number; value: any } | null = null, escrowRefresh: Promise<any> | null = null;
  const escrowStatus = async () => {
    const refresh = () => (escrowRefresh ??= esc("GET", "/escrow/status")
      .catch((e) => ({ ready: false, note: `escrow service not reachable (${e.cause?.code ?? e.message})` }))
      .then((value) => { escrowCache = { at: Date.now(), ttl: value.ready === false && value.note ? 30_000 : 15_000, value }; escrowRefresh = null; return value; }));
    if (!escrowCache) return refresh();
    if (Date.now() - escrowCache.at >= escrowCache.ttl) void refresh();
    return escrowCache.value;
  };
  app.use("/app", browserSecurity, express.static(fileURLToPath(new URL("../../public/", import.meta.url))));
  app.get("/", browserSecurity, (_req, res) => res.redirect("/app/"));
  const ui = express.Router();
  ui.use(browserSecurity);
  ui.use((_req, res, next) => { const json = res.json.bind(res); res.json = (body: any) => json(publicData(body)); next(); });
  ui.use(["/ask", "/review"], browserRateLimit(30));
  ui.use(["/login", "/login/code"], browserRateLimit(15));

  // Everything the dashboard shows: connection, bills, checks, market data, sources, recent transfers
  ui.get("/state", async (_req, res) => {
    const l = loadLinked(), paid = loadPaid(), db = load(), pol = C.loadPolicy();
    const run = paymentRun(l.input);
    // FX risk on what is still to be bought in foreign currency (after paying from existing balances)
    const H = l.input.company.homeCcy;
    const exposures = run.lines.filter((x: any) => x.ccy && x.ccy !== H && Number(x.convertedAmount) > 0 && !paid[`${l.input.company.companyId}:${x.payable}`])
      .map((x: any) => ({ ccy: x.ccy, amountUsd: Number(x.convertedAmount) / Number(midInfo(x.ccy).rate), dueUtc: x.deadlineUtc }));
    const [peg, escrow] = await Promise.all([usdcPeg(pol), escrowStatus()]);
    const bills = l.input.payables.map((p) => {
      const v = validate(p.beneficiary), line = run.lines.find((x: any) => x.payable === p.id);
      return { id: p.id, supplier: p.beneficiary.name, country: p.beneficiary.country, ccy: p.ccy, amount: p.amount, dueUtc: p.dueUtc,
        acceptsUsdc: !!p.beneficiary.usdcWallet, ready: readiness(p.beneficiary), check: v.status, issues: [...v.errors, ...v.warnings], detailsChanged: (v as any).detailsChanged,
        plan: line?.status ? "blocked" : line?.route ?? null, fromWallet: line?.fromWallet, paid: paid[`${l.input.company.companyId}:${p.id}`] ?? null };
    });
    res.json({ localSimulation: process.env.LOCAL_ROUTING === "1", connected: !l.source.startsWith("demo company"), source: l.source, linkedAt: l.linkedAt, usdAvailable: l.usdAvailable,
      company: l.input.company.name, bills, receivables: l.input.receivables, run, market: marketSummary(), sources: SOURCES,
      suppliers: supplierDirectory(l),
      payeesOnFile: Object.keys(loadPayees()).length, rails: RAILS, tokenizedNetworks: TOKENIZED_NETWORKS, policy: pol,
      tokenized: { catalog: TOKENIZED_CATALOG, config: tokenizedConfig() }, compliance: { policy: compliancePolicy(pol), stablecoins: STABLECOINS, kyb: kybFor(l.input.company.companyId),
        offramps: OFFRAMPS.map((o) => ({ id: o.id, label: o.label })),
        screening: sanctionsList() ? { mode: "list", names: sanctionsList()!.names.size } : process.env.OPENSANCTIONS_API_KEY ? { mode: "service", names: null } : { mode: "none", names: null } },
      documents: { platforms: EBL_PLATFORMS, labels: DOC_LABEL },
      fxRisk: fxRisk(exposures, rateHistory(), Date.now(), pol.fxRiskLimitUsd), costOfCashPct: l.input.company.costOfCashPct,
      usdc: { peg, inFlightUsd: usdcInFlight(), capUsd: C.issuerCapFor(pol, "Circle"), byIssuer: issuerInFlight() }, escrow,
      exposureBudget: exposureContext(pol),
      transfers: Object.values(db.transfers).slice(-20).reverse().map((t: any) => ({ transferId: t.transferId, status: t.status,
        reference: t.terms.intent.reference, supplier: t.terms.intent.beneficiary?.name, debit: t.terms.totals.sourceDebit, credit: t.terms.totals.recipientNet })) });
  });

  // "Connect your bank": Capital One (Nessie sandbox) live, or an accounting export (CSV)
  ui.post("/connect", async (req, res) => {
    try {
      const { provider, customerId, csv } = req.body ?? {};
      if (provider === "nessie") {
        let id = customerId || Object.keys(loadMeta()).find((k) => k.startsWith("customer:"))?.split(":")[1];
        if (!id) id = (await seedDemo(false)).customerId;
        const imp = await importFromNessie(id, DEMO_COMPANY, NOW());
        saveLinked({ source: `Nessie customer ${id}`, linkedAt: new Date().toISOString(), usdAvailable: imp.usdAvailable, input: imp.input });
        return res.json({ ok: true, source: "Capital One", imported: imp.imported, usdAvailable: imp.usdAvailable });
      }
      if (provider === "csv" && typeof csv === "string") {
        const imp = importCsv(csv, DEMO_COMPANY, NOW());
        saveLinked({ source: "CSV upload", linkedAt: new Date().toISOString(), input: imp.input });
        return res.json({ ok: true, source: "CSV upload", imported: imp.imported, problems: imp.problems });
      }
      res.status(400).json({ ok: false, error: "provider must be nessie or csv" });
    } catch (e: any) { res.status(502).json({ ok: false, error: String(e.message ?? e).slice(0, 300) }); }
  });

  // Prompt -> the Fetch.ai concierge (agents buy quotes + screens with x402, then approve/hold)
  ui.post("/ask", async (req, res) => {
    try { validateChatRequest(req.body); } catch (e: any) { return res.status(422).json({ error: e.message }); }
    const companyId = loadLinked().input.company.companyId;
    try {
      const r = await fetch(`${process.env.AGENT_GATEWAY_URL ?? "http://127.0.0.1:8100"}/ask`, { method: "POST", signal: AbortSignal.timeout(280_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: req.body.text, conversationId: req.body?.conversationId,
          conversationRevision: req.body?.conversationRevision, policy: req.body?.policy || undefined, tenantId: process.env.AGENT_TENANT ?? "demo-tenant",
          correlationId: `ui-${Date.now().toString(36)}`, serviceToken: process.env.AGENT_SERVICE_TOKEN ?? process.env.ROUTER_TOKEN ?? "dev-token" }) });
      const answer: any = await r.json();
      if (loadLinked().input.company.companyId !== companyId) return res.status(409).json({ status: "error", error: "The linked company changed during this request. Open a new chat." });
      if (r.ok) recordUiReview(process.env.AGENT_TENANT ?? "demo-tenant", answer);
      if (r.ok && answer?.hops?.length) answer.agentStats = recordAgentStats(answer);
      res.status(r.ok ? 200 : 502).json(answer);
    } catch (e: any) { res.status(502).json({ status: "error", error: `agents not reachable (${e.cause?.code ?? e.message}): start workers.py and gateway.py` }); }
  });

  // Each agent's working time on one request, and the running average across requests (data/agent-stats.json)
  function recordAgentStats(a: any) {
    const hops: any[] = a.hops ?? [], ms = (pred: (h: any) => boolean) => hops.find(pred)?.ms ?? null;
    const run = { compliance: ms((h) => h.from === "compliance"), routing: ms((h) => h.to === "providers"), total: ms((h) => h.message === "ProcureResult"), paidCalls: (a.paidCalls ?? []).length };
    if (run.total == null) return null;
    const file = "data/agent-stats.json", st = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { runs: 0, compliance: 0, routing: 0, total: 0, paidCalls: 0 };
    const avg = (k: "compliance" | "routing" | "total" | "paidCalls") => run[k] == null ? st[k] : (st[k] * st.runs + run[k]!) / (st.runs + 1);
    const next = { runs: st.runs + 1, compliance: avg("compliance"), routing: avg("routing"), total: avg("total"), paidCalls: avg("paidCalls") };
    mkdirSync("data", { recursive: true }); writeFileSync(file, JSON.stringify(next, null, 2));
    return { run, average: next };
  }

  ui.get("/conversations/:id", (req, res) => {
    try { res.json(conversationView(process.env.AGENT_TENANT ?? "demo-tenant", String(req.params.id))); }
    catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // ---------------------------------------------------------------- sign-in (demo users + one-time code)
  const me = (req: express.Request) => C.sessionUser(req.headers.cookie);
  const publicUser = (u?: C.User) => u && { id: u.id, name: u.name, title: u.title, roles: u.roles, approvalLimitUsd: u.approvalLimitUsd };
  ui.get("/me", (req, res) => res.json({ user: publicUser(me(req)) ?? null, users: C.USERS.map(publicUser), policy: C.loadPolicy() }));
  ui.post("/login/code", (req, res) => {
    const u = C.user(req.body?.userId); if (!u) return res.status(400).json({ error: "unknown user" });
    res.json({ sentTo: `${u.name}'s device`, demoCode: C.issueCode(u.id) });   // demo only: the code is shown on screen
  });
  ui.post("/login", (req, res) => {
    const token = C.signIn(String(req.body?.userId), String(req.body?.code ?? ""));
    if (!token) return res.status(401).json({ error: "code incorrect or expired" });
    C.audit(req.body.userId, "sign_in", "-", "second factor verified");
    res.setHeader("set-cookie", `r402=${token}; HttpOnly; SameSite=Strict; Path=/`); res.json({ user: publicUser(C.user(req.body.userId)) });
  });
  ui.post("/logout", (req, res) => { C.signOut(req.headers.cookie); res.setHeader("set-cookie", "r402=; Max-Age=0; Path=/"); res.json({ ok: true }); });
  const need = (req: express.Request, res: express.Response): C.User | undefined => {
    const u: C.User | undefined = res.locals.asiUser ?? me(req); if (!u) res.status(401).json({ error: "sign in first" }); return u;
  };

  ui.post("/suppliers", (req, res) => {
    const u = need(req, res); if (!u) return;
    if (!C.can(u, "preparer")) return res.status(403).json({ error: "your role cannot add suppliers" });
    if (req.body?.confirmed !== true) return res.status(400).json({ error: "confirm the supplier details before saving" });
    try {
      const result = confirmSupplier(process.env.AGENT_TENANT ?? "demo-tenant", String(req.body?.conversationId), req.body?.conversationRevision, req.body?.details ?? {}, u.id);
      C.audit(u.id, "supplier_created", result.suppliers[0].id, result.suppliers[0].name); res.json({ status: "ok", preview: result, ...result });
    } catch (e: any) { res.status(e instanceof ConversationConflict ? 409 : 422).json({ error: e.message }); }
  });

  ui.post("/policy", (req, res) => {
    const u = need(req, res); if (!u) return;
    if (!C.can(u, "admin")) return res.status(403).json({ error: "admin only" });
    const p = { ...C.loadPolicy(), ...req.body }, before = C.loadPolicy();
    p.dualApprovalOverUsd = C.loadPolicy().dualApprovalOverUsd; p.requoteTolerancePct = Math.max(0, Number(p.requoteTolerancePct));
    p.requireCallbackOnDetailsChange = !!p.requireCallbackOnDetailsChange; p.quoteValidMinutes = Math.min(14, Math.max(0, Number(p.quoteValidMinutes)));
    p.depegBandPct = Math.min(5, Math.max(0.01, Number(p.depegBandPct))); p.depegFailClosed = p.depegFailClosed !== false;
    if (typeof p.issuerCapUsd !== "number" || !Number.isFinite(p.issuerCapUsd) || p.issuerCapUsd < 0 || p.issuerCapUsd > Number.MAX_SAFE_INTEGER)
      return res.status(400).json({ error: "The default issuer cap must be a finite, non-negative USD amount" });
    try { p.issuerCapsUsd = C.cleanIssuerCaps(p.issuerCapsUsd === undefined ? {} : p.issuerCapsUsd); }
    catch (e: any) { return res.status(400).json({ error: e.message }); }
    if ("adaptiveExposure" in (req.body ?? {})) {
      try { p.adaptiveExposure = cleanAdaptiveExposure(req.body.adaptiveExposure); }
      catch (e: any) { return res.status(400).json({ error: e.message }); }
    }
    p.escrowDeadlineDays = Math.min(180, Math.max(0.0001, Number(p.escrowDeadlineDays)));
    p.fxRiskLimitUsd = Math.max(0, Number(p.fxRiskLimitUsd)); p.lcFeePct = Math.min(10, Math.max(0, Number(p.lcFeePct ?? 1)));
    p.compliance = cleanCompliance(p.compliance);
    if ("tokenized" in (req.body ?? {})) {
      const t = cleanTokenizedConfig(req.body.tokenized); if (t.error) return res.status(400).json({ error: t.error });
      p.tokenized = t.config ? { ...t.config, enabledBy: u.id, enabledAt: new Date().toISOString() } : null;
    }
    C.savePolicy(p); setTokenizedConfig(p.tokenized);
    if (JSON.stringify(before.adaptiveExposure) !== JSON.stringify(p.adaptiveExposure))
      C.audit(u.id, "adaptive_exposure_changed", "policy", JSON.stringify(p.adaptiveExposure));
    // Separate entries keep every issuer change readable even when the overall policy exceeds the log's detail limit.
    if (before.issuerCapUsd !== p.issuerCapUsd)
      C.audit(u.id, "issuer_cap_changed", "default", `${before.issuerCapUsd} USD -> ${p.issuerCapUsd} USD (default for issuers without a custom cap)`);
    for (const issuer of new Set([...Object.keys(before.issuerCapsUsd ?? {}), ...Object.keys(p.issuerCapsUsd)])) {
      if (before.issuerCapsUsd?.[issuer] !== p.issuerCapsUsd[issuer])
        C.audit(u.id, "issuer_cap_changed", issuer, `${C.issuerCapFor(before, issuer)} USD -> ${C.issuerCapFor(p, issuer)} USD (${Object.hasOwn(p.issuerCapsUsd, issuer) ? "custom cap" : "default cap"})`);
    }
    C.audit(u.id, "policy_changed", "policy", `${JSON.stringify(before)} -> ${JSON.stringify(p)}`); res.json(p);
  });

  // Company verification: an admin records the KYB result from the partner of record (Route402 does not verify companies itself)
  ui.post("/kyb", (req, res) => {
    const u = need(req, res); if (!u) return;
    if (!C.can(u, "admin")) return res.status(403).json({ error: "admin only" });
    try { const k = recordKyb(loadLinked().input.company.companyId, req.body ?? {}, u.id);
      C.audit(u.id, "kyb_recorded", k.companyId, `${k.status} by ${k.provider} (case ${k.caseRef}); ${k.legalName}, ${k.country} ${k.registrationNumber}; beneficial owners ${k.beneficialOwnersVerified ? "verified" : "not verified"}`);
      res.json(k);
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // ---------------------------------------------------------------- payment requests: prepare -> verify -> approve -> release
  const view = (r: C.PaymentRequest, u?: C.User) => { const p = C.loadPolicy(), n = C.nextActions(r, u, p);
    const transfer = r.transferId ? load().transfers[r.transferId] : null;
    if (transfer) {
      // Render settled/executing terms from the transfer evidence, not stale pre-refresh request fields.
      const plan = transfer.executionPlan ?? transfer.terms;
      r = { ...r, status: transfer.status === "COMPLETED" ? "COMPLETED" : transfer.status === "PAUSED" ? "PAUSED"
        : transfer.status === "NEEDS_RECONCILIATION" ? "FAILED" : r.status, note: transfer.note ?? r.note, deadlineStatus: transfer.deadlineStatus,
        ...(plan?.allocations?.length && plan?.totals ? { provider: providerForAllocations(plan.allocations), route: plan.allocations.map((a: any) => a.routeId).join("+"),
          recipientGets: plan.totals.recipientNet, debitUsd: Number(plan.totals.sourceDebit.split(" ")[0]), arrivalUtc: plan.totals.arrivalUtc } : {}) };
    }
    return { ...r, status: C.computeStatus(r, p), approvalsRequired: C.approvalsRequired(r, p), actions: C.nextActions(r, u, p).actions }; };
  ui.get("/requests", (req, res) => { const u = me(req); res.json(Object.values(C.loadRequests()).reverse().map((r) => view(r, u))); });

  // The preparer turns the agent's paid plan into payment requests. Nothing moves until the company's controls are met.
  const prepareRequest: express.RequestHandler = async (req, res) => {
    const u = need(req, res); if (!u) return;
    if (!C.can(u, "preparer")) return res.status(403).json({ error: "your role cannot prepare payments" });
    if (req.body?.confirmed !== true) return res.status(400).json({ error: "confirm that you checked the supplier, invoice, fees and delivery estimate" });
    if (!Array.isArray(req.body?.decisions) || req.body.decisions.length > 25) return res.status(422).json({ error: "Provide up to 25 reviewed payment choices" });
    let decisions: any[];
    try { decisions = req.body.decisions.map((d: any) => trustedUiDecision(process.env.AGENT_TENANT ?? "demo-tenant", d)); }
    catch (e: any) { return res.status(409).json({ error: e.message }); }
    if (req.body?.conversationId) {
      const conversation = conversationView(process.env.AGENT_TENANT ?? "demo-tenant", req.body.conversationId);
      if (conversation.conversationRevision !== req.body.conversationRevision || (req.body.decisions ?? []).some((d: any) => d.intentId && !conversation.activeIntentIds.includes(d.intentId)))
        return res.status(409).json({ error: "This plan has changed. Ask for a fresh preview in this conversation before preparing it." });
    }
    const l = loadLinked(), co = l.input.company, paid = loadPaid(), reqs = C.loadRequests(), out: any[] = [];
    const kyb = kybFor(co.companyId), pol = C.loadPolicy();
    if (compliancePolicy(pol).requireKyb && kyb?.status !== "verified")
      return res.status(403).json({ error: `${co.name} is not verified yet: an admin must record a verified KYB result from the partner of record in Policy & people before payments can be prepared` });
    const onDelivery = new Set<string>(req.body?.releaseOnDelivery ?? []), documentary = req.body?.documentary ?? {};
    for (const d of decisions) {
      if (!["approve", "review"].includes(d.decision) || !d.intentId) { out.push({ payable: d.payable, skipped: "held by the routing agent" }); continue; }
      const prev = paid[`${co.companyId}:${d.payable}`];
      if (prev && ["COMPLETED", "EXECUTING"].includes(prev.status)) { out.push({ payable: d.payable, skipped: `already ${prev.status.toLowerCase()}` }); continue; }
      if (Object.values(reqs).some((r) => r.payable === d.payable && !["REJECTED", "FAILED"].includes(r.status))) { out.push({ payable: d.payable, skipped: "already has an open payment request" }); continue; }
      const it = await self("GET", `/v1/intents/${d.intentId}`);
      if (loadLinked().input.company.companyId !== co.companyId) return res.status(409).json({ error: "The linked company changed. Review the payment again." });
      if (!it?.intentId) { out.push({ payable: d.payable, skipped: "quote not found on this router: ask again" }); continue; }
      if (it.decision?.status !== "OK") { out.push({ payable: d.payable, skipped: "router has no eligible plan" }); continue; }
      const bill = l.input.payables.find((p) => p.id === d.payable), v: any = bill ? validate(bill.beneficiary) : { warnings: [] };
      let terms: any = null;
      if (documentary[d.payable]) { terms = cleanTerms(documentary[d.payable], it.decision.timing?.deadlineUtc ?? it.intent.deadlineUtc); if (terms.error) { out.push({ payable: d.payable, skipped: terms.error }); continue; } }
      const routeIds = (it.decision.allocations ?? []).map((a: any) => String(a.routeId)).concat(it.decision.allocations ? [] : (d.routeIds ?? []).map(String));
      const ben = it.intent.beneficiary ?? bill?.beneficiary, country = ben?.country ?? bill?.beneficiary.country;
      const record = travelRuleRecord(kyb?.status === "verified" ? { name: kyb.legalName, country: kyb.country, registrationNumber: kyb.registrationNumber, address: kyb.address } : { name: co.name, country: "US" },
        l.source.startsWith("Nessie") ? "Operating account" : "USD operating account", ben, it.decision.totals.sourceDebit, coinsOf(routeIds).join(">") || "USDC");
      const comp = await complianceChecks({ routeKind: railOf(routeIds), coins: coinsOf(routeIds), destCcy: it.intent.destCcy, country,
        supplierWallet: routeIds.some((x: string) => x.includes("supplier_usdc_wallet")) ? ben?.usdcWallet : undefined,
        amountUsd: Number(String(it.decision.totals.sourceDebit).split(" ")[0]), supplierName: ben?.name, routeIds, travelRule: record }, pol);
      if (!comp.ok) { out.push({ payable: d.payable, skipped: comp.reason }); continue; }
      const travel = comp.checks.some((c) => c.id === "travel_rule" && c.status !== "n/a") ? record : undefined;
      const r: C.PaymentRequest = { id: C.newRequestId(), payable: d.payable, supplier: it.intent.beneficiary?.name ?? bill?.beneficiary.name ?? d.payable,
        country: bill?.beneficiary.country ?? "-", ccy: it.intent.destCcy, amount: it.intent.amount, reference: it.intent.reference ?? d.payable,
        intentId: d.intentId, provider: it.decision.allocations?.length ? providerForAllocations(it.decision.allocations) : d.chosen,
        route: routeIds.join("+"), debitUsd: Number(String(it.decision.totals.sourceDebit).split(" ")[0]),
        recipientGets: it.decision.totals.recipientNet, arrivalUtc: it.decision.totals.arrivalUtc, agentReasons: (d.reasons ?? []).filter((x: string) => !x.startsWith("compared:")).slice(0, 4),
        preparedBy: u.id, preparedAt: new Date().toISOString(), detailsChanged: !!v.detailsChanged || !!d.detailsChanged || (d.needs ?? []).some((n: string) => n.includes("call-back")),
        costReview: (d.needs ?? []).some((n: string) => n.includes("cost")), allowReroute: req.body?.allowReroute === true, timing: it.decision.timing,
        fallbackIntentIds: (d.options ?? []).filter((o: any) => o.eligible && o.intentId && o.intentId !== d.intentId).map((o: any) => o.intentId),
        detailsNote: v.warnings?.find((w: string) => w.includes("changed")), approvals: [], releaseOnDelivery: onDelivery.has(d.payable) || !!terms, status: "AWAITING_APPROVAL",
        condition: terms ? documentsCondition(u.id, u.roles[0], terms.presentationDays) : onDelivery.has(d.payable) ? deliveryCondition(u.id, u.roles[0]) : undefined,
        documentary: terms ? { terms, presentations: [] } : undefined, compliance: { checkedAt: new Date().toISOString(), checks: comp.checks, travelRule: travel }, msgId: `R402-${Date.now().toString(36).toUpperCase()}-${d.payable}`.slice(0, 35),
        purpose: String(req.body?.purpose ?? "").slice(0, 120) || "Invoice payment", mode: req.body?.mode === "budget" ? "budget" : "invoice",
        checkedBy: req.body?.confirmed ? { userId: u.id, at: new Date().toISOString() } : undefined,
        platformFee: it.decision.value?.platformFee, feeRule: it.decision.value?.feeRule };
      r.alerts = monitorRequest(r, Object.values(reqs), pol, C.USERS);
      r.status = C.computeStatus(r, pol); reqs[r.id] = r;
      if (r.alerts.length) C.audit("monitoring", "monitoring_alert", r.id, r.alerts.map((a) => `${a.severity}: ${a.detail}`).join("; "));
      C.audit(u.id, "prepared", r.id, `${r.payable} ${r.amount} ${r.ccy} to ${r.supplier} via ${r.provider} (${it.decision.totals.sourceDebit}); agent plan ${r.intentId}${terms ? "; released when the shipping documents verify (instead of a letter of credit)" : r.releaseOnDelivery ? "; release on delivery" : ""}; compliance ${comp.checks.filter((c) => c.status === "pass").length} checks passed`);
      out.push({ payable: d.payable, requestId: r.id, status: r.status });
    }
    C.saveRequests(reqs); res.json({ requests: out });
  };
  ui.post("/requests", prepareRequest);

  const act = (fn: (r: C.PaymentRequest, u: C.User, body: any) => string | null) => async (req: express.Request, res: express.Response) => {
    const u = need(req, res); if (!u) return;
    const reqs = C.loadRequests(), r = reqs[String(req.params.id)]; if (!r) return res.status(404).json({ error: "no such request" });
    const err = fn(r, u, req.body ?? {}); if (err) return res.status(403).json({ error: err });
    r.status = C.computeStatus(r, C.loadPolicy()); reqs[r.id] = r; C.saveRequests(reqs);
    if (r.status === "READY") release(r.id);
    if (r.status === "AWAITING_DELIVERY" && !r.escrow && needsEscrow(r)) lockEscrow(r.id);
    res.json(view(r, u));
  };
  const allowed = (r: C.PaymentRequest, u: C.User, a: string) => (C.nextActions(r, u, C.loadPolicy()).actions as any)[a];

  // Call-back verification: someone other than the preparer phones the supplier on a number ALREADY on file
  ui.post("/requests/:id/callback", act((r, u, b) => {
    const a = allowed(r, u, "callback"); if (!a.allowed) return a.why;
    if (!b.phoneOnFile || !b.contact) return "record the number you dialled (from the vendor master) and who confirmed";
    r.callback = { by: u.id, at: new Date().toISOString(), phoneOnFile: String(b.phoneOnFile).slice(0, 40), contact: String(b.contact).slice(0, 80), outcome: "confirmed" };
    C.audit(u.id, "callback_verified", r.id, `${r.supplier}: new bank details confirmed by ${r.callback.contact} on ${r.callback.phoneOnFile}`); return null;
  }));
  const approveRequest = act((r, u, b) => {
    const a = allowed(r, u, "approve"); if (!a.allowed) return a.why;
    const review = (r.alerts ?? []).filter((x) => x.severity === "review");
    if (review.length && b.alertsReviewed !== true)
      return `review the ${review.length} monitoring alert${review.length === 1 ? "" : "s"} on this payment (${review.map((x) => x.detail).join("; ")}) and approve it from the payment's review screen`;
    if (review.length) { r.alertsReviewed = { by: u.id, at: new Date().toISOString() }; C.audit(u.id, "alerts_reviewed", r.id, review.map((x) => x.detail).join("; ")); }
    r.approvals.push({ by: u.id, at: new Date().toISOString() });
    if (u.owner && u.id === r.preparedBy) C.audit(u.id, "owner_override", r.id, "the owner approved a payment they prepared (segregation of duties skipped by owner authority)");
    C.audit(u.id, "approved", r.id, `approval ${r.approvals.length} of ${C.approvalsRequired(r, C.loadPolicy())} for ${r.debitUsd.toLocaleString()} USD`); return null;
  });
  ui.post("/requests/:id/approve", approveRequest);
  mountAsi(app, { prepare: prepareRequest, approve: approveRequest, view });
  ui.post("/requests/:id/reject", act((r, u, b) => {
    const a = allowed(r, u, "reject"); if (!a.allowed) return a.why;
    r.rejected = { by: u.id, at: new Date().toISOString(), why: String(b.why ?? "").slice(0, 200) }; r.status = "REJECTED";
    C.audit(u.id, "rejected", r.id, r.rejected.why); return null;
  }));
  // Release on delivery: funds are approved but held until receiving confirms the goods (bill of lading / goods receipt)
  ui.post("/requests/:id/delivery", act((r, u, b) => {
    const a = allowed(r, u, "confirmDelivery"); if (!a.allowed) return a.why;
    if (!b.documentRef) return "enter the bill of lading or goods-receipt number";
    r.delivery = { by: u.id, at: new Date().toISOString(), documentRef: String(b.documentRef).slice(0, 60) };
    if (r.condition) r.condition.met = { ...r.delivery };
    C.audit(u.id, "delivery_confirmed", r.id, `${r.delivery.documentRef}: release condition met`); return null;
  }));

  // Documents presented for a document-checked payment (in place of a letter of credit). Each presentation is kept with its
  // checks; the payment is released only when every check passes, the moment it does (no five-day bank examination).
  ui.post("/requests/:id/documents", act((r, u, b) => {
    const a = allowed(r, u, "presentDocuments"); if (!a.allowed) return a.why;
    if (!r.documentary) return "this payment has no document check";
    const res = verifyDocuments({ eblRef: String(b.eblRef ?? ""), platform: String(b.platform ?? ""), invoiceRef: String(b.invoiceRef ?? ""), inspectionRef: b.inspectionRef ? String(b.inspectionRef) : undefined },
      { supplier: r.supplier, buyer: loadLinked().input.company.name, invoiceRef: r.reference, terms: r.documentary.terms });
    r.documentary.presentations.push({ by: u.id, at: new Date().toISOString(), eblRef: String(b.eblRef ?? "").slice(0, 40), platform: String(b.platform ?? ""), ok: res.ok, checks: res.checks, simulated: res.simulated });
    if (res.ok) {
      r.delivery = { by: u.id, at: new Date().toISOString(), documentRef: String(b.eblRef).slice(0, 60) };
      if (r.condition) r.condition.met = { ...r.delivery };
      C.audit(u.id, "documents_verified", r.id, `eBL ${r.delivery.documentRef} and ${r.documentary.terms.documents.length - 1} other document(s) verified (simulated eBL platform); release condition met`);
    } else C.audit(u.id, "documents_rejected", r.id, res.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join("; ").slice(0, 380));
    return null;
  }));
  // Demo only: the supplier's carrier issues the eBL and endorses title to the company, as a live eBL platform would report
  ui.post("/requests/:id/ebl-demo", (req, res) => {
    const u = need(req, res); if (!u) return;
    const r = C.loadRequests()[String(req.params.id)]; if (!r?.documentary) return res.status(404).json({ error: "no document-checked payment" });
    const rec = simulateCarrierIssue({ supplier: r.supplier, buyer: loadLinked().input.company.name, invoiceRef: r.reference, platform: req.body?.platform,
      withInspection: r.documentary.terms.documents.includes("inspection_certificate") });
    C.audit(u.id, "ebl_simulated", r.id, `${rec.ref} issued by a simulated carrier on ${rec.platform}`); res.json(rec);
  });
  // What the same payment would have cost as a letter of credit (company's own LC fee setting)
  ui.get("/requests/:id/lc-comparison", (req, res) => {
    const r = C.loadRequests()[String(req.params.id)]; if (!r) return res.status(404).json({ error: "no such request" });
    res.json(lcComparison(r.debitUsd, C.loadPolicy().lcFeePct));
  });
  // Stablecoin transfers with the fields digital-asset tax reporting asks for (Form 1099-DA, CARF/DAC8), as CSV
  ui.get("/compliance/tax-report.csv", (req, res) => {
    const u = need(req, res); if (!u) return;
    if (!C.can(u, "approver")) return res.status(403).json({ error: "only approvers and admins can export the tax report" });
    const rows = Object.values(C.loadRequests()).filter((r) => r.route?.includes("coin:") && ["COMPLETED", "EXECUTING"].includes(r.status) || (r.route?.includes("coin:") && r.transferId));
    const q = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["date_utc", "payment_request", "transfer", "asset", "amount_usd", "counterparty", "counterparty_country", "currency_delivered", "amount_delivered", "purpose", "settlement_proof"];
    const body = rows.map((r) => [r.preparedAt, r.id, r.transferId, coinsOf(r.route.split("+")).join(">"), r.debitUsd.toFixed(2), r.supplier, r.country, r.ccy, r.recipientGets, r.purpose, r.proof].map(q).join(","));
    res.setHeader("content-type", "text/csv"); res.setHeader("content-disposition", "attachment; filename=route402-digital-asset-tax-report.csv");
    res.send([head.join(","), ...body].join("\n"));
  });

  // A paused payment (stablecoin breaker, issuer cap, escrow not ready) can be re-checked by an approver
  ui.post("/requests/:id/recheck", act((r, u) => {
    const a = allowed(r, u, "recheck"); if (!a.allowed) return a.why;
    r.status = "READY"; r.note = undefined; C.audit(u.id, "rechecked", r.id); return null;
  }));
  // Refund an unreleased escrow after its deadline (the contract refuses earlier)
  ui.post("/requests/:id/refund", async (req, res) => {
    const u = need(req, res); if (!u) return;
    const r = C.loadRequests()[String(req.params.id)]; if (!r) return res.status(404).json({ error: "no such request" });
    const a = allowed(r, u, "refund"); if (!a.allowed) return res.status(403).json({ error: a.why });
    try {
      const out = await esc("POST", "/escrow/refund", { requestId: r.id });
      const all = C.loadRequests(), rr = all[r.id]; rr.escrow = { ...rr.escrow!, state: "REFUNDED", refundTx: out.refundTx, explorer: out.explorer ?? rr.escrow!.explorer };
      rr.status = "REFUNDED"; rr.note = "delivery was not confirmed before the escrow deadline: the locked USDC went back to the company"; all[r.id] = rr; C.saveRequests(all);
      C.audit(u.id, "escrow_refunded", r.id, `${out.refundTx}`); res.json(view(rr, u));
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });

  // Escrow: only for release-on-delivery payments on the USDC rail to a supplier wallet
  const walletOf = (r: C.PaymentRequest) => loadLinked().input.payables.find((p) => p.id === r.payable)?.beneficiary.usdcWallet;
  const needsEscrow = (r: C.PaymentRequest) => r.releaseOnDelivery && r.provider === "stablecoin" && !!walletOf(r);
  async function lockEscrow(id: string) {
    const upd = (f: (x: C.PaymentRequest) => void) => { const all = C.loadRequests(); f(all[id]); C.saveRequests(all); return all[id]; };
    const r = C.loadRequests()[id], pol = C.loadPolicy();
    const allocations = load().intents[r.intentId]?.decision?.allocations ?? [];
    const g = allocations.length ? await stablecoinPlanAllowed(allocations, id, undefined, pol.escrowDeadlineDays * 24) : await usdcRouteAllowed(r.debitUsd, id);
    if (!g.ok) { upd((x) => { x.escrow = { chain: "-", contract: "-", lockId: "-", amountUsdc: 0, deadline: "-", state: "FAILED", error: g.reason };
      x.note = `Escrow not locked: ${g.reason}. Release still waits for delivery under Route402's controls.`; }); C.audit("system", "escrow_blocked", id, g.reason!); return; }
    const deadline = new Date(Date.now() + pol.escrowDeadlineDays * 86400e3).toISOString();
    upd((x) => { x.escrow = { chain: "-", contract: "-", lockId: "-", amountUsdc: 0, deadline, state: "LOCKING" }; });
    try {
      const out = await esc("POST", "/escrow/lock", { requestId: id, payee: walletOf(r), deadlineUtc: deadline, condition: r.condition });
      upd((x) => { x.escrow = { chain: out.chain, contract: out.contract, lockId: out.lockId, amountUsdc: out.amountUsdc, deadline, state: "LOCKED", lockTx: out.lockTx, explorer: out.explorer }; });
      C.audit("system", "escrow_locked", id, `${out.amountUsdc} test USDC locked for the supplier until ${deadline.slice(0, 10)} on ${out.chain} (${out.lockTx}); condition hash ${out.onChain?.conditionHash?.slice(0, 18)}`);
    } catch (e: any) {
      upd((x) => { x.escrow = { ...x.escrow!, state: "FAILED", error: e.message }; x.note = `Escrow not locked (${e.message}). Release still waits for delivery under Route402's controls.`; });
      C.audit("system", "escrow_failed", id, e.message);
    }
  }

  // Release a fully approved request: on the agent's quoted plan if still valid; otherwise re-quote the SAME provider and,
  // if the price moved more than the company's tolerance, send it back for approval instead of paying a different amount.
  const releasing = new Set<string>();
  async function release(id: string) {
    if (releasing.has(id)) return; releasing.add(id);
    try { await releaseOne(id); } catch (e: any) {
      const all = C.loadRequests(); if (all[id]) { all[id].status = "PAUSED"; all[id].note = e.message; C.saveRequests(all); C.audit("system", "release_paused", id, e.message); }
    } finally { releasing.delete(id); }
  }
  async function releaseOne(id: string) {
    const r = C.loadRequests()[id], pol = C.loadPolicy(); if (!r || r.status !== "READY") return;
    // save only THIS request, re-reading the file first: other users may be acting on other requests meanwhile
    const saveR = () => { const all = C.loadRequests(); all[id] = r; C.saveRequests(all); };
    const l = loadLinked(), co = l.input.company, key = `${co.companyId}:${r.payable}`, paid = loadPaid();
    if (paid[key] && ["COMPLETED", "EXECUTING"].includes(paid[key].status)) { r.status = "FAILED"; r.note = "already paid (double-payment protection)"; saveR(); return; }
    const pause = (why: string) => { r.status = "PAUSED"; r.note = why; saveR(); C.audit("system", "paused", r.id, why); };
    const original = await self("GET", `/v1/intents/${r.intentId}`);
    const alternatives = r.allowReroute ? await Promise.all((r.fallbackIntentIds ?? []).map((id) => self("GET", `/v1/intents/${id}`))) : [];
    const originalTerms = { intent: original.intent, allocations: original.decision.allocations.map((a: any) => ({ routeId: a.routeId, input: a.quote.input })),
      totals: original.decision.totals, executionPolicy: executionPolicy(original.intent, original.decision, r.allowReroute, alternatives) };
    const current = exposureContext(pol, r.id);
    const check = planForDispatch(originalTerms, NOW(), { exposureContext: current, issuerHeadroomUsd: issuerHeadroom(pol, r.id) });
    if (!check.ok) return pause(`${check.reason}. Nothing new was sent; request a new plan or approval.`);
    // Refresh only within the routes and debit cap the company reviewed. No provider switch or higher debit is implicit.
    // The reviewed route is re-priced first; an allowed backup is used only when that route can no longer pass the checks.
    const requote = async (provider: any, allowedRouteIds: string[]) => {
      const refreshIntent = { ...original.intent, issuerHeadroomUsd: issuerHeadroom(pol, r.id), provider, allowedRouteIds };
      return reprice ? reprice(refreshIntent, r.id) : await self("POST", "/v1/intents", refreshIntent);
    };
    let refreshed = await requote(original.intent.provider, reviewedRouteIds(originalTerms));
    if (r.allowReroute && (refreshed.decision?.status !== "OK" || !validateDispatchDecision(originalTerms, refreshed.decision).ok))
      refreshed = await requote(undefined, originalTerms.executionPolicy.allowedRouteIds);
    if (refreshed.decision?.status !== "OK") return pause(refreshed.decision?.reason ?? "No route can still meet the recipient deadline");
    const finalCheck = validateDispatchDecision(originalTerms, refreshed.decision);
    if (!finalCheck.ok) return pause(`${finalCheck.reason}. Nothing new was sent; review a fresh quote before approving different terms.`);
    const newDebit = Number(refreshed.decision.totals.sourceDebit.split(" ")[0]);
    const intentId = refreshed.intentId;
    Object.assign(r, { intentId, debitUsd: newDebit, provider: providerForAllocations(refreshed.decision.allocations),
      route: refreshed.decision.allocations.map((a: any) => a.routeId).join("+"), recipientGets: refreshed.decision.totals.recipientNet,
      arrivalUtc: refreshed.decision.totals.arrivalUtc, timing: refreshed.decision.timing }); saveR();
    if (r.provider === "stablecoin") {
      // depeg breaker always; issuer cap only if the money is not already sitting in escrow
      const g = r.escrow?.state === "LOCKED" ? { ok: (await usdcPeg(pol)).status !== "paused", reason: (await usdcPeg(pol)).reason } : await stablecoinPlanAllowed(refreshed.decision.allocations, r.id);   // each issuer's legs against its own cap
      if (!g.ok) return pause(`${g.reason ?? "USDC route paused"}. Nothing was sent; an approver can re-check when it clears.`);
      if (r.escrow?.state === "LOCKING") return pause("The escrow lock is still confirming on-chain. Re-check in a moment.");
      if (r.escrow?.state === "LOCKED") {
        try {
          const out = await esc("POST", "/escrow/release", { requestId: r.id, evidence: r.delivery?.documentRef ?? "" });
          r.escrow = { ...r.escrow, state: "RELEASED", releaseTx: out.releaseTx, explorer: out.explorer ?? r.escrow.explorer }; saveR();
          C.audit("system", "escrow_released", r.id, `released to the supplier on delivery ${r.delivery?.documentRef ?? ""} (${out.releaseTx})`);
        } catch (e: any) { return pause(`Escrow release failed (${e.message}). Nothing else was sent.`); }
      }
    }
    const approvers = r.approvals.map((a) => C.user(a.by)?.name ?? a.by).join(" + "), approverIds = r.approvals.map((a) => a.by).join(":");
    const t = await self("POST", "/v1/transfers", { intentId, allowReroute: r.allowReroute }, { "idempotency-key": `ui_${r.id}_${intentId}` });
    await self("POST", `/v1/transfers/${t.transferId}/approvals`, { planVersion: t.planVersion, termsHash: t.termsHash, approver: approverIds });
    await self("POST", `/v1/transfers/${t.transferId}/execute`, { planVersion: t.planVersion, termsHash: t.termsHash }, { "idempotency-key": `exec_${t.transferId}` });
    paid[key] = { transferId: t.transferId, status: "EXECUTING", at: new Date().toISOString() }; savePaid(paid);
    Object.assign(r, { status: "EXECUTING", transferId: t.transferId }); saveR();
    C.audit("system", "sent", r.id, `${t.transferId}: terms ${t.termsHash?.slice(0, 16) ?? "-"} approved by ${approvers}`);
    const meta = loadMeta(), cust = l.source.match(/Nessie customer (\S+)/)?.[1], opAcct = cust ? meta[`customer:${cust}`]?.operatingAccountId : undefined;
    for (let i = 0; i < 150; i++) {
      const st = await self("GET", `/v1/transfers/${t.transferId}`);
      if (!["SCHEDULED", "EXECUTING", "APPROVED"].includes(st.status)) {
        const p2 = loadPaid(); p2[key] = { transferId: t.transferId, status: st.status, at: new Date().toISOString() }; savePaid(p2);
        const all = C.loadRequests(), rr = all[id]; rr.status = st.status === "COMPLETED" ? "COMPLETED" : st.status === "PAUSED" ? "PAUSED" : "FAILED"; rr.deadlineStatus = st.deadlineStatus;
        rr.proof = Object.values<any>(st.steps ?? {}).find((x: any) => x.proofTx)?.explorer;
        if (rr.status === "FAILED") { const bad = Object.entries<any>(st.steps ?? {}).find(([, v]) => v.status !== "CONFIRMED");
          rr.note = `transfer ${st.status}${bad ? `: ${bad[0]} ${bad[1].status}${bad[1].detail ? ` (${String(bad[1].detail).split("\n")[0].slice(0, 140)})` : ""}` : ""}. Nothing was sent twice; resolve it, then re-run.`; }
        all[id] = rr; C.saveRequests(all);
        C.audit("system", st.status === "COMPLETED" ? "completed" : "needs_attention", id, `${t.transferId} ${st.status}${rr.proof ? ` proof ${rr.proof}` : ""}`);
        if (st.status === "COMPLETED" && opAcct && process.env.LOCAL_ROUTING !== "1") await writeBack(opAcct, (st.executionPlan ?? st.terms).totals.sourceDebit.split(" ")[0], t.transferId).catch(() => {});
        return;
      }
      await new Promise((z) => setTimeout(z, 2000));
    }
  }

  // ISO 20022 pain.001 for one payment request: the same instruction a wire or a tokenized-deposit network can take
  ui.get("/requests/:id/iso20022", (req, res) => {
    if (!need(req, res)) return;
    const r = C.loadRequests()[String(req.params.id)]; if (!r) return res.status(404).json({ error: "no such request" });
    const l = loadLinked(), bill = l.input.payables.find((p) => p.id === r.payable);
    if (!bill) return res.status(404).json({ error: "bill not found in the linked data" });
    res.type("application/xml").setHeader("content-disposition", `attachment; filename="${r.msgId ?? r.id}.pain001.xml"`);
    const kyb = kybFor(l.input.company.companyId), verified = kyb?.status === "verified";
    res.send(pain001({ msgId: r.msgId ?? r.id, createdAt: r.preparedAt, debtorName: verified ? kyb!.legalName : l.input.company.name,
      debtorAddress: verified ? { ...kyb!.address, country: kyb!.country } : undefined, debtorAccountRef: "OPERATING-ACCOUNT-ON-FILE",
      executionDate: r.arrivalUtc, endToEndId: r.payable, amount: r.amount, ccy: r.ccy, beneficiary: bill.beneficiary, invoiceRef: r.payable,
      condition: r.condition ? { kind: r.condition.kind, evidence: r.condition.proof.evidence } : null }));
  });

  // Rails and how a condition is enforced on each; tokenized networks with their sources
  ui.get("/rails", (_req, res) => res.json({ rails: RAILS.map((x) => ({ ...x, condition: enforcementOn(x.id) })), networks: TOKENIZED_NETWORKS }));

  // Route explorer for one bill: our rail and the company's bank, priced by the router (free, local), plus the tokenized
  // rail's status. The agents' paid quotes (x402) replace these when an agent run has happened.
  // Route comparison for one bill: our rail and the company's bank, priced by the router (free, local), the tokenized
  // rail's status, and the economics per route. ?mode=budget&usd=10000 fixes what the company sends instead of the invoice.
  ui.get("/routes/:payable", async (req, res) => {
    const l = loadLinked(), bill = l.input.payables.find((p) => p.id === String(req.params.payable));
    if (!bill) return res.status(404).json({ error: "no such bill" });
    const co = l.input.company, bank = co.currentBank, budget = req.query.mode === "budget" && Number(req.query.usd) > 0;
    const due = typeof req.query.due === "string" && !isNaN(Date.parse(req.query.due)) ? new Date(req.query.due).toISOString() : bill.dueUtc;
    const objective = ["cheapest", "fastest", "balanced"].includes(String(req.query.objective)) ? String(req.query.objective) : "balanced";
    const body = { srcCcy: co.homeCcy, destCcy: bill.ccy, amountType: budget ? "SOURCE_FIXED" : "RECIPIENT_FIXED", amount: budget ? Number(req.query.usd).toFixed(2) : bill.amount,
      objective, deadlineUtc: due, reference: bill.id, beneficiary: bill.beneficiary, beneficiaryAcceptsUsdc: !!bill.beneficiary.usdcWallet,
      currentBank: { label: bank.label, fxMarkupBps: bank.fxMarkupBps, wireFeeUsd: bank.wireFeeUsd, businessDays: bank.businessDays, measured: bank.measured } };
    const mid = Number(midInfo(bill.ccy).rate), now = Date.now();
    const one = async (provider: string) => {
      const q = await self("POST", "/v1/provider-quote", { provider, ...body });
      if (q.status !== "OK") return { provider, status: "NO_QUOTE", reason: q.reason, peg: q.peg, compliance: q.compliance };
      const it = await self("GET", `/v1/intents/${q.intentId}`), a = it.decision?.allocations?.[0]?.quote?.input ?? {};
      const youPayUsd = Number(String(q.plan.sourceDebit).split(" ")[0]), getsDest = Number(String(q.plan.recipientNet).split(" ")[0]);
      const legs = it.decision?.allocations ?? [];
      const transferUsd = legs.reduce((s: number, leg: any) => s + Number(leg.quote.fundingFee.minor) / 100, 0);
      const payoutDest = legs.reduce((s: number, leg: any) => s + Number(String(leg.quote.payoutFee.display).split(" ")[0]), 0);
      const payoutUsd = payoutDest / (bill.ccy === "USD" ? 1 : mid);
      const effectiveRate = youPayUsd > transferUsd ? (getsDest + payoutDest) / (youPayUsd - transferUsd) : Number(a.fxRate);
      const atMidUsd = getsDest / mid, days = transitDays(now, q.plan.arrivalUtc);
      const econ = allInCost({ youPayUsd, atMidUsd, amountUsd: atMidUsd, costOfCashPct: co.costOfCashPct, days });
      const platformFeeUsd = Number(String(q.value?.platformFee ?? "0").split(" ")[0]);
      const transitCostUsd = q.selection ? Number(q.selection.timeCostMinor) / 100 : econ.sendingEarlyUsd;
      return { provider, status: "OK", intentId: q.intentId, youPay: q.plan.sourceDebit, supplierGets: q.plan.recipientNet, arrivalUtc: q.plan.arrivalUtc,
        timing: q.timing, simulation: q.simulation, exposure: q.exposure, selection: q.selection, alternatives: q.alternatives,
        capturedAt: it.createdAt, expiresAt: new Date(Date.parse(it.createdAt) + C.loadPolicy().quoteValidMinutes * 60e3).toISOString(),
        costVsMidBps: q.costVsMidBps?.withPlatformFee ?? q.costVsMidBps?.plan, fxRate: effectiveRate, risk: q.risk, routeIds: q.plan.allocations.map((x: any) => x.routeId), compliance: q.compliance,
        routeLabel: q.plan.allocations[0]?.label,
        breakdown: { transferFeeUsd: transferUsd, payoutFeeUsd: payoutUsd, conversionCostUsd: Math.max(0, econ.pricedUsd - transferUsd - payoutUsd), convertedPrincipalUsd: youPayUsd - transferUsd },
        economics: { ...econ, platformFeeUsd, sendingEarlyUsd: transitCostUsd, allInUsd: econ.pricedUsd + platformFeeUsd + transitCostUsd,
          transitDays: days, sendBy: sendBy(due, days), meetsDeadline: Date.parse(q.plan.arrivalUtc) <= Date.parse(due), costOfCashPct: co.costOfCashPct } };
    };
    const tkWhy = tokenizedUnavailable(co.homeCcy, bill.ccy, bill.beneficiary.country);
    const [stablecoin, bankQ, tokenQ] = await Promise.all([one("stablecoin"), one("bank_wire"),
      tkWhy ? Promise.resolve({ ...tokenizedQuote(), reason: tkWhy }) : one("tokenized_deposit")]);
    res.json({ bill: { id: bill.id, supplier: bill.beneficiary.name, country: bill.beneficiary.country, ccy: bill.ccy, amount: bill.amount, dueUtc: due,
      maskedAccount: mask(bill.beneficiary), acceptsUsdc: !!bill.beneficiary.usdcWallet, mode: budget ? "budget" : "invoice", budgetUsd: budget ? Number(req.query.usd) : undefined },
      routes: [stablecoin, { ...bankQ, provider: "bank" }, tokenQ], ready: readiness(bill.beneficiary), sourceAccount: l.source.startsWith("Nessie") ? "Operating account (Capital One)" : "USD operating account (demo)" });
  });

  // How a decision was reached, in data the page can show: the bank baseline it beat, the savings and our fee, the cost
  // against mid-market for both, what was searched and why routes were excluded, and the inputs to the cost model.
  const excludedKind = (reason = "") => /deadline/i.test(reason) ? "would arrive after the deadline" : /capacity/i.test(reason) ? "more than the route can carry"
    : /peg|stable/i.test(reason) ? "stablecoin too far from its peg" : "not available for this payment";
  function analysisOf(it: any, costOfCashPct: number) {
    const d = it.decision, cands: any[] = d.candidates ?? [], railOf2 = (id: string) => id.startsWith("coin:") ? "stablecoin" : id.startsWith("tokenized:") ? "tokenized deposit" : "bank wire";
    const excluded: Record<string, number> = {};
    for (const c of cands.filter((x) => !x.eligible)) excluded[excludedKind(c.reason)] = (excluded[excludedKind(c.reason)] ?? 0) + 1;
    return { baseline: d.baseline ? { label: d.baseline.label, sourceDebit: d.baseline.sourceDebit, recipientNet: d.baseline.recipientNet, arrivalUtc: d.baseline.arrivalUtc } : null,
      value: d.value ?? null, costVsMidBps: d.costVsMidBps ?? null, objective: d.objective, plannedAtUtc: d.timing?.plannedAtUtc, provenance: d.provenance,
      alternatives: { cheapest: d.cheapest, fastest: d.fastest, balanced: d.balanced }, selection: d.selection, search: d.search,
      searched: { routes: cands.length, eligible: cands.filter((x) => x.eligible).length, rails: [...new Set(cands.map((x) => railOf2(String(x.routeId))))],
        networks: [...new Set(cands.map((x) => String(x.routeId)).filter((x) => x.startsWith("coin:")).map((x) => x.split(":")[2]))], excluded, unpriced: (d.unpriced ?? []).length },
      model: { mid: midInfo(it.intent.destCcy).rate, midSource: midInfo(it.intent.destCcy).source, costOfCashPct, timeValueBpsPerDay: (it.intent.costOfCashPct ?? costOfCashPct) * 100 / 365,
        feeRule: d.value?.feeRule ?? null } };
  }
  // Savings growth: what each open bill is projected to save against the bank wire once paid on its best route (the router's
  // own model, before the live safety gates), plus the realized savings of completed requests. Cached like the payment run.
  let growthCache: { key: string; at: number; value: any } | null = null;
  ui.get("/growth", (_req, res) => {
    const l = loadLinked(), co = l.input.company, reqs = Object.values(C.loadRequests()), db = load();
    const budget = exposureContext();
    const key = JSON.stringify({ ...l.input, nowUtc: undefined, budget, reqs: reqs.map((r) => [r.id, r.status, r.transferId]) });
    if (growthCache?.key === key && Date.now() - growthCache.at < 120_000) return res.json(growthCache.value);
    const started = new Set(reqs.filter((r) => !["REJECTED", "REFUNDED"].includes(r.status)).map((r) => r.payable));
    const open = l.input.payables.filter((b) => !started.has(b.id)), blocked = open.filter((b) => validate(b.beneficiary).status === "BLOCK").length;
    const projected = open.filter((b) => validate(b.beneficiary).status !== "BLOCK").map((b) => {
      try {
        const d: any = optimize({ srcCcy: co.homeCcy, destCcy: b.ccy, amountType: "RECIPIENT_FIXED", amount: b.amount, objective: "balanced", costOfCashPct: co.costOfCashPct, deadlineUtc: b.dueUtc,
          beneficiary: b.beneficiary, beneficiaryAcceptsUsdc: !!b.beneficiary.usdcWallet, currentBank: { ...co.currentBank, measured: true }, exposureContext: budget } as any);
        if (d.status !== "OK") return null;
        const saved = Number(String(d.value.customerNetSaving).split(" ")[0]), faster = d.baseline ? (Date.parse(d.baseline.arrivalUtc) - Date.parse(d.totals.arrivalUtc)) / 86400e3 : 0;
        return { bill: b.id, supplier: b.beneficiary.name, payOnUtc: b.dueUtc, savedUsd: Math.max(0, saved), daysFaster: Math.max(0, faster), route: d.allocations[0]?.routeId };
      } catch { return null; }
    }).filter(Boolean).sort((a: any, b: any) => a.payOnUtc.localeCompare(b.payOnUtc));
    const realized = reqs.filter((r) => r.transferId && db.transfers[r.transferId]?.status === "COMPLETED").map((r) => {
      const d = db.intents[r.intentId]?.decision, t = db.transfers[r.transferId!];
      return { id: r.id, supplier: r.supplier, at: t.history?.findLast?.((h: any) => h.status === "COMPLETED")?.at ?? r.preparedAt, savedUsd: Math.max(0, Number(String(d?.value?.customerNetSaving ?? "0").split(" ")[0])) };
    }).sort((a, b) => a.at.localeCompare(b.at));
    const value = { realized, projected, open: { bills: open.length, blocked, noRoute: open.length - blocked - projected.length }, totals: { realizedUsd: realized.reduce((s, x) => s + x.savedUsd, 0), projectedUsd: projected.reduce((s: number, x: any) => s + x.savedUsd, 0),
      fasterBills: projected.filter((x: any) => x.daysFaster > 0.04).length, avgDaysFaster: (() => { const f = projected.filter((x: any) => x.daysFaster > 0.04); return f.length ? f.reduce((s: number, x: any) => s + x.daysFaster, 0) / f.length : 0; })() } };
    growthCache = { key, at: Date.now(), value }; res.json(value);
  });

  // Every payment request with the savings and time its decision measured against the bank baseline (impact charts)
  ui.get("/impact", (_req, res) => {
    const db = load(), rows = Object.values(C.loadRequests()).filter((r) => !["REJECTED", "REFUNDED"].includes(r.status)).map((r) => {
      const d = db.intents[r.intentId]?.decision, t = r.transferId ? db.transfers[r.transferId] : null, b = d?.baseline;
      // like for like: the route's estimated arrival against the bank's estimated arrival (simulated payouts credit instantly)
      const ours = d?.totals?.arrivalUtc ?? r.arrivalUtc, planned = d?.timing?.plannedAtUtc ?? r.preparedAt;
      return { id: r.id, supplier: r.supplier, provider: r.provider, status: t?.status === "COMPLETED" ? "COMPLETED" : r.status, preparedAt: r.preparedAt,
        completedAt: t?.status === "COMPLETED" ? (t.history?.findLast?.((h: any) => h.status === "COMPLETED")?.at ?? t.creditedAtUtc ?? null) : null,
        debitUsd: r.debitUsd, savedUsd: d?.value ? Number(String(d.value.customerNetSaving).split(" ")[0]) : 0,
        bankDebitUsd: b ? Number(String(b.sourceDebit).split(" ")[0]) : null, bankDays: b?.arrivalUtc ? (Date.parse(b.arrivalUtc) - Date.parse(planned)) / 86400e3 : null,
        ourDays: ours ? Math.max(0, (Date.parse(ours) - Date.parse(planned)) / 86400e3) : null, routesCompared: (d?.candidates ?? []).length,
        bpsOurs: d?.costVsMidBps?.plan ?? null, bpsBank: d?.costVsMidBps?.bank ?? null };
    }).sort((a, b) => a.preparedAt.localeCompare(b.preparedAt));
    res.json({ payments: rows });
  });

  // Read-only priced terms of a quote the agents returned to this workspace, or one a payment request is bound to
  // (Agent home proposal card, Review & approve). Never prices anything new: amounts, fees and rates come from the stored intent.
  ui.get("/quotes/:intentId", async (req, res) => {
    const id = String(req.params.intentId);
    if (!reviewedIntent(process.env.AGENT_TENANT ?? "demo-tenant", id) && !Object.values(C.loadRequests()).some((r) => r.intentId === id))
      return res.status(404).json({ error: "no current agent review for this quote" });
    const it = await self("GET", `/v1/intents/${encodeURIComponent(id)}`).catch(() => null), d = it?.decision;
    if (!d || d.status !== "OK") return res.status(404).json({ error: "quote not found on this router: ask again" });
    const l = loadLinked(), ben = it.intent.beneficiary ?? {};
    res.json({ intentId: id, capturedAt: it.createdAt, expiresAt: new Date(Date.parse(it.createdAt) + C.loadPolicy().quoteValidMinutes * 60e3).toISOString(),
      sourceDebit: d.totals.sourceDebit, recipientNet: d.totals.recipientNet, arrivalUtc: d.totals.arrivalUtc, deadlineUtc: d.timing?.deadlineUtc ?? null,
      amountType: it.intent.amountType, simulation: !!d.simulation, plan: d.plan, reference: it.intent.reference ?? null, exposure: d.exposure,
      recipient: { name: ben.name ?? null, country: ben.country ?? null, ccy: it.intent.destCcy, maskedAccount: mask(ben) },
      sourceAccount: l.source.startsWith("Nessie") ? "Operating account (Capital One)" : `${l.input.company.homeCcy} operating account (demo)`,
      legs: d.allocations.map((a: any) => ({ label: a.label, routeId: a.routeId, arrivalUtc: a.arrivalUtc, sourceDebit: a.quote.sourceDebit.display,
        fundingFee: a.quote.fundingFee.display, payoutFee: a.quote.payoutFee.display, funded: a.quote.funding.display, onrampRate: a.quote.funding.rate,
        fxRate: a.quote.converted.rate, converted: a.quote.converted.display, recipientNet: a.quote.recipientNet.display })),
      platformFee: d.value?.platformFee ?? null, feeRule: d.value?.feeRule ?? null,
      analysis: analysisOf(it, l.input.company.costOfCashPct) });
  });

  // Agents for ONE payment (compare step): paid quotes from both providers + supplier screen, via the concierge's /review
  ui.post("/review", async (req, res) => {
    const l = loadLinked(), bill = l.input.payables.find((p) => p.id === String(req.body?.payable));
    if (!bill) return res.status(404).json({ status: "error", error: "no such bill" });
    const bank = l.input.company.currentBank, budget = req.body?.mode === "budget" && Number(req.body?.usd) > 0;
    try {
      const r = await fetch(`${process.env.AGENT_GATEWAY_URL ?? "http://127.0.0.1:8100"}/review`, { method: "POST", signal: AbortSignal.timeout(280_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: process.env.AGENT_TENANT ?? "demo-tenant", correlationId: `ui-${Date.now().toString(36)}`,
          serviceToken: process.env.AGENT_SERVICE_TOKEN ?? process.env.ROUTER_TOKEN ?? "dev-token", homeCcy: l.input.company.homeCcy, policy: req.body?.policy || undefined,
          currentBank: { label: bank.label, fxMarkupBps: bank.fxMarkupBps, wireFeeUsd: bank.wireFeeUsd, businessDays: bank.businessDays, measured: bank.measured },
          payments: [{ payable: bill.id, destCcy: bill.ccy, amount: budget ? Number(req.body.usd).toFixed(2) : bill.amount, amountType: budget ? "SOURCE_FIXED" : "RECIPIENT_FIXED",
            deadlineUtc: req.body?.due ?? bill.dueUtc, beneficiary: bill.beneficiary, reference: bill.id }] }) });
      const answer: any = await r.json();
      if (loadLinked().input.company.companyId !== l.input.company.companyId) return res.status(409).json({ status: "error", error: "The linked company changed. Review the payment again." });
      if (r.ok) recordUiReview(process.env.AGENT_TENANT ?? "demo-tenant", answer);
      res.status(r.ok ? 200 : 502).json(answer);
    } catch (e: any) { res.status(502).json({ status: "error", error: `agents not reachable (${e.cause?.code ?? e.message}): start workers.py and gateway.py` }); }
  });

  ui.get("/audit", (_req, res) => res.json({ verify: C.verifyAudit(), entries: C.loadAudit().slice(-200).reverse() }));

  ui.get("/transfers/:id", async (req, res) => {
    const t = await self("GET", `/v1/transfers/${encodeURIComponent(String(req.params.id))}`);
    if (t.status === "COMPLETED" || t.status === "NEEDS_RECONCILIATION") return res.json({ ...t, receipt: await self("GET", `/v1/transfers/${t.transferId}/receipt`) });
    res.json(t);
  });

  ui.get("/calls", async (_req, res) => {
    try {
      const r = await fetch(`${process.env.AGENT_WALLET_URL ?? "http://localhost:8405"}/calls`, { headers: { authorization: `Bearer ${process.env.X402_INTERNAL_TOKEN ?? ""}` } });
      res.json(await r.json());
    } catch { res.json({ calls: [], note: "agent wallet not reachable" }); }
  });
  app.use("/ui", ui);
}
