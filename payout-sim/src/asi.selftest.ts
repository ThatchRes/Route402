// Real ASI routes + existing UI preparation/approval/release, with local settlement fixtures only.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import express from "express";
const cwd = process.cwd(); process.chdir(mkdtempSync(path.join(tmpdir(), "route402-asi-")));
process.env.LOCAL_ROUTING = "1"; process.env.LIVE_MARKET = "0"; process.env.ROUTER_NO_LISTEN = "1";
process.env.AGENT_SERVICE_TOKEN = "asi-local-test-token";
const C = await import("./company/controls.js"), S = await import("./assistant/asiState.js");
const { askConversation, recordConversationReview } = await import("./assistant/conversation.js");
const { loadLinked, saveLinked } = await import("./assistant/linked.js");
const { optimize } = await import("./router/optimizer.js");
const { load, update } = await import("./router/store.js");
const { mountUi } = await import("./router/ui.js");
const app = express(); app.use(express.json({ limit: "100kb", strict: true }));
const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const port = (server.address() as any).port, base = `http://127.0.0.1:${port}`;
process.env.ASI_APP_URL = base; process.env.ROUTER_PORT = String(port);
let counter = 0, sends = 0, approvals = 0;
const storeIntent = (intent: any) => {
  const intentId = `int_asi_${++counter}`, decision: any = optimize({ ...intent, provider: "bank", nowUtc: new Date().toISOString() });
  assert.equal(decision.status, "OK", decision.reason);
  update((db) => { db.intents[intentId] = { intentId, intent: { ...intent, provider: "bank" }, decision, createdAt: new Date().toISOString() }; });
  return { intentId, decision };
};
mountUi(app, port, storeIntent);
app.get("/v1/intents/:id", (req, res) => res.json(load().intents[String(req.params.id)]));
app.post("/v1/transfers", (req, res) => {
  const intent = load().intents[req.body.intentId];
  const transferId = `tr_fixture_${counter}`, transfer = { transferId, intentId: req.body.intentId,
    planVersion: 1, termsHash: "fixture-terms", status: "AWAITING_APPROVAL", steps: {}, history: [],
    terms: { intent: intent.intent, totals: intent.decision.totals, allocations: [] } };
  update((db) => { db.transfers[transferId] = transfer; }); res.json(transfer);
});
app.post("/v1/transfers/:id/approvals", (req, res) => {
  approvals++; assert.equal(req.body.approver, "alex"); res.json({ approved: true });
});
app.post("/v1/transfers/:id/execute", (req, res) => {
  sends++; update((db) => { db.transfers[String(req.params.id)].status = "COMPLETED"; }); res.json({ accepted: true });
});
app.get("/v1/transfers/:id", (req, res) => res.json(load().transfers[String(req.params.id)]));
const sender = "agent1" + "a".repeat(55), tenant = "demo-tenant";
const serviceHeaders = { authorization: "Bearer asi-local-test-token", "x-tenant-id": tenant };
async function post(route: string, body: any, headers: Record<string, string> = {}) {
  const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
const api = (action: string, session: string, body = {}, headers = serviceHeaders) =>
  post(`/internal/asi/${action}`, { sender, session, ...body }, headers);
let checks = 0;
const pass = (message: string) => console.log(`PASS ${++checks}: ${message}`);
const cookies: Record<string, string> = {};
for (const user of ["alex", "maya", "priya"]) cookies[user] = `r402=${C.signIn(user, C.issueCode(user))}`;
async function link(user: string, session: string) {
  const result = await api("link", session); assert.equal(result.status, 200);
  const token = new URL(result.data.linkUrl).hash.slice(1);
  S.completeLink(token, user, S.sessionFingerprint(cookies[user])!, loadLinked().input.company.companyId);
  const context = await api("context", session); assert.equal(context.data.linked, true); return context.data;
}
async function offer(session: string, changes: any = {}) {
  const context = await api("context", session), id = context.data.conversationId;
  const preview = askConversation(tenant, "send 500 EUR to Muller", id);
  assert.ok(preview.intent, JSON.stringify(preview));
  const stored = storeIntent({ ...preview.intent, beneficiary: preview.beneficiary,
    currentBank: loadLinked().input.company.currentBank, deadlineUtc: new Date(Date.now() + 10 * 86400e3).toISOString() });
  const decision = { payable: preview.paymentRef, decision: "approve", chosen: "bank", intentId: stored.intentId,
    routeIds: stored.decision.allocations.map((a: any) => a.routeId), needs: [], reasons: [], ...changes };
  recordConversationReview(tenant, id, preview.conversationRevision, [decision]);
  const answer = { status: "ok", conversationId: id, conversationRevision: preview.conversationRevision, decisions: [decision] };
  const result = await api("offer", session, { answer });
  return { ...result, answer, stored };
}
try {
  assert.equal((await api("context", "session-test", {}, { ...serviceHeaders, authorization: "Bearer wrong" })).status, 401);
  assert.equal((await api("context", "session-test", {}, { ...serviceHeaders, "x-tenant-id": "another-tenant" })).status, 403);
  assert.equal((await api("context", "session-test", { sender: "not-a-signed-agent" })).status, 422);
  assert.equal((await api("confirm", "session-test", { confirmationId: "invented" })).status, 409);
  assert.equal(sends, 0); pass("service auth, tenant, signed sender shape and browser linking are mandatory");

  const challenge = await api("link", "session-browser-link"), token = new URL(challenge.data.linkUrl).hash.slice(1);
  assert.equal((await post("/ui/asi/link-info", { token })).status, 401);
  const info = await post("/ui/asi/link-info", { token }, { cookie: cookies.alex });
  assert.equal(info.status, 200); assert.equal(info.data.sender, sender); assert.equal(info.data.session, "session-browser-link");
  assert.equal((await post("/ui/asi/link", { token, accepted: true }, { cookie: cookies.alex, origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await post("/ui/asi/link", { token, accepted: false }, { cookie: cookies.alex })).status, 409);
  assert.equal((await post("/ui/asi/link", { token, accepted: true }, { cookie: cookies.alex })).status, 200);
  assert.equal((await post("/ui/asi/link", { token, accepted: true }, { cookie: cookies.alex })).status, 409);
  pass("pairing is same-origin, explicit, one-time and shows the exact sender/session first");

  await link("alex", "session-one");
  const good = await offer("session-one"); assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.match(good.data.details[0].youPay, /USD$/); assert.equal(good.data.details[0].recipientGets, good.stored.decision.totals.recipientNet);
  assert.equal((await api("confirm", "session-other", { confirmationId: good.data.confirmationId })).status, 409);
  assert.equal((await api("confirm", "session-one", { confirmationId: "wrong-review" })).status, 409);
  assert.equal(Object.keys(C.loadRequests()).length, 0); pass("offering uses authoritative quote amounts and cannot cross chat scopes or confirmation IDs");

  const confirmations = await Promise.all([api("confirm", "session-one", { confirmationId: good.data.confirmationId }),
    api("confirm", "session-one", { confirmationId: good.data.confirmationId })]);
  confirmations.forEach((response) => assert.equal(response.status, 200, JSON.stringify(response.data)));
  const accepted = confirmations.find((response) => response.data.requests.length === 1)!;
  assert.ok(accepted, "one confirmation must return the prepared request");
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.requests.length, 1);
  for (let i = 0; i < 80 && !sends; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sends, 1); assert.equal(approvals, 1);
  assert.equal((await api("confirm", "session-one", { confirmationId: good.data.confirmationId })).status, 200);
  assert.equal(sends, 1);
  assert.ok(C.loadAudit().some((x) => x.action === "owner_override"));
  assert.ok(C.loadAudit().some((x) => x.action === "asi_confirmed"));
  pass("owner acceptance uses the existing audited prepare/approve/release flow and repeated yes never resends");

  await link("maya", "session-preparer"); const preparer = await offer("session-preparer");
  assert.equal(preparer.status, 200, JSON.stringify(preparer.data));
  const prepared = await api("confirm", "session-preparer", { confirmationId: preparer.data.confirmationId });
  assert.equal(prepared.status, 200); assert.equal(prepared.data.requests[0].status, "AWAITING_APPROVAL"); assert.equal(sends, 1);
  pass("a preparer can submit a request but cannot self-approve or execute it through chat");

  await link("priya", "session-separation"); const separate = await offer("session-separation");
  const separated = await api("confirm", "session-separation", { confirmationId: separate.data.confirmationId });
  assert.equal(separated.data.requests[0].status, "AWAITING_APPROVAL"); assert.equal(sends, 1);
  assert.match(separated.data.notes.join(" "), /segregation/); pass("admin status does not remove existing segregation of duties");

  await link("alex", "session-callback"); const callback = await offer("session-callback", { detailsChanged: true, needs: ["call-back verification"] });
  const checked = await api("confirm", "session-callback", { confirmationId: callback.data.confirmationId });
  assert.equal(checked.data.requests[0].status, "NEEDS_CALLBACK"); assert.equal(sends, 1);
  pass("yes cannot satisfy a supplier call-back requirement");

  await link("alex", "session-stale"); const stale = await offer("session-stale");
  askConversation(tenant, "make it 700 instead", stale.answer.conversationId);
  assert.equal((await api("confirm", "session-stale", { confirmationId: stale.data.confirmationId })).status, 409);
  pass("a new conversation version invalidates an earlier displayed quote");

  await link("alex", "session-mutation"); const mutated = await offer("session-mutation");
  update((db) => { db.intents[mutated.stored.intentId].decision.totals.sourceDebit = "9999.00 USD"; });
  assert.equal((await api("confirm", "session-mutation", { confirmationId: mutated.data.confirmationId })).status, 409);
  pass("stored terms are fingerprinted and cannot change silently before acceptance");

  await link("alex", "session-expired"); const expired = await offer("session-expired");
  const b = S.requireBinding(tenant, sender, "session-expired", loadLinked().input.company.companyId, C.activeSessionFingerprint);
  S.updatePending(b, { expiresAt: Date.now() - 1 });
  assert.equal((await api("confirm", "session-expired", { confirmationId: expired.data.confirmationId })).status, 409);
  pass("expired proposals cannot be accepted");

  await link("alex", "session-policy"); const policy = await offer("session-policy");
  C.savePolicy({ ...C.loadPolicy(), issuerCapUsd: 123_456 });
  assert.equal((await api("confirm", "session-policy", { confirmationId: policy.data.confirmationId })).status, 409);
  pass("company policy changes require a fresh displayed review");

  await link("alex", "session-cancel"); const cancelled = await offer("session-cancel");
  await api("cancel", "session-cancel");
  const cancelledResponse = await api("confirm", "session-cancel", { confirmationId: cancelled.data.confirmationId });
  assert.equal(cancelledResponse.data.requests.length, 0); assert.equal(sends, 1);
  pass("cancelling a proposal prevents subsequent acceptance");

  await link("alex", "session-hold"); const held = await offer("session-hold", { decision: "hold" });
  assert.equal(held.status, 409); pass("held agent decisions cannot be converted into executable confirmations");

  await link("alex", "session-company"); const linked = loadLinked();
  saveLinked({ ...linked, input: { ...linked.input, company: { ...linked.input.company, companyId: "other-company" } } });
  assert.equal((await api("context", "session-company")).data.linked, false); saveLinked(linked);
  C.signOut(cookies.alex);
  assert.equal((await api("context", "session-company")).data.linked, false);
  assert.equal((await api("confirm", "session-policy", { confirmationId: policy.data.confirmationId })).status, 409);
  pass("switching companies or signing out revokes usable chat authority");
  assert.equal(sends, 1); assert.equal(C.verifyAudit().ok, true);
  console.log(`ASI integration suite: ${checks} checks passed; local HTTP settlement fixtures, no external payments.`);
} finally { server.close(); server.closeAllConnections(); process.chdir(cwd); }
