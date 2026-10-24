// Additional ASI:One channel. Existing app assets and payment controls are shared, not replaced.
import express from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as C from "../company/controls.js";
import * as S from "../assistant/asiState.js";
import { loadLinked } from "../assistant/linked.js";
import { conversationView } from "../assistant/conversation.js";
import { recordUiReview, trustedUiDecision } from "../assistant/reviews.js";
import { load } from "./store.js";
import { browserSecurity, browserRateLimit } from "./browserSecurity.js";
import { fmt, toMinor } from "../money.js";

interface SharedControls {
  prepare: express.RequestHandler;
  approve: express.RequestHandler;
  view: (r: C.PaymentRequest, user?: C.User) => any;
}
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const canonical = (x: any): any => Array.isArray(x) ? x.map(canonical) : x && typeof x === "object"
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, canonical(x[key])])) : x;
const termsHash = (intent: any) => hash(canonical({ intent: intent.intent, decision: intent.decision }));
const policyHash = () => hash(canonical(C.loadPolicy()));
const company = () => loadLinked().input.company.companyId;
const tenant = () => process.env.AGENT_TENANT ?? "demo-tenant";
const conversationId = (b: Pick<S.AsiBinding, "tenant" | "sender" | "session" | "companyId">) =>
  `fetch_${hash([b.tenant, b.companyId, b.sender, b.session]).slice(0, 32)}`;
const appBase = () => {
  const url = new URL(process.env.ASI_APP_URL ?? `http://localhost:${process.env.ROUTER_PORT ?? 8404}`);
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)
    || (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    throw new Error("ASI_APP_URL must be an HTTPS app origin, or localhost for the demo.");
  return url.origin;
};

// Invoke the exact same handlers used by the website with server-resolved authority.
// No bearer browser cookie is manufactured or returned to the gateway.
async function invoke(handler: express.RequestHandler, req: express.Request, user: C.User, body: any, params = {}) {
  let result: any, status = 200;
  const inner = Object.assign(Object.create(req), { body, params });
  const response = { locals: { asiUser: user }, status(code: number) { status = code; return this; },
    json(value: any) { result = value; return this; } } as unknown as express.Response;
  await handler(inner, response, (error?: any) => { if (error) throw error; });
  if (status >= 400) throw new Error(result?.error ?? "The company payment controls did not accept this action.");
  return result;
}

