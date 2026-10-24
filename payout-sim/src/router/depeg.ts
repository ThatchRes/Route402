// Stablecoin safety for the USDC rail: a depeg circuit breaker and an issuer exposure cap.
// USDC fell below 0.87 USD in March 2023 when 3.3B USD of its reserves were stuck at Silicon Valley Bank (CNBC), so the
// rail is paused whenever the live price leaves the company's band. Two public price sources are read; the one furthest
// from 1.00 decides (the cautious choice). No price at all = paused when the policy says fail closed (the default).
// DEPEG_TEST_PRICE overrides the feed for tests and is always labelled as a test override.
import { loadPolicy, loadRequests, type Policy } from "../company/controls.js";

export interface PegCheck { status: "ok" | "paused" | "unknown"; price?: number; deviationPct?: number; bandPct: number;
  sources: { name: string; price?: number; error?: string }[]; reason?: string; at: string; test?: boolean }

let cache: { at: number; check: PegCheck } | null = null;

async function price(url: string, pick: (j: any) => number, ms = 4000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const v = pick(await r.json()); if (!Number.isFinite(v) || v <= 0) throw new Error("no price in response"); return v;
}

export async function usdcPeg(p: Policy = loadPolicy()): Promise<PegCheck> {
  if (cache && Date.now() - cache.at < 60_000 && cache.check.bandPct === p.depegBandPct) return cache.check;
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
  cache = { at: Date.now(), check };
  return check;
}

/** USD value currently in flight or in escrow on the USDC rail (one issuer: Circle). */
export function usdcInFlight(excludeRequestId?: string) {
  return Object.values(loadRequests()).filter((r) => r.id !== excludeRequestId && r.provider === "stablecoin"
    && (["READY", "EXECUTING"].includes(r.status) || (r.status === "AWAITING_DELIVERY" && r.escrow?.state === "LOCKED")))
    .reduce((s, r) => s + r.debitUsd, 0);
}

/** May a stablecoin payment of `amountUsd` go now? Checks the peg and the issuer cap. */
export async function usdcRouteAllowed(amountUsd: number, excludeRequestId?: string) {
  const p = loadPolicy(), peg = await usdcPeg(p), inFlight = usdcInFlight(excludeRequestId);
  if (peg.status === "paused") return { ok: false, reason: `USDC route paused: ${peg.reason}`, peg, inFlight, cap: p.issuerCapUsd };
  if (inFlight + amountUsd > p.issuerCapUsd)
    return { ok: false, reason: `issuer cap: ${Math.round(inFlight).toLocaleString()} USD already in flight with Circle (USDC) + ${Math.round(amountUsd).toLocaleString()} USD would exceed the ${p.issuerCapUsd.toLocaleString()} USD limit`, peg, inFlight, cap: p.issuerCapUsd };
  return { ok: true, peg, inFlight, cap: p.issuerCapUsd };
}
