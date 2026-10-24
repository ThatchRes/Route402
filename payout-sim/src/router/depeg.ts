// Stablecoin safety for the USDC rail: a depeg circuit breaker and an issuer exposure cap.
// USDC fell below 0.87 USD in March 2023 when 3.3B USD of its reserves were stuck at Silicon Valley Bank (CNBC), so the
// rail is paused whenever the live price leaves the company's band. Two public price sources are read; the one furthest
// from 1.00 decides (the cautious choice). No price at all = paused when the policy says fail closed (the default).
// DEPEG_TEST_PRICE overrides the feed for tests and is always labelled as a test override.
import { loadPolicy, loadRequests, type Policy } from "../company/controls.js";
import { load } from "./store.js";
import { STABLECOINS } from "./compliance.js";

export interface PegCheck { status: "ok" | "paused" | "unknown"; price?: number; deviationPct?: number; bandPct: number;
  sources: { name: string; price?: number; error?: string }[]; reason?: string; at: string; test?: boolean }

let cache: { at: number; ttl: number; check: PegCheck } | null = null;

async function price(url: string, pick: (j: any) => number, ms = 4000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const v = pick(await r.json()); if (!Number.isFinite(v) || v <= 0) throw new Error("no price in response"); return v;
}

export async function usdcPeg(p: Policy = loadPolicy()): Promise<PegCheck> {
  if (process.env.LOCAL_ROUTING === "1") return { status: "paused", bandPct: p.depegBandPct, sources: [], at: new Date().toISOString(), test: true,
    reason: "stablecoin settlement is disabled in local simulation; no live price feeds are requested" };
  if (cache && Date.now() - cache.at < cache.ttl && cache.check.bandPct === p.depegBandPct) return cache.check;
  const at = new Date().toISOString(), sources: PegCheck["sources"] = [];
  if (process.env.DEPEG_TEST_PRICE) sources.push({ name: "test override (DEPEG_TEST_PRICE)", price: Number(process.env.DEPEG_TEST_PRICE) });
  else {
    const feeds: [string, string, (j: any) => number][] = [
      ["Coinbase USDC-USD spot", "https://api.coinbase.com/v2/prices/USDC-USD/spot", (j) => Number(j?.data?.amount)],
      ["Kraken USDCUSD last trade", "https://api.kraken.com/0/public/Ticker?pair=USDCUSD", (j) => Number((Object.values(j?.result ?? {})[0] as any)?.c?.[0])],
    ];
    await Promise.all(feeds.map(async ([name, url, pick]) => { try { sources.push({ name, price: await price(url, pick) }); } catch (e: any) { sources.push({ name, error: String(e.message).slice(0, 80) }); } }));
  }
  const priced = sources.filter((s) => s.price !== undefined);
  let check: PegCheck;
  if (!priced.length) check = { status: p.depegFailClosed ? "paused" : "unknown", bandPct: p.depegBandPct, sources, at,
    reason: p.depegFailClosed ? "no live USDC price could be read; the policy pauses the USDC route until one can" : "no live USDC price could be read (policy allows the route anyway)" };
  else {
    const worst = priced.reduce((a, b) => (Math.abs(b.price! - 1) > Math.abs(a.price! - 1) ? b : a));
    const dev = Math.abs(worst.price! - 1) * 100;
    check = { status: dev > p.depegBandPct ? "paused" : "ok", price: worst.price, deviationPct: Number(dev.toFixed(3)), bandPct: p.depegBandPct, sources, at,
      test: !!process.env.DEPEG_TEST_PRICE,
      reason: dev > p.depegBandPct ? `USDC at ${worst.price!.toFixed(4)} (${worst.name}) is ${dev.toFixed(2)}% from 1.00, outside the ${p.depegBandPct}% band` : undefined };
  }
  // A good reading holds for a minute; a failed one (e.g. timeouts while the router is still starting) is retried after 5 s
  cache = { at: Date.now(), ttl: check.price === undefined ? 5_000 : 60_000, check };
  return check;
}