const LINK_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ASI:One · Route402</title><style>body{font:15px/1.6 system-ui;color:#183348;background:#fafbf9;margin:0;padding:32px}main{max-width:640px;margin:8vh auto;background:white;border:1px solid #dce3e2;border-radius:12px;padding:28px}h1{font:30px Georgia}p{overflow-wrap:anywhere}small{color:#526b75}button,a{font:inherit}button{padding:10px 18px;background:#277d78;color:white;border:0;border-radius:6px;cursor:pointer}button:disabled{opacity:.5}a{color:#277d78}</style>
<main><h1>Connect this ASI:One conversation</h1><p id="status">Checking your Route402 sign-in…</p>
<p>This lets this specific chat prepare and approve reviewed demo payments using your account. Your role, spending limit, supplier verification and release conditions still apply. The chat must display a payment review before you can accept it.</p>
<p>Supplier payouts and currency conversion are simulated. Quote purchases and supported settlement proofs may use test USDC.</p>
<p id="identity"></p><p><small id="scope"></small></p><button id="connect" disabled>Connect this conversation</button>
<p><a href="/app/" target="_blank" rel="noopener">Sign in to Route402</a> · <a href="/app/#/payments">Open payments</a></p>
<small>Only connect a conversation you started. Signing out of the linked Route402 session revokes this connection. Refresh this page after signing in.</small></main><script src="/asi/link.js"></script></html>`;
const LINK_JS = `"use strict";
const token = location.hash.slice(1);
const statusEl=document.getElementById("status"), button=document.getElementById("connect");
async function call(path,body){const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error||"Could not connect this chat");return v;}
async function check(){try{const v=await call("/ui/asi/link-info",{token});statusEl.textContent="Signed in as "+v.user+" at "+v.company+".";document.getElementById("identity").textContent="Agent sender: "+v.sender;document.getElementById("scope").textContent="Chat session: "+v.session;button.disabled=false;}catch(e){statusEl.textContent=e.message;}}
button.onclick=async()=>{button.disabled=true;try{await call("/ui/asi/link",{token,accepted:true});history.replaceState(null,"",location.pathname);statusEl.textContent="Connected. Return to the same ASI:One conversation and say continue. Review the plan there before replying yes.";}catch(e){statusEl.textContent=e.message;}};check();`;

export function mountAsi(app: express.Express, controls: SharedControls) {
  app.get("/asi/link", browserSecurity, (_req, res) => res.set("Cache-Control", "no-store").type("html").send(LINK_HTML));
  app.get("/asi/link.js", browserSecurity, (_req, res) => res.type("application/javascript").send(LINK_JS));
  const linkBrowser = (accept: boolean): express.RequestHandler => (req, res) => {
    const user = C.sessionUser(req.headers.cookie);
    if (!user) return void res.status(401).json({ error: "Sign in to Route402 in another tab, then refresh this page." });
    try {
      const info = S.describeLink(req.body?.token, company());
      if (!accept) return void res.json({ ...info, user: user.name, company: loadLinked().input.company.name });
      if (req.body?.accepted !== true) throw new Error("Explicitly accept linking this conversation.");
      const fingerprint = S.sessionFingerprint(req.headers.cookie);
      if (!fingerprint) throw new Error("Sign in to Route402 before connecting.");
      const binding = S.completeLink(req.body.token, user.id, fingerprint, company());
      C.audit(user.id, "asi_linked", binding.id, `ASI:One sender ${binding.sender}; session ${binding.session}`);
      res.json({ connected: true });
    } catch (e: any) { res.status(409).json({ error: e.message }); }
  };
  app.post("/ui/asi/link-info", browserSecurity, browserRateLimit(20), linkBrowser(false));
  app.post("/ui/asi/link", browserSecurity, browserRateLimit(10), linkBrowser(true));

  const api = express.Router();
  api.use((req, res, next) => {
    const secret = process.env.AGENT_SERVICE_TOKEN ?? process.env.ROUTER_TOKEN ?? "dev-token";
    const supplied = Buffer.from(req.get("authorization") ?? ""), expected = Buffer.from(`Bearer ${secret}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return void res.status(401).json({ error: "unauthorized" });
    if (req.get("x-tenant-id") !== tenant()) return void res.status(403).json({ error: "tenant not allowed" });
    if (!/^agent1[a-z0-9]{20,100}$/.test(req.body?.sender ?? "")
      || !/^[A-Za-z0-9_-]{8,100}$/.test(req.body?.session ?? ""))
      return void res.status(422).json({ error: "Invalid signed chat sender or session." });
    res.set("Cache-Control", "no-store"); next();
  });
  const bound = (req: express.Request) => S.requireBinding(tenant(), req.body.sender, req.body.session, company(), C.activeSessionFingerprint);
  const wrap = (handler: (req: express.Request, res: express.Response) => Promise<any> | any): express.RequestHandler =>
    async (req, res) => { try { await handler(req, res); } catch (e: any) { res.status(409).json({ error: e.message }); } };
  const pendingView = (binding: S.AsiBinding) => {
    const pending = S.getPending(binding);
    return pending && { id: pending.id, confirmationId: pending.id, state: pending.state, expiresAt: pending.expiresAt };
  };
  api.post("/context", wrap((req, res) => {
    let binding: S.AsiBinding;
    try { binding = bound(req); } catch { return res.json({ linked: false }); }
    res.json({ linked: true, conversationId: conversationId(binding), pending: pendingView(binding) });
  }));
  api.post("/link", browserRateLimit(20), wrap((req, res) => {
    const link = S.beginLink(tenant(), req.body.sender, req.body.session, company());
    res.json({ linkUrl: `${appBase()}/asi/link#${link.token}`, expiresAt: link.expiresAt });
  }));
  api.post("/cancel", wrap((req, res) => {
    const binding = bound(req), pending = S.getPending(binding);
    if (pending && ["processing", "unknown"].includes(pending.state))
      throw new Error("A confirmation may already be processing. Check status before making another payment.");
    if (pending?.state === "ready") S.updatePending(binding, { state: "cancelled" });
    res.json({ message: "The unaccepted chat proposal is closed. Existing submitted payments are unchanged." });
  }));
  api.post("/disconnect", wrap((req, res) => {
    const binding = bound(req); S.revokeBinding(tenant(), binding.sender, binding.session, binding.companyId);
    C.audit(binding.userId, "asi_disconnected", binding.id); res.json({ message: "This ASI:One chat is disconnected." });
  }));
  api.post("/offer", wrap((req, res) => {
    const binding = bound(req), user = C.user(binding.userId)!, answer = req.body.answer;
    const previous = S.getPending(binding);
    if (previous && ["processing", "unknown"].includes(previous.state)) throw new Error("Check the existing confirmation's status first.");
    if (!C.can(user, "preparer")) throw new Error("Your account cannot prepare payments. Use the company app's approval workflow.");
    if (answer?.status !== "ok" || answer.conversationId !== conversationId(binding)
      || !Array.isArray(answer.decisions) || !answer.decisions.length || answer.decisions.length > 25)
      throw new Error("No current payment review is available to accept.");
    if (answer.decisions.some((d: any) => !["approve", "review"].includes(d.decision) || !d.intentId))
      throw new Error("At least one payment is held. Resolve the hold before accepting this run.");
    const conversation = conversationView(tenant(), answer.conversationId);
    if (conversation.conversationRevision !== answer.conversationRevision) throw new Error("The conversation changed. Ask for a new review.");
    recordUiReview(tenant(), answer);
    const decisions = answer.decisions.map((d: any) => trustedUiDecision(tenant(), d));
    if (new Set(decisions.map((d: any) => d.payable)).size !== decisions.length) throw new Error("Review each supplier payment once.");
    const plans: S.AsiPlan[] = [], details: any[] = [];
    for (const d of decisions) {
      if (!conversation.activeIntentIds.includes(d.intentId)) throw new Error("This quote is no longer active in the conversation.");
      const stored = load().intents[d.intentId];
      if (!stored || stored.decision.status !== "OK") throw new Error("Request a fresh eligible quote.");
      const expiry = Date.parse(stored.createdAt) + Math.min(15, C.loadPolicy().quoteValidMinutes) * 60e3;
      if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("This quote expired. Ask for a fresh payment review.");
      const it = stored.intent, decision = stored.decision, fee = decision.value?.platformFee ?? `0.00 ${it.srcCcy}`;
      plans.push({ intentId: d.intentId, payable: d.payable, termsHash: termsHash(stored), expiresAt: expiry });
      details.push({ intentId: d.intentId, payable: d.payable, supplier: it.beneficiary?.name ?? d.payable,
        youPay: fmt(toMinor(decision.totals.sourceDebit.split(" ")[0], it.srcCcy) + toMinor(fee.split(" ")[0], it.srcCcy), it.srcCcy),
        recipientGets: decision.totals.recipientNet, platformFee: fee, netSavings: decision.value?.customerNetSaving,
        arrivalUtc: decision.totals.arrivalUtc, bankArrivalUtc: decision.baseline?.arrivalUtc,
        routeLabel: decision.allocations.map((a: any) => a.label).join(" + "), routeIds: decision.allocations.map((a: any) => a.routeId),
        expiresAt: new Date(expiry).toISOString(), simulation: true });
    }
    const pending: S.AsiPending = { id: randomUUID(), state: "ready", conversationId: answer.conversationId,
      conversationRevision: answer.conversationRevision, plans, details, expiresAt: Math.min(...plans.map((p) => p.expiresAt)),
      policyHash: policyHash(), decisions, mode: load().intents[plans[0].intentId].intent.amountType === "SOURCE_FIXED" ? "budget" : "invoice" };
    S.setPending(binding, pending);
    res.json({ confirmationId: pending.id, expiresAt: pending.expiresAt, details,
      confirmation: `Reply yes to submit and, if your account may approve it, authorize this ${plans.length === 1 ? "payment" : `${plans.length}-payment run`}. Your company's release checks still apply. An increased debit requires fresh approval. Say cancel or change the plan to close this proposal.` });
  }));
  const requestResults = (pending: S.AsiPending, user: C.User) => (pending.requestIds ?? []).map((id) => {
    const r = C.loadRequests()[id]; if (!r) return { id, status: "UNKNOWN", note: "Check this request in Route402." };
    const value = controls.view(r, user);
    return { id, supplier: r.supplier, status: value.status, transferId: value.transferId, note: value.note,
      url: `${appBase()}/app/#/payments/${encodeURIComponent(id)}` };
  });
  api.post("/status", wrap((req, res) => {
    const binding = bound(req), pending = S.getPending(binding);
    res.json({ message: pending ? pending.state === "unknown" || pending.state === "processing"
      ? "Confirmation outcome needs checking. Do not submit a replacement until the existing requests are reconciled."
      : pending.state === "ready" ? "A payment review is awaiting your yes. Nothing has been submitted by this review."
      : "Current status of this chat's payment requests." : "No payment is awaiting confirmation in this chat.",
      requests: pending ? requestResults(pending, C.user(binding.userId)!) : [] });
  }));
  api.post("/confirm", wrap(async (req, res) => {
    const binding = bound(req), user = C.user(binding.userId)!, pending = S.getPending(binding);
    if (!pending || pending.id !== req.body.confirmationId) throw new Error("There is no matching payment review awaiting your yes.");
    if (pending.state !== "ready") return res.json({ message: pending.state === "done"
      ? "This confirmation was already handled; no payment was sent again."
      : "This confirmation cannot be sent again. Check the existing payment status.", requests: requestResults(pending, user) });
    if (pending.expiresAt <= Date.now() || pending.policyHash !== policyHash()) throw new Error("The quote or company policy changed. Ask for a fresh review before accepting.");
    const current = conversationView(tenant(), pending.conversationId);
    if (current.conversationRevision !== pending.conversationRevision) throw new Error("This plan changed. Review the latest proposal before accepting.");
    for (const plan of pending.plans) {
      const stored = load().intents[plan.intentId];
      if (!stored || plan.expiresAt <= Date.now() || termsHash(stored) !== plan.termsHash || !current.activeIntentIds.includes(plan.intentId))
        throw new Error("The displayed payment terms changed or expired. Request a fresh review.");
      trustedUiDecision(tenant(), { intentId: plan.intentId, payable: plan.payable });
    }
    // Persist before the first asynchronous operation: retries cannot submit the action a second time.
    S.updatePending(binding, { state: "processing", requestIds: [] });
    C.audit(user.id, "asi_confirmed", pending.id, `Session ${binding.session}; review ${pending.conversationId}/${pending.conversationRevision}; ${pending.plans.length} payment(s)`);
    try {
      const prepared = await invoke(controls.prepare, req, user, { decisions: pending.plans.map(({ intentId, payable }) => ({ intentId, payable })),
        confirmed: true, conversationId: pending.conversationId, conversationRevision: pending.conversationRevision,
        purpose: "Accepted in linked ASI:One conversation", mode: pending.mode, allowReroute: false });
      const ids = (prepared.requests ?? []).map((row: any) => row.requestId).filter(Boolean);
      S.updatePending(binding, { requestIds: ids });
      const notes: string[] = (prepared.requests ?? []).filter((row: any) => row.skipped).map((row: any) => String(row.skipped));
      for (const id of ids) {
        // Authority and current company are checked again before each approval in a batch.
        bound(req);
        try { await invoke(controls.approve, req, user, {}, { id }); } catch (e: any) { notes.push(e.message); }
      }
      const saved = S.updatePending(binding, { state: "done" });
      res.json({ message: ids.length ? `Your acceptance was recorded. ${notes.length ? "Some steps still require action in Route402. " : ""}The statuses below reflect the company approval and release controls.`
        : "No new payment request was submitted. Check the existing requests in Route402.", requests: requestResults(saved, user), notes });
    } catch {
      // An exception can happen after creation/approval. Preserve existing evidence; never retry automatically.
      try { S.updatePending(binding, { state: "unknown" }); } catch { /* authority may have been revoked */ }
      res.status(409).json({ error: "The confirmation outcome needs checking. Use status or the company app; do not submit a replacement payment." });
    }
  }));
  app.use("/internal/asi", api);
}
