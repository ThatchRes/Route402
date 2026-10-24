// Adaptive routing regressions. All state is temporary; no chain, wallet or payout services are called.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
const cwd = process.cwd(); process.chdir(mkdtempSync(path.join(tmpdir(), "route402-exposure-")));
process.env.ROUTER_NO_LISTEN = "1"; process.env.LIVE_MARKET = "0"; process.env.DEPEG_TEST_PRICE = "1";
process.env.DEMO_NOW_UTC = "2026-10-26T10:00:00Z"; process.env.TREASURY_USD = "2000000"; process.env.ROUTER_TOKEN = "exposure-test";
delete process.env.LOCAL_ROUTING; delete process.env.VENUE_QUOTES;
const { assessExposure, cleanAdaptiveExposure, DEFAULT_ADAPTIVE_EXPOSURE } = await import("./router/exposure.js");
const { exposureContext, exposureLeg } = await import("./router/exposureState.js");
const C = await import("./company/controls.js");
const { load, update } = await import("./router/store.js");
const { stablecoinPlanAllowed } = await import("./router/depeg.js");
const { LIVE_VENUES } = await import("./router/registry.js");
const { app, dispatchDue } = await import("./router/server.js");
const p = { ...C.loadPolicy(), issuerCapsUsd: { Circle: 1_000_000, Ripple: 1_000_000 },
  adaptiveExposure: { ...DEFAULT_ADAPTIVE_EXPOSURE, enabled: true } };
