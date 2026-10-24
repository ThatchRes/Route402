// Isolated local regression suite. No real wallet, chain, seller, bank connection, or user data is accessed.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";

const previousCwd = process.cwd();
const directory = mkdtempSync(path.join(tmpdir(), "route402-deadline-"));
process.chdir(directory);
process.env.LIVE_MARKET = "0"; process.env.ROUTER_NO_LISTEN = "1";
process.env.DEMO_NOW_UTC = "2026-10-24T14:00:00.000Z";
process.env.ROUTER_TOKEN = "local-test-token"; process.env.TREASURY_USD = "2000000.00";
delete process.env.LOCAL_ROUTING;
const { optimize } = await import("./router/optimizer.js");
const { executionPolicy, planForDispatch } = await import("./router/dispatch.js");
const { MID_PER_USD } = await import("./router/registry.js");
const { runPaymentRun } = await import("./company/paymentRun.js");
const { DEMO_RUN } = await import("./company/demo.js");
const { load, update } = await import("./router/store.js");
const intent = { srcCcy: "USD", destCcy: "CAD", amountType: "RECIPIENT_FIXED" as const, amount: "450000.00",
  deadlineUtc: "2026-10-27T20:00:00.000Z", nowUtc: process.env.DEMO_NOW_UTC,
  currentBank: { label: "Test bank", fxMarkupBps: 120, wireFeeUsd: 45, businessDays: 2 } };
let checks = 0;
const check = (label: string, fn: () => void) => { fn(); console.log(`PASS ${++checks}: ${label}`); };
check("production catalog reports the actual late arrival instead of inventing a route", () => {
  const d: any = optimize(intent); assert.equal(d.status, "HOLD"); assert.match(d.reason, /2026-10-28.*2026-10-27/);
});
check("invalid deadlines fail closed", () => assert.equal(optimize({ ...intent, deadlineUtc: "invalid" }).status, "MISSING_INPUT"));
check("calculator holds the invoice instead of presenting a late bank fallback", () => {
  const r = runPaymentRun({ ...DEMO_RUN, nowUtc: intent.nowUtc!, payables: DEMO_RUN.payables.filter((p) => p.id === "AP-CA-Maple"), receivables: [] });
  assert.equal(r.lines[0].status, "HOLD"); assert.equal(r.lines[0].route, "HOLD");
});
process.env.LOCAL_ROUTING = "1";
const local: any = optimize(intent);
check("explicit local fixture supplies a faster, simulated complete route", () => {
  assert.equal(local.status, "OK"); assert.equal(local.allocations[0].routeId, "bank:local_express"); assert.equal(local.simulation, true);
  assert.equal(local.totals.arrivalUtc, "2026-10-24T18:00:00.000Z");
});
check("latest safe start is a usable dispatch boundary", () => {
  assert.equal(optimize({ ...intent, nowUtc: local.timing.latestStartUtc }).status, "OK");
  assert.equal(optimize({ ...intent, nowUtc: new Date(Date.parse(local.timing.latestStartUtc) + 2000).toISOString() }).status, "HOLD");
});
check("even the local express fixture rejects an impossible one-hour deadline", () => {
  assert.equal(optimize({ ...intent, deadlineUtc: "2026-10-24T15:00:00Z" }).status, "HOLD");
});
check("local simulation cannot select a testnet stablecoin route even for a USDC supplier", () => {
  const d: any = optimize({ ...intent, destCcy: "USD", beneficiaryAcceptsUsdc: true });
  assert.ok(d.allocations.every((a: any) => a.routeId.startsWith("bank:")));
});
const flexible = { ...intent, deadlineUtc: "2026-10-31T20:00:00Z", objective: "fastest" as const,
  currentBank: { ...intent.currentBank, fxMarkupBps: 10 } };
const fast: any = optimize(flexible);
const terms = { intent: flexible, allocations: fast.allocations.map((a: any) => ({ routeId: a.routeId, input: a.quote.input })),
  totals: fast.totals, executionPolicy: executionPolicy(flexible, fast, true) };
delete process.env.LOCAL_ROUTING;
check("rerouting uses an already-quoted route within the approved amount", () => {
  const result = planForDispatch(terms, intent.nowUtc!); assert.equal(result.ok, true);
  assert.equal(result.decision.allocations[0].routeId, "bank:current_bank");
});
check("without route-change consent an unavailable approved route is paused", () => {
  assert.equal(planForDispatch({ ...terms, executionPolicy: executionPolicy(flexible, fast, false) }, intent.nowUtc!).ok, false);
});
process.env.LOCAL_ROUTING = "1";
check("a new price cannot exceed the signed debit cap", () => {
  const originalRate = MID_PER_USD.CAD; MID_PER_USD.CAD = "1.0";
  try { assert.equal(planForDispatch(terms, intent.nowUtc!).code, "REAPPROVAL_REQUIRED"); }
  finally { MID_PER_USD.CAD = originalRate; }
});

