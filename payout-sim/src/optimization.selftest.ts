// Offline optimizer checks, including an independent exhaustive oracle on small allocation problems.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import path from "node:path";
const cwd = process.cwd(); process.chdir(mkdtempSync(path.join(tmpdir(), "route402-optimize-")));
process.env.LIVE_MARKET = "0"; process.env.ROUTER_NO_LISTEN = "1";
delete process.env.LOCAL_ROUTING; delete process.env.VENUE_QUOTES;
const { optimize } = await import("./router/optimizer.js");
const { searchAllocations, comparePlans } = await import("./router/allocationSearch.js");
const { LIVE_VENUES } = await import("./router/registry.js");
const { setTokenizedConfig } = await import("./router/tokenized.js");
const { toMinor } = await import("./money.js");
let checks = 0;
const check = (label: string, fn: () => void) => { fn(); console.log(`PASS ${++checks}: ${label}`); };
const base = { srcCcy: "USD", destCcy: "EUR", amountType: "SOURCE_FIXED" as const, amount: "150000.00", objective: "cheapest" as const,
  nowUtc: "2026-10-26T10:00:00Z", costOfCashPct: 6, currentBank: { label: "Test bank", fxMarkupBps: 120, wireFeeUsd: 45, businessDays: 2 } };
try {
  LIVE_VENUES.EUR = { bps: 1, capacityUsd: 125_000, source: "isolated test book" };
  const started = performance.now();
  const split: any = optimize({ ...base, provider: "stablecoin", bankComplement: true, issuerHeadroomUsd: { Circle: 83_000 } });
  const elapsed = performance.now() - started;
  check("capacity-boundary splits use 83,000 USD instead of rounding down to an 80,000 USD grid point", () => {
    assert.equal(split.status, "OK");
    const stable = split.allocations.filter((a: any) => a.token);
    const used = stable.reduce((s: number, a: any) => s + a.exposure.amountUsd, 0);
    assert.ok(used >= 82_999.99 && used <= 83_000.000001, String(used));
    assert.equal(split.allocations.reduce((s: bigint, a: any) => s + toMinor(a.amount, "USD"), 0n), 15_000_000n);
    assert.ok(split.cheapest.legs > 1); assert.ok(split.search.plansEvaluated > 0);
  });
  check("recipient-fixed splits include source fees in the issuer limit and preserve the exact payout", () => {
    const d: any = optimize({ ...base, amountType: "RECIPIENT_FIXED", amount: "138750.00", provider: "stablecoin", bankComplement: true, issuerHeadroomUsd: { Circle: 83_000 } });
    assert.equal(d.status, "OK");
    const used = d.allocations.filter((a: any) => a.token).reduce((s: number, a: any) => s + a.exposure.amountUsd, 0);
    assert.ok(used >= 82_999.97 && used <= 83_000.000001, String(used));
    assert.equal(d.totals.recipientNet, "138750.00 EUR");
  });
  const tariff = { network: "kinexys", currencies: ["USD"], countries: ["US"], fxMarginBps: 0, feeUsd: 10, settlementMinutes: 60, tariffSource: "isolated fixture" };
  check("Route402 fees participate in route selection before the winner is chosen", () => {
    setTokenizedConfig(tariff);
    const d: any = optimize({ ...base, destCcy: "USD", amount: "10000.00", beneficiary: { country: "US" }, beneficiaryAcceptsUsdc: true });
    assert.equal(d.status, "OK"); assert.equal(d.allocations[0].routeId, "tokenized:kinexys");
    assert.equal(d.value.platformFee, "0.00 USD");
  });
  check("balanced values both cash and speed; explicit cheapest and fastest keep their meanings", () => {
    setTokenizedConfig({ ...tariff, feeUsd: 30, settlementMinutes: 5 });
    const it = { ...base, destCcy: "USD", amount: "100000.00", beneficiary: { country: "US" },
      excludeCoins: ["USDC", "RLUSD"], currentBank: { ...base.currentBank, wireFeeUsd: 1 } };
    const cheap: any = optimize({ ...it, objective: "cheapest" });
    const fast: any = optimize({ ...it, objective: "fastest" });
    const balanced: any = optimize({ ...it, objective: "balanced" });
    const zeroTime: any = optimize({ ...it, objective: "balanced", costOfCashPct: 0 });
    assert.equal(cheap.allocations[0].routeId, "bank:current_bank");
    assert.equal(fast.allocations[0].routeId, "tokenized:kinexys");
    assert.equal(balanced.allocations[0].routeId, "tokenized:kinexys");
    assert.equal(zeroTime.allocations[0].routeId, "bank:current_bank");
    assert.equal(balanced.cheapest.routeId, cheap.cheapest.routeId);
    assert.equal(balanced.fastest.arrivalUtc, fast.fastest.arrivalUtc);
  });
  setTokenizedConfig(null);
  check("all eight routes are searched and plan results match exhaustive one-unit allocation oracles", () => {
    for (let fixture = 0; fixture < 6; fixture++) {
      const total = 19n;
      const catalog = Array.from({ length: 8 }, (_, i) => ({ id: `route${i}`, cap: 3 + (i * 3 + fixture) % 15,
        unit: 1 + (i * 7 + fixture) % 9, fee: (i + fixture) % 5, time: 1 + (i * 5 + fixture) % 7 }));
      const price = (id: string, amount: bigint): any => {
        const r = catalog.find((c) => c.id === id)!;
        return { routeId: id, amount: amount.toString(), eligible: amount > 0n && amount <= BigInt(r.cap), quote: {},
          costMinor: amount * BigInt(r.unit) + BigInt(r.fee), timeCostMinor: amount * BigInt(r.time), arrivalUtc: `2026-10-${String(26 + r.time).padStart(2, "0")}` };
      };
      const feasible = (kids: any[], complete: boolean) => kids.every((k) => k.eligible) && (!complete || kids.reduce((s, k) => s + BigInt(k.amount), 0n) === total);
      const score = (children: any[]): any => {
        const moneyCostMinor = children.reduce((s, k) => s + k.costMinor, 0n), timeCostMinor = children.reduce((s, k) => s + k.timeCostMinor, 0n);
        return { children, moneyCostMinor, timeCostMinor, scoreMinor: moneyCostMinor + timeCostMinor, feeMinor: 0n, savingsMinor: 0n, arrivalUtc: children.map((k) => k.arrivalUtc).sort().at(-1) };
      };
      const found = searchAllocations({ total, routeIds: catalog.map((r) => r.id), allowSplit: true, price, feasible, score });
      const oracle: any = {};
      const consider = (kids: any[]) => { if (!feasible(kids, true)) return; const p = score(kids);
        for (const objective of ["balanced", "cheapest", "fastest"] as const) if (!oracle[objective] || comparePlans(p, oracle[objective], objective) < 0) oracle[objective] = p; };
      for (let i = 0; i < 8; i++) {
        consider([price(catalog[i].id, total)]);
        for (let j = i + 1; j < 8; j++) for (let a = 1n; a < total; a++) {
          consider([price(catalog[i].id, a), price(catalog[j].id, total - a)]);
          for (let k = j + 1; k < 8; k++) for (let b = 1n; b < total - a; b++)
            consider([price(catalog[i].id, a), price(catalog[j].id, b), price(catalog[k].id, total - a - b)]);
        }
      }
      for (const objective of ["balanced", "cheapest", "fastest"] as const)
        assert.equal(comparePlans(found.best[objective]!, oracle[objective], objective), 0, `${fixture}: ${objective}`);
    }
  });
  check("the comparison screen uses the same money/time objectives as the router", () => {
    const source = readFileSync(new URL("../public/screens.js", import.meta.url), "utf8");
    const start = source.indexOf("function compareRouteOptions("), end = source.indexOf("const recRoute", start);
    const compare = runInNewContext(`${source.slice(start, end)}\ncompareRouteOptions`);
    const cheap = { arrivalUtc: "2026-10-28", selection: { moneyCostMinor: "900", combinedCostMinor: "1800" } };
    const fast = { arrivalUtc: "2026-10-26", selection: { moneyCostMinor: "1400", combinedCostMinor: "1401" } };
    assert.ok(compare(fast, cheap, "balanced") < 0);
    assert.ok(compare(cheap, fast, "cheapest") < 0);
    assert.ok(compare(fast, cheap, "fastest") < 0);
  });
  console.log(`Optimization suite: ${checks} checks passed; representative exact-split search ${elapsed.toFixed(1)} ms; no external calls.`);
} finally { setTokenizedConfig(null); process.chdir(cwd); }