C.savePolicy(p);
const leg = (issuer: string, amountUsd: number, durationHours = 1, liquidityKey?: string) => ({ issuer, amountUsd, durationHours, liquidityKey, capacityUsd: 100_000 });
const allocation = (coin: string, amount: number, durationHours = 1) => ({ routeId: `coin:${coin}:base:test`, sourceDebit: `${amount} USD`, exposure: leg(coin === "RLUSD" ? "Ripple" : "Circle", amount, durationHours) });
let checks = 0;
const check = (name: string, fn: () => void) => { fn(); console.log(`PASS ${++checks}: ${name}`); };
check("short transfers fit; long settlement consumes more budget without raising hard ceilings", () => {
  const context = exposureContext();
  assert.equal(assessExposure(context, [leg("Circle", 600_000)]).ok, true);
  assert.equal(assessExposure(context, [leg("Circle", 600_000, 48)]).ok, false);
  assert.equal(assessExposure(context, [leg("Circle", 1_000_001)]).ok, false);
});
check("aggregate issuer and portfolio checks cannot be bypassed by splitting", () => {
  const context = exposureContext();
  assert.equal(assessExposure(context, [leg("Circle", 600_000), leg("Circle", 600_000)]).ok, false);
  assert.equal(assessExposure(context, [leg("Circle", 800_000), leg("Ripple", 800_000)]).ok, false);
});
check("networks sharing one venue also share its liquidity buffer", () => {
  const context = exposureContext();
  assert.equal(assessExposure(context, [leg("Circle", 60_000, 1, "book")]).ok, true);
  assert.equal(assessExposure(context, [leg("Circle", 60_000, 1, "book"), leg("Circle", 60_000, 1, "book")]).ok, false);
});
check("treasury depletion tightens budgets and invalid settings fail validation", () => {
  update((db) => { db.spentUsdMinor = "180000000"; });
  assert.equal(assessExposure(exposureContext(), [leg("Circle", 110_000)]).ok, false);
  update((db) => { db.spentUsdMinor = "0"; });
  assert.throws(() => cleanAdaptiveExposure({ enabled: true, totalTreasuryPct: 20, issuerTreasuryPct: 50 }));
  assert.throws(() => cleanAdaptiveExposure({ enabled: true, liquidityUsePct: NaN }));
});
check("scheduled and unresolved transfers retain budget and are counted once alongside UI requests", () => {
  update((db) => { db.intents.active = { decision: { allocations: [allocation("USDC", 100_000)] } };
    db.transfers.active = { transferId: "active", intentId: "active", status: "SCHEDULED", terms: { allocations: [allocation("USDC", 100_000)] } }; });
  C.saveRequests({ request: { id: "request", intentId: "active", transferId: "active", status: "EXECUTING" } as any });
  assert.equal(exposureContext().usedUsd.Circle, 100_000);
  assert.equal(exposureContext(p, "request", "active").usedUsd.Circle, undefined);
  update((db) => { db.transfers.active.status = "NEEDS_RECONCILIATION"; });
  assert.equal(exposureContext().usedUsd.Circle, 100_000);
  update((db) => { db.transfers.active.status = "COMPLETED"; });
  assert.equal(exposureContext().usedUsd.Circle, undefined);
  C.saveRequests({}); update((db) => { db.transfers = {}; });
});
check("paused requests keep locked escrow exposure until the funds are released", () => {
  C.saveRequests({ locked: { id: "locked", intentId: "locked", status: "PAUSED", preparedAt: "2026-10-26T10:00:00Z",
    route: "coin:USDC:base:test", debitUsd: 10_000, escrow: { state: "LOCKED", deadline: "2026-11-25T10:00:00Z" } } as any });
  assert.equal(exposureContext().usedUsd.Circle, 10_000);
  assert.equal(exposureContext().weightedUsedUsd.Circle, 300_000);
  C.saveRequests({});
});
check("foreign-currency debits are converted to USD for exposure accounting", () => {
  assert.ok(Math.abs(exposureLeg({ routeId: "coin:EURC:base:test", sourceDebit: "925 EUR" })!.amountUsd - 1000) < 0.001);
  const shared = exposureLeg({ routeId: "coin:USDC>EURC:base:test", sourceDebit: "100 USD" })!;
  assert.deepEqual(shared.issuers, ["Circle"]);
  const separate = exposureLeg({ routeId: "coin:USDC>XSGD:base:test", sourceDebit: "100 USD" })!;
  assert.deepEqual(separate.issuers, ["Circle", "StraitsX"]);
  assert.deepEqual(Object.keys(assessExposure(exposureContext(), [separate]).perIssuer), ["Circle", "StraitsX"]);
});
assert.equal((await stablecoinPlanAllowed([allocation("USDC", 50_000)], undefined, undefined, 30 * 24)).ok, false);
console.log(`PASS ${++checks}: a long escrow window is checked before funds can be locked`);

