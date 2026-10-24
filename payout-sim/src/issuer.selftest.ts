// Isolated exposure-policy regression tests. No payments, wallet calls or external services.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { runInNewContext } from "node:vm";

const previousCwd = process.cwd();
process.chdir(mkdtempSync(path.join(tmpdir(), "route402-issuer-")));
process.env.LIVE_MARKET = "0"; process.env.ROUTER_NO_LISTEN = "1";
process.env.DEPEG_TEST_PRICE = "1"; process.env.ROUTER_TOKEN = "issuer-test-token";
delete process.env.LOCAL_ROUTING;
const C = await import("./company/controls.js");
const { issuerHeadroom, stablecoinPlanAllowed, usdcRouteAllowed } = await import("./router/depeg.js");
const { update } = await import("./router/store.js");
const { app } = await import("./router/server.js");
const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}`;
let checks = 0;
const pass = (message: string) => console.log(`PASS ${++checks}: ${message}`);
const leg = (coin: string, usd: number) => ({ routeId: `coin:${coin}:base:test`, quote: { sourceDebit: { display: `${usd} USD` } } });
async function post(route: string, body: any, cookie?: string) {
  const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json",
    authorization: "Bearer issuer-test-token", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() as any, cookie: r.headers.get("set-cookie")?.split(";")[0] };
}
async function login(userId: string) {
  const code = await post("/ui/login/code", { userId });
  return (await post("/ui/login", { userId, code: code.data.demoCode })).cookie!;
}
try {
  const original = C.loadPolicy();
  assert.equal(C.issuerCapFor(original, "Circle"), 250_000);
  assert.equal(issuerHeadroom(original).Ripple, 250_000);
  pass("legacy policies retain the existing default for every issuer");

  const policy = { ...original, issuerCapsUsd: { Circle: 1_000_000, Ripple: 50_000, Paxos: 0 } };
  C.savePolicy(policy);
  assert.equal(C.loadPolicy().issuerCapsUsd?.Circle, 1_000_000);
  assert.equal(issuerHeadroom().Circle, 1_000_000);
  assert.equal(issuerHeadroom().Ripple, 50_000);
  assert.equal(issuerHeadroom().Paxos, 0);
  assert.equal(issuerHeadroom().Monerium, 250_000);
  pass("different limits persist, including zero, while other issuers use the default");

  C.saveRequests({ active: { id: "active", intentId: "fixture", status: "EXECUTING" } as any });
  update((db) => { db.intents.fixture = { decision: { allocations: [leg("USDC", 100_000), leg("EURC", 150_000), leg("RLUSD", 10_000)] } }; });
  assert.equal(issuerHeadroom().Circle, 750_000);
  assert.equal(issuerHeadroom().Ripple, 40_000);
  assert.equal(issuerHeadroom(policy, "active").Circle, 1_000_000);
  assert.equal((await stablecoinPlanAllowed([leg("USDC", 400_000), leg("EURC", 350_000)])).ok, true);
  const over = await stablecoinPlanAllowed([leg("USDC", 400_000), leg("EURC", 350_001)]);
  assert.equal(over.ok, false); assert.match(over.reason!, /1,000,000 USD limit for Circle/);
  assert.equal((await stablecoinPlanAllowed([leg("RLUSD", 40_001)])).ok, false);
  assert.equal((await stablecoinPlanAllowed([leg("PYUSD", 1)])).ok, false);
  assert.equal((await usdcRouteAllowed(750_000)).cap, 1_000_000);
  assert.equal((await usdcRouteAllowed(750_001)).ok, false);
  C.savePolicy({ ...policy, issuerCapsUsd: { ...policy.issuerCapsUsd, Circle: 200_000 } });
  assert.equal(issuerHeadroom().Circle, 0);
  assert.equal((await stablecoinPlanAllowed([leg("USDC", 1)])).ok, false);
  pass("shared-issuer exposure, release gates, self-exclusion and reduced limits use the configured caps");
  C.saveRequests({}); C.savePolicy(original);

  assert.equal((await post("/ui/policy", { issuerCapsUsd: { Circle: 1_000_000 } })).status, 401);
  const preparer = await login("maya"), admin = await login("priya");
  assert.equal((await post("/ui/policy", { issuerCapsUsd: {} }, preparer)).status, 403);
  const saved = await post("/ui/policy", { issuerCapsUsd: policy.issuerCapsUsd }, admin);
  assert.equal(saved.status, 200); assert.deepEqual(saved.data.issuerCapsUsd, policy.issuerCapsUsd);
  assert.ok(C.loadAudit().some((e) => e.action === "issuer_cap_changed" && e.ref === "Circle" && /1000000/.test(e.detail)));
  assert.equal(C.verifyAudit().ok, true);
  pass("only admins can save overrides, and issuer-specific changes have an intact audit trail");

  const before = readFileSync("data/policy.json", "utf8"), auditCount = C.loadAudit().length;
  for (const invalid of [null, [], "Circle", { Circle: -1 }, { Circle: null }, { Circle: "100" }, { Circle: 1e100 }, { Unknown: 100 }])
    assert.equal((await post("/ui/policy", { issuerCapsUsd: invalid }, admin)).status, 400, JSON.stringify(invalid));
  for (const invalid of [null, -1, "100", 1e100])
    assert.equal((await post("/ui/policy", { issuerCapUsd: invalid }, admin)).status, 400);
  assert.throws(() => C.cleanIssuerCaps({ Circle: NaN }));
  assert.throws(() => C.cleanIssuerCaps({ Circle: Infinity }));
  assert.equal(readFileSync("data/policy.json", "utf8"), before);
  assert.equal(C.loadAudit().length, auditCount);
  pass("invalid limits are rejected without saving policy or audit changes");

  const quote = { provider: "stablecoin", srcCcy: "USD", destCcy: "USD", amountType: "SOURCE_FIXED", amount: "500000.00",
    beneficiaryAcceptsUsdc: true, objective: "cheapest" };
  const high = await post("/v1/provider-quote", quote);
  assert.equal(high.data.status, "OK");
  assert.ok(high.data.plan.allocations.every((a: any) => a.routeId.startsWith("coin:USDC:")));
  await post("/ui/policy", { issuerCapsUsd: { Circle: 0, Ripple: 50_000 } }, admin);
  assert.equal((await post("/v1/provider-quote", quote)).data.status, "NO_QUOTE");
  await post("/ui/policy", { issuerCapsUsd: { Ripple: 50_000 } }, admin);
  assert.equal(C.issuerCapFor(C.loadPolicy(), "Circle"), 250_000);
  assert.equal(C.loadPolicy().issuerCapsUsd?.Ripple, 50_000);
  await post("/ui/policy", { issuerCapUsd: 300_000 }, admin);
  assert.equal(issuerHeadroom().Circle, 300_000);
  assert.equal(issuerHeadroom().Ripple, 50_000);
  assert.ok(C.loadAudit().some((e) => e.action === "issuer_cap_changed" && e.ref === "default" && /300000/.test(e.detail)));
  pass("new quotes immediately use overrides; removing an override restores the default");

  // Exercise the actual browser renderer without changing a live policy or requiring a browser installation.
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function policyIssuerCaps(dis) {"), end = source.indexOf('\n$("#open-connect")', start);
  const html = runInNewContext(`${source.slice(start, end)}\npolicyIssuerCaps(\"disabled\")`, {
    POLICY: policy, STATE: { compliance: { stablecoins: { USDC: { issuer: "Circle" }, EURC: { issuer: "Circle" }, RLUSD: { issuer: "Ripple" } } } },
    esc: (x: any) => String(x), fmt: (x: any) => String(x),
  });
  assert.equal((html.match(/data-issuer-cap="Circle"/g) ?? []).length, 1);
  assert.match(html, /USDC, EURC/); assert.match(html, /value="1000000"/);
  assert.match(html, /value="50000"/); assert.match(html, /Enter 0/); assert.match(html, /disabled/);
  pass("the policy renderer groups coins by issuer and displays overrides and fallback guidance");
  console.log(`Issuer suite: ${checks} checks passed; isolated data, no payments or external calls.`);
} finally {
  server.close(); server.closeAllConnections(); process.chdir(previousCwd);
}