delete process.env.LOCAL_ROUTING;
check("a consented fallback can cross quote providers, but cannot change the payment task", () => {
  const usd = { ...intent, destCcy: "USD", amount: "100.00", objective: "cheapest" as const, deadlineUtc: "2026-10-31T20:00:00Z", beneficiaryAcceptsUsdc: true,
    currentBank: { ...intent.currentBank, wireFeeUsd: 0 }, provider: "stablecoin" as const };
  const primary: any = optimize(usd), bankIntent = { ...usd, provider: "bank" as const }, bankDecision: any = optimize(bankIntent);
  const policy = executionPolicy(usd, primary, true, [{ intent: bankIntent, decision: bankDecision }]);
  const result = planForDispatch({ intent: usd, totals: primary.totals, allocations: primary.allocations.map((a: any) => ({ routeId: a.routeId, input: a.quote.input })), executionPolicy: policy }, intent.nowUtc!);
  assert.equal(result.decision.allocations[0].routeId, "bank:current_bank");
  assert.throws(() => executionPolicy(usd, primary, true, [{ intent: { ...bankIntent, amount: "200.00" }, decision: bankDecision }]));
});
process.env.LOCAL_ROUTING = "1";
type Evidence = { status: string; creditedAtUtc?: string; ledgerOk?: boolean };
const evidence = new Map<string, Evidence>(), sends: any[] = [];
let realPayout: any = null;
const payout = http.createServer(async (req, res) => {
  if (realPayout) return realPayout(req, res);
  res.setHeader("content-type", "application/json");
  if (req.method === "POST") {
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw); sends.push(body);
    evidence.set(body.transferId, { status: "PENDING" });
    res.end(JSON.stringify({ payoutId: `p_${body.transferId}`, status: "FUNDED" }));
  } else {
    const id = req.url!.split("/")[3], item = evidence.get(id) ?? { status: "PENDING" };
    res.end(JSON.stringify({ ...item, legs: [{ leg: "ledger_postings", expected: "balanced per asset", observed: item.ledgerOk === false ? "UNBALANCED" : "balanced per asset" },
      { leg: "beneficiary_credit", expected: "100 CAD", observed: item.status === "DELIVERED" ? "100 CAD" : null }], outstanding: { fundedButUnpaid: item.status !== "DELIVERED" } }));
  }
});
payout.listen(0, "127.0.0.1"); await once(payout, "listening");
process.env.PAYOUT_URL = `http://127.0.0.1:${(payout.address() as any).port}`;
const { app, dispatchDue, monitorTransfers } = await import("./router/server.js");
const router = app.listen(0, "127.0.0.1"); await once(router, "listening");
const base = `http://127.0.0.1:${(router.address() as any).port}`;
async function call(route: string, body?: any) {
  const response = await fetch(base + route, { method: body ? "POST" : "GET",
    headers: { authorization: "Bearer local-test-token", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() as any };
}
async function create(overrides: any = {}, options: any = {}) {
  const quote = await call("/v1/intents", { ...intent, ...overrides }); assert.equal(quote.status, 201);
  const transfer = await call("/v1/transfers", { intentId: quote.body.intentId, ...options }); assert.equal(transfer.status, 201);
  return transfer.body;
}
const approve = (t: any) => call(`/v1/transfers/${t.transferId}/approvals`, { planVersion: t.planVersion, termsHash: t.termsHash, approver: "test-treasurer" });
const execute = (t: any) => call(`/v1/transfers/${t.transferId}/execute`, { planVersion: t.planVersion, termsHash: t.termsHash });
async function until(fn: () => boolean | Promise<boolean>) { for (let n = 0; n < 100; n++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail("local operation did not finish"); }
try {
  const t = await create({}, { dispatchAtUtc: "2026-10-24T14:30:00Z", allowReroute: true });
  assert.equal((await approve(t)).status, 200);
  assert.equal((await execute(t)).status, 202);
  assert.equal(load().transfers[t.transferId].status, "SCHEDULED"); assert.equal(sends.length, 0);
  await execute(t); assert.equal(sends.length, 0);
  console.log(`PASS ${++checks}: approval reserves funds and persists a future dispatch without sending early or twice`);
  assert.equal((await approve(t)).status, 409);
  console.log(`PASS ${++checks}: re-approval cannot reset a scheduled or completed transfer to an executable state`);
  process.env.DEMO_NOW_UTC = "2026-10-24T14:31:00Z";
  await dispatchDue(); await until(() => sends.length === 1 && load().transfers[t.transferId].children.length === 1);
  assert.equal(load().transfers[t.transferId].termsHash, t.termsHash);
  assert.equal(load().transfers[t.transferId].terms.totals.sourceDebit, t.terms.totals.sourceDebit);
  assert.ok(load().transfers[t.transferId].executionQuoteExpiresAt > t.quoteExpiresAt);
  console.log(`PASS ${++checks}: disk-driven dispatch refreshes an expired quote while retaining the approved terms`);
  await execute(t); await dispatchDue(); assert.equal(sends.length, 1);
  console.log(`PASS ${++checks}: repeated execution and scheduler ticks never resubmit a payout`);
  const child = load().transfers[t.transferId].children[0];
  evidence.set(child, { status: "PAYOUT_UNKNOWN" }); await monitorTransfers();
  assert.equal(load().transfers[t.transferId].status, "NEEDS_RECONCILIATION"); assert.ok(BigInt(load().reservedUsdMinor) > 0n);
  await execute(t); assert.equal(sends.length, 1);
  console.log(`PASS ${++checks}: an unknown payout retains the reservation and blocks blind retries`);
  evidence.set(child, { status: "DELIVERED", ledgerOk: false, creditedAtUtc: "2026-10-24T18:31:00Z" });
  await until(async () => { await monitorTransfers(); return load().transfers[t.transferId].steps.payout_1.status === "REVIEW"; });
  assert.equal(load().transfers[t.transferId].status, "NEEDS_RECONCILIATION"); assert.ok(BigInt(load().reservedUsdMinor) > 0n);
  console.log(`PASS ${++checks}: delivery without a balanced ledger remains unreconciled and keeps funds reserved`);
  evidence.set(child, { status: "DELIVERED", creditedAtUtc: "2026-10-24T18:31:00Z" }); await monitorTransfers();
  assert.equal(load().transfers[t.transferId].status, "COMPLETED"); assert.equal(load().transfers[t.transferId].deadlineStatus, "MET");
  assert.equal(load().reservedUsdMinor, "0"); assert.ok(BigInt(load().spentUsdMinor!) > 0n);
  console.log(`PASS ${++checks}: recipient credit evidence completes the transfer and books the treasury debit`);
  const late = await create({ deadlineUtc: "2026-10-24T19:00:00Z" }); await approve(late); await execute(late);
  await until(() => !!load().transfers[late.transferId].steps.payout_1?.payoutId);
  evidence.set(load().transfers[late.transferId].children[0], { status: "DELIVERED", creditedAtUtc: "2026-10-24T19:01:00Z" }); await monitorTransfers();
  await until(async () => { await monitorTransfers(); return load().transfers[late.transferId].status === "COMPLETED"; });
  assert.equal(load().transfers[late.transferId].deadlineStatus, "MISSED");
  console.log(`PASS ${++checks}: a late recipient credit is reported as missed even when the payout succeeds`);
  const delayed = await create({ deadlineUtc: "2026-10-24T19:00:00Z" }, { dispatchAtUtc: "2026-10-24T14:59:00Z" }); await approve(delayed); await execute(delayed);
  const before = sends.length; process.env.DEMO_NOW_UTC = "2026-10-24T15:01:00Z"; await dispatchDue();
  assert.equal(load().transfers[delayed.transferId].status, "PAUSED"); assert.equal(sends.length, before); assert.equal(load().reservedUsdMinor, "0");
  console.log(`PASS ${++checks}: a delayed scheduler pauses an infeasible payment before funding and frees its reservation`);
  const fresh = await call("/v1/intents", { ...intent, nowUtc: "2020-01-01T00:00:00Z" });
  const stored = await call(`/v1/intents/${fresh.body.intentId}`);
  assert.equal(Date.parse(stored.body.intent.nowUtc), Date.parse(process.env.DEMO_NOW_UTC!));
  console.log(`PASS ${++checks}: browser or imported timestamps cannot move the router's authoritative clock`);
  assert.equal((await fetch(base + "/app/")).status, 200);
  console.log(`PASS ${++checks}: the chat frontend is served from an isolated working directory`);
  // Final handoff uses the actual payout service, simulated provider, signed webhook handler and ledger.
  process.env.PAYOUT_NO_LISTEN = "1"; process.env.SIM_EVENT_DELAY_MS = "10";
  process.env.PORT = String((payout.address() as any).port);
  process.env.PROVIDER_WEBHOOK_SECRET = "local-test-webhook-secret";
  process.env.DEMO_NOW_UTC = new Date().toISOString();
  realPayout = (await import("./server.js")).app;
  const actual = await create({ amount: "100.00", deadlineUtc: new Date(Date.now() + 2 * 86400_000).toISOString() });
  await approve(actual); await execute(actual);
  await until(async () => { await monitorTransfers(); return load().transfers[actual.transferId].status === "COMPLETED"; });
  assert.equal(load().transfers[actual.transferId].deadlineStatus, "MET");
  assert.ok(Date.parse(load().transfers[actual.transferId].creditedAtUtc) > 0);
  const receipt = await call(`/v1/transfers/${actual.transferId}/receipt`);
  assert.equal(receipt.body.children[0].status, "DELIVERED");
  console.log(`PASS ${++checks}: real simulated payout, signed webhooks, balanced ledger and recipient-credit timestamp complete the approved transfer`);
  console.log(`Deadline suite: ${checks} checks passed; no external transactions; isolated data in ${directory}`);
} finally { router.close(); payout.close(); router.closeAllConnections(); payout.closeAllConnections(); process.chdir(previousCwd); }