/** USD value currently in flight or in escrow with each stablecoin issuer, from each request's own route legs. */
export function issuerInFlight(excludeRequestId?: string): Record<string, number> {
  const db = load(), out: Record<string, number> = {};
  for (const r of Object.values(loadRequests())) {
    if (r.id === excludeRequestId || !(["READY", "EXECUTING"].includes(r.status) || (r.status === "AWAITING_DELIVERY" && r.escrow?.state === "LOCKED"))) continue;
    const legs: any[] = db.intents[r.intentId]?.decision?.allocations ?? [];
    for (const a of legs.length ? legs : [{ routeId: r.route, quote: { sourceDebit: { display: `${r.debitUsd} USD` } } }]) {
      const coin = String(a.routeId ?? "").startsWith("coin:") ? String(a.routeId).split(":")[1].split(">")[0] : null; if (!coin) continue;
      const iss = STABLECOINS[coin]?.issuer ?? coin; out[iss] = (out[iss] ?? 0) + Number(String(a.quote?.sourceDebit?.display ?? "0").split(" ")[0]);
    }
  }
  return out;
}
/** USD value in flight or in escrow with Circle (USDC), kept for the USDC escrow and the dashboard. */
export const usdcInFlight = (excludeRequestId?: string) => issuerInFlight(excludeRequestId).Circle ?? 0;
/** How much more each issuer may hold under the company's per-issuer cap (the same cap applies to every issuer). */
export function issuerHeadroom(p: Policy = loadPolicy(), excludeRequestId?: string): Record<string, number> {
  const used = issuerInFlight(excludeRequestId), out: Record<string, number> = {};
  for (const iss of new Set(Object.values(STABLECOINS).map((x) => x.issuer))) out[iss] = Math.max(0, p.issuerCapUsd - (used[iss] ?? 0));
  return out;
}
/** May this plan's stablecoin legs go now? The USDC price breaker (when a leg holds USDC) and each issuer's cap. */
export async function stablecoinPlanAllowed(allocations: any[], excludeRequestId?: string) {
  const p = loadPolicy(), per: Record<string, number> = {}, coins = new Set<string>();
  for (const a of allocations) {
    const id = String(a.routeId ?? ""); if (!id.startsWith("coin:")) continue;
    const coin = id.split(":")[1].split(">")[0]; coins.add(coin);
    const iss = STABLECOINS[coin]?.issuer ?? coin; per[iss] = (per[iss] ?? 0) + Number(String(a.quote?.sourceDebit?.display ?? a.sourceDebit ?? "0").split(" ")[0]);
  }
  const peg = coins.has("USDC") ? await usdcPeg(p) : null;
  if (peg?.status === "paused") return { ok: false, reason: `USDC route paused: ${peg.reason}`, peg, perIssuer: per };
  const used = issuerInFlight(excludeRequestId);
  for (const [iss, v] of Object.entries(per)) if ((used[iss] ?? 0) + v > p.issuerCapUsd)
    return { ok: false, reason: `issuer cap: ${Math.round(used[iss] ?? 0).toLocaleString()} USD already in flight with ${iss} + ${Math.round(v).toLocaleString()} USD would exceed the ${p.issuerCapUsd.toLocaleString()} USD per-issuer limit`, peg, perIssuer: per };
  return { ok: true, peg, perIssuer: per };
}

/** May a stablecoin payment of `amountUsd` go now? Checks the peg and the issuer cap. */
export async function usdcRouteAllowed(amountUsd: number, excludeRequestId?: string) {
  const p = loadPolicy(), peg = await usdcPeg(p), inFlight = usdcInFlight(excludeRequestId);
  if (peg.status === "paused") return { ok: false, reason: `USDC route paused: ${peg.reason}`, peg, inFlight, cap: p.issuerCapUsd };
  if (inFlight + amountUsd > p.issuerCapUsd)
    return { ok: false, reason: `issuer cap: ${Math.round(inFlight).toLocaleString()} USD already in flight with Circle (USDC) + ${Math.round(amountUsd).toLocaleString()} USD would exceed the ${p.issuerCapUsd.toLocaleString()} USD limit`, peg, inFlight, cap: p.issuerCapUsd };
  return { ok: true, peg, inFlight, cap: p.issuerCapUsd };
}