const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const post = async (url: string, body: any, cookie?: string) => {
  const r = await fetch(base + url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer exposure-test", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() as any, cookie: r.headers.get("set-cookie")?.split(";")[0] };
};
try {
  const request = { provider: "stablecoin", srcCcy: "USD", destCcy: "USD", amountType: "SOURCE_FIXED", amount: "600000.00", beneficiaryAcceptsUsdc: true, allowSplit: false };
  const quote = await post("/v1/provider-quote", request);
  assert.equal(quote.data.status, "OK"); assert.equal(quote.data.exposure.enabled, true);
  const transfer = (await post("/v1/transfers", { intentId: quote.data.intentId })).data;
  const signed = JSON.stringify(transfer.terms);
  update((db) => { db.transfers.other = { transferId: "other", intentId: "other", status: "SCHEDULED", terms: { allocations: [allocation("USDC", 500_000)] } }; });
  const stale = await post(`/v1/transfers/${transfer.transferId}/approvals`, { planVersion: transfer.planVersion, termsHash: transfer.termsHash, approver: "test" });
  assert.equal(stale.status, 409); assert.equal(JSON.stringify(load().transfers[transfer.transferId].terms), signed);
  assert.equal(load().transfers[transfer.transferId].status, "AWAITING_APPROVAL");
  assert.equal(load().reservedUsdMinor, "0");
  console.log(`PASS ${++checks}: approval refreshes current commitments and pauses stale plans without changing signed terms`);

  update((db) => { db.transfers = {}; });
  const scheduledQuote = await post("/v1/provider-quote", request);
  const scheduled = (await post("/v1/transfers", { intentId: scheduledQuote.data.intentId, dispatchAtUtc: "2026-10-26T11:00:00Z" })).data;
  const approval = { planVersion: scheduled.planVersion, termsHash: scheduled.termsHash, approver: "test" };
  assert.equal((await post(`/v1/transfers/${scheduled.transferId}/approvals`, approval)).status, 200);
  assert.equal((await post(`/v1/transfers/${scheduled.transferId}/execute`, approval)).status, 202);
  assert.equal(load().transfers[scheduled.transferId].status, "SCHEDULED");
  process.env.TREASURY_USD = "200000"; process.env.DEMO_NOW_UTC = "2026-10-26T11:00:00Z";
  await dispatchDue();
  assert.equal(load().transfers[scheduled.transferId].status, "PAUSED");
  assert.equal(load().reservedUsdMinor, "0");
  assert.deepEqual(load().transfers[scheduled.transferId].steps, {});
  process.env.TREASURY_USD = "2000000"; process.env.DEMO_NOW_UTC = "2026-10-26T10:00:00Z";
  update((db) => { db.transfers = {}; });
  console.log(`PASS ${++checks}: scheduled dispatch rechecks treasury and pauses before funding while releasing its reservation`);

  process.env.TREASURY_USD = "200000";
  const forged = await post("/v1/provider-quote", { ...request, amount: "150000.00", issuerHeadroomUsd: { Circle: 1e12 },
    exposureContext: { settings: { enabled: false }, hardCapsUsd: { Circle: 1e12 } } });
  assert.equal(forged.data.status, "NO_QUOTE");
  process.env.TREASURY_USD = "2000000";
  console.log(`PASS ${++checks}: caller-supplied budgets cannot override backend treasury limits`);

  LIVE_VENUES.EUR = { bps: 1, source: "isolated liquidity fixture", capacityUsd: 100_000 };
  const hybrid = await post("/v1/provider-quote", { ...request, destCcy: "EUR", amount: "150000.00", allowSplit: true });
  assert.equal(hybrid.data.status, "OK");
  const decision = load().intents[hybrid.data.intentId].decision;
  const coins = decision.allocations.filter((a: any) => a.routeId.startsWith("coin:"));
  assert.ok(coins.length > 0); assert.ok(decision.allocations.some((a: any) => a.routeId.startsWith("bank:")));
  assert.ok(coins.reduce((s: number, a: any) => s + a.exposure.amountUsd, 0) <= 80_000);
  assert.equal(decision.exposure.ok, true);
  console.log(`PASS ${++checks}: buffered liquidity produces a stablecoin-plus-bank plan with exact source allocation`);

  const code = await post("/ui/login/code", { userId: "alex" });
  const login = await post("/ui/login", { userId: "alex", code: code.data.demoCode });
  const invalid = await post("/ui/policy", { adaptiveExposure: { enabled: true, baseHours: 0 } }, login.cookie);
  assert.equal(invalid.status, 400);
  const saved = await post("/ui/policy", { adaptiveExposure: { ...p.adaptiveExposure, baseHours: 12 } }, login.cookie);
  assert.equal(saved.status, 200); assert.equal(C.loadPolicy().adaptiveExposure?.baseHours, 12);
  assert.ok(C.loadAudit().some((a) => a.action === "adaptive_exposure_changed")); assert.equal(C.verifyAudit().ok, true);
  console.log(`PASS ${++checks}: adaptive settings use validated admin writes with an intact audit trail`);
  console.log(`Exposure suite: ${checks} checks passed; isolated state, no payments or external calls.`);
} finally { server.close(); server.closeAllConnections(); process.chdir(cwd); }
