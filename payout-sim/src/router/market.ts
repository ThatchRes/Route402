// Live market data, loaded once per process (top-level await) and cached in data/market.json for 6 hours.
//   mid rates      : European Central Bank reference rates via Frankfurter (api.frankfurter.dev), then
//                    open.er-api.com for currencies the ECB does not publish. Each rate keeps its source and date.
//   bank baseline  : what banks actually charge, measured by Wise's public comparison data
//                    (api.wise.com/v3/comparisons): FX markup over mid for a 100,000 USD send, per corridor.
//   stablecoin FX  : what converting USDC into local currency costs, walked through public order books for a
//                    100,000 USD conversion (Bitso USD/MXN, Coinbase EURC-USDC and XSGD-USDC) plus the venue's taker fee.
// If the network is down: last cached data (labeled stale), else the built-in demo table (labeled synthetic).
// LIVE_MARKET=0 forces the built-in demo table (for offline demos and tests).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { LIVE_VENUES, MID_PER_USD, OFFRAMPS, ONRAMPS } from "./registry.js";

const FILE = "data/market.json";
const MAX_AGE_MS = 6 * 3600e3;
const CORRIDORS = ["CAD", "EUR", "GBP", "MXN", "SGD", "JPY", "INR", "BRL", "AUD", "CHF", "PHP", "CNY"];
const SEND_USD = 100_000;

export interface MidInfo { rate: string; source: string; date: string }
export interface BankInfo { bps: number; provider: string; collectedAt: string; basis: string }
export interface VenueInfo { bps: number; source: string; collectedAt: string; depthUsd: number }
export interface LegInfo extends VenueInfo { kind: "onramp" | "offramp"; token: string; ccy: string }
export interface Market {
  mode: "live" | "cached" | "stale-cache" | "synthetic";
  loadedAt: string; mids: Record<string, MidInfo>; banks: Record<string, BankInfo>; 
  sources: string[]; notes: string[];
  history?: Record<string, [string, number][]>;   // ECB daily reference rates per currency (units per USD), ~120 days
  venues?: Record<string, VenueInfo>;              // measured USDC -> local currency conversion cost, per destination currency
  legs?: Record<string, LegInfo>;                  // a second issuer's on/off-ramp legs, measured from order books (RLUSD on Kraken)
}

const BUILTIN_MIDS = { ...MID_PER_USD };
const rateStr = (n: number) => n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");

async function getJson(url: string, ms: number) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

// Venues that publish an order book for converting USDC (or a USDC-backed dollar balance) into local currency.
// side "bids": sell USD into the book, rate = local per USD. side "asks": buy the local coin with USDC, price = USDC per coin.
// Fees are each venue's published taker fee; Bitso's is its lowest-volume MXN tier, so the cost is never understated.
const VENUES = [
  { ccy: "MXN", url: "https://api.bitso.com/v3/order_book/?book=usd_mxn&aggregate=true", side: "bids" as const, feeBps: 78,
    label: "Bitso USD/MXN order book (USDC-backed dollars to pesos; proxy for USDC->MXNB)", fee: "0.78% Bitso taker fee, lowest-volume tier (bitso.com/fees)" },
  { ccy: "EUR", url: "https://api.exchange.coinbase.com/products/EURC-USDC/book?level=2", side: "asks" as const, feeBps: 0.1,
    label: "Coinbase EURC-USDC order book", fee: "0.001% Coinbase stable-pair taker fee" },
  { ccy: "SGD", url: "https://api.exchange.coinbase.com/products/XSGD-USDC/book?level=2", side: "asks" as const, feeBps: 0.1,
    label: "Coinbase XSGD-USDC order book", fee: "0.001% Coinbase stable-pair taker fee" },
];
async function fetchVenues(mids: Record<string, MidInfo>, notes: string[]): Promise<Record<string, VenueInfo>> {
  const out: Record<string, VenueInfo> = {};
  await Promise.all(VENUES.map(async (v) => {
    try {
      const mid = Number(mids[v.ccy]?.rate); if (!(mid > 0)) throw new Error("no mid rate");
      const book: any = await getJson(v.url, 6000);
      // Each level as [local currency per USD, USD available at that level]
      const levels: [number, number][] = v.side === "bids"
        ? (book.payload?.bids ?? []).map((l: any) => [Number(l.price), Number(l.amount)])
        : (book.asks ?? []).map(([px, sz]: string[]) => [1 / Number(px), Number(px) * Number(sz)]);
      let usd = 0, local = 0;
      for (const [rate, avail] of levels) { const take = Math.min(avail, SEND_USD - usd); if (!(take > 0)) break; usd += take; local += take * rate; }
      const depthUsd = Math.round(levels.reduce((a, [, x]) => a + x, 0));
      if (usd < 1000) throw new Error("order book is empty");
      const vwap = local / usd, spreadBps = Math.max(0, (1 - vwap / mid) * 1e4);   // never priced better than the mid
      const bps = Math.round((spreadBps + v.feeBps) * 10) / 10, at = new Date().toISOString();
      out[v.ccy] = { bps, depthUsd, collectedAt: at, source: `${v.label}: ${Math.round(usd).toLocaleString("en-US")} USD fills at ${vwap.toFixed(4)} ${v.ccy}/USD `
        + `vs mid ${mid} (${spreadBps.toFixed(1)} bps) + ${v.fee}; book depth ${depthUsd.toLocaleString("en-US")} USD; ${at.slice(0, 16).replace("T", " ")} UTC` };
    } catch (e: any) { notes.push(`${v.ccy} stablecoin venue quote unavailable (${e.message}); that stablecoin route stays unpriced`); }
  }));
  return out;
}

// A second stablecoin issuer, so a payment never has to sit entirely with one issuer: buy Ripple's RLUSD with USD and sell
// it for EUR on Kraken's public order books, paid out by SEPA through a licensed partner. Each leg is priced for a 100,000
// USD fill, counting only orders within 1% of the best price (the books also hold far-off orders), plus Kraken's 0.20%
// stablecoin-pair fee at its lowest volume tier (kraken.com/features/fee-schedule), so the cost is never understated.
const KRAKEN = "https://api.kraken.com/0/public/Depth?count=200&pair=";
const LEGS = [
  { key: "onramp:RLUSD", kind: "onramp" as const, token: "RLUSD", ccy: "USD", pair: "RLUSDUSD", side: "asks" as const },
  { key: "offramp:RLUSD:EUR", kind: "offramp" as const, token: "RLUSD", ccy: "EUR", pair: "RLUSDEUR", side: "bids" as const },
];
async function fetchLegs(mids: Record<string, MidInfo>, notes: string[]): Promise<Record<string, LegInfo>> {
  const out: Record<string, LegInfo> = {};
  await Promise.all(LEGS.map(async (g) => {
    try {
      const j: any = await getJson(KRAKEN + g.pair, 6000), book = Object.values<any>(j.result ?? {})[0];
      const raw: [number, number][] = (book?.[g.side] ?? []).map((l: any[]) => [Number(l[0]), Number(l[1])]);
      if (!raw.length) throw new Error("empty order book");
      const best = raw[0][0], near = raw.filter(([px]) => Math.abs(px / best - 1) <= 0.01);
      // [local currency per USD, USD available]: buying RLUSD pays px USD each; selling RLUSD (a USD coin) receives px EUR each
      const levels = near.map(([px, vol]) => (g.side === "asks" ? [1 / px, px * vol] : [px, vol]) as [number, number]);
      let usd = 0, local = 0;
      for (const [rate, avail] of levels) { const take = Math.min(avail, SEND_USD - usd); if (!(take > 0)) break; usd += take; local += take * rate; }
      const mid = g.ccy === "USD" ? 1 : Number(mids[g.ccy]?.rate); if (!(mid > 0)) throw new Error("no mid rate");
      const depthUsd = Math.round(levels.reduce((a, [, x]) => a + x, 0)), vwap = local / usd, spreadBps = Math.max(0, (1 - vwap / mid) * 1e4);
      const bps = Math.round((spreadBps + 20) * 10) / 10, at = new Date().toISOString();
      out[g.key] = { kind: g.kind, token: g.token, ccy: g.ccy, bps, depthUsd, collectedAt: at,
        source: `Kraken ${g.pair} order book: ${Math.round(usd).toLocaleString("en-US")} USD fills at ${vwap.toFixed(4)} ${g.ccy}/USD vs ${g.ccy === "USD" ? "par" : `mid ${mid}`} (${spreadBps.toFixed(1)} bps) + 0.20% Kraken stablecoin-pair fee; depth within 1% of best ${depthUsd.toLocaleString("en-US")} USD; ${at.slice(0, 16).replace("T", " ")} UTC` };
    } catch (e: any) { notes.push(`${g.pair} leg unavailable (${e.message}); the RLUSD route stays unpriced`); }
  }));
  return out;
}

async function fetchLive(): Promise<Market> {
  const mids: Record<string, MidInfo> = { USD: { rate: "1", source: "base", date: "-" } }, notes: string[] = [];
  const ecb: any = await getJson("https://api.frankfurter.dev/v1/latest?from=USD", 5000);
  for (const [c, v] of Object.entries<number>(ecb.rates)) mids[c] = { rate: rateStr(v), source: "ECB reference rate (Frankfurter)", date: ecb.date };
  try {
    const er: any = await getJson("https://open.er-api.com/v6/latest/USD", 5000);
    const date = er.time_last_update_utc ?? "";
    for (const [c, v] of Object.entries<number>(er.rates ?? {})) if (!mids[c] && c in BUILTIN_MIDS) mids[c] = { rate: rateStr(v), source: "open.er-api.com", date };
  } catch (e: any) { notes.push(`secondary rate source unavailable (${e.message}); currencies the ECB does not publish use the built-in demo table`); }

  // Measured bank pricing, one corridor at a time (public endpoint, no key)
  const banks: Record<string, BankInfo> = {};
  await Promise.all(CORRIDORS.map(async (dest) => {
    try {
      const w: any = await getJson(`https://api.wise.com/v3/comparisons/?sourceCurrency=USD&targetCurrency=${dest}&sendAmount=${SEND_USD}`, 6000);
      const quotes = (w.providers ?? []).flatMap((p: any) => (p.quotes ?? []).map((q: any) => ({ name: p.name, type: p.type, ...q })));
      const bankQuotes = quotes.filter((q: any) => q.type === "bank" && Number.isFinite(Number(q.markup)));
      if (bankQuotes.length) {
        const sorted = bankQuotes.map((q: any) => Number(q.markup) * 100).sort((a: number, b: number) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        banks[`USD/${dest}`] = { bps: Math.round(median), provider: bankQuotes.map((q: any) => q.name).join(", "),
          collectedAt: bankQuotes[0].dateCollected, basis: `median bank FX markup for a ${SEND_USD.toLocaleString()} USD send, measured by Wise comparison data` };
      }
    } catch (e: any) { notes.push(`USD/${dest} bank comparison unavailable (${e.message})`); }
  }));
  const [venues, legs] = await Promise.all([fetchVenues(mids, notes), fetchLegs(mids, notes)]);
  // Daily ECB history for FX risk on open bills (non-fatal if unavailable)
  const history: Record<string, [string, number][]> = {};
  try {
    const start = new Date(Date.now() - 120 * 86400e3).toISOString().slice(0, 10);
    const ts: any = await getJson(`https://api.frankfurter.dev/v1/${start}..?from=USD&symbols=${CORRIDORS.join(",")}`, 8000);
    for (const [date, rates] of Object.entries<Record<string, number>>(ts.rates ?? {}).sort(([a], [b]) => a.localeCompare(b)))
      for (const [c, v] of Object.entries(rates)) (history[c] ??= []).push([date, v]);
  } catch (e: any) { notes.push(`rate history unavailable (${e.message}); FX risk on open bills is not computed`); }
  return { mode: "live", loadedAt: new Date().toISOString(), mids, banks, notes, history, venues, legs,
    sources: ["https://api.frankfurter.dev (European Central Bank reference rates)", "https://open.er-api.com (currencies the ECB does not publish)",
              "https://api.wise.com/v3/comparisons (measured bank pricing)", "https://api.bitso.com/v3/order_book (USD/MXN)",
              "https://api.exchange.coinbase.com (EURC-USDC, XSGD-USDC order books)"] };
}

function synthetic(note: string): Market {
  const mids: Record<string, MidInfo> = {};
  for (const [c, r] of Object.entries(BUILTIN_MIDS)) mids[c] = { rate: r, source: "built-in demo table (synthetic)", date: "-" };
  return { mode: "synthetic", loadedAt: new Date().toISOString(), mids, banks: {}, sources: [], notes: [note] };
}

async function loadMarket(): Promise<Market> {
  if (process.env.LIVE_MARKET === "0") return synthetic("LIVE_MARKET=0: using the built-in demo table");
  let cached: Market | undefined;
  try { if (existsSync(FILE)) cached = JSON.parse(readFileSync(FILE, "utf8")); } catch { /* ignore a corrupt cache */ }
  if (cached && (cached as any).partners) cached = undefined;   // cache from an older version: refetch
  if (cached && (!cached.history || !cached.venues || !cached.legs)) cached = { ...cached, loadedAt: "1970-01-01T00:00:00Z" };   // older cache: refetch
  if (cached && cached.mode === "live" && Date.now() - Date.parse(cached.loadedAt) < MAX_AGE_MS) return { ...cached, mode: "cached" };
  try {
    const m = await fetchLive();
    try { mkdirSync("data", { recursive: true }); writeFileSync(FILE, JSON.stringify(m, null, 2)); } catch { /* cache is optional */ }
    return m;
  } catch (e: any) {
    if (cached) return { ...cached, mode: "stale-cache", notes: [...cached.notes, `live fetch failed (${e.message}); using data from ${cached.loadedAt}`] };
    return synthetic(`live fetch failed (${e.message}); using the built-in demo table`);
  }
}

export const MARKET: Market = await loadMarket();
// Every optimizer price uses these mids: overwrite the demo table in place (unknown currencies keep demo values, labeled).
for (const [c, m] of Object.entries(MARKET.mids)) MID_PER_USD[c] = m.rate;
// Measured stablecoin conversion costs price the stablecoin rail; each route is capped at the depth actually in the book
for (const [c, v] of Object.entries(MARKET.venues ?? {})) LIVE_VENUES[c] = { bps: v.bps, source: v.source, capacityUsd: v.depthUsd };
// The second issuer's legs join the route catalog only when both were measured (an on-ramp with no way out is no route)
const on = MARKET.legs?.["onramp:RLUSD"], off = MARKET.legs?.["offramp:RLUSD:EUR"];
if (on && off) {
  ONRAMPS.push({ src: "USD", token: "RLUSD", bps: on.bps, fixedUsd: 0, capacityUsd: on.depthUsd, source: on.source });
  OFFRAMPS.push({ id: "rlusd_eur_kraken", label: "RLUSD sold for EUR on Kraken, SEPA payout through a licensed partner", tokens: ["RLUSD"], networks: ["ethereum"], dest: ["EUR"],
    tiers: [{ upToUsd: Infinity, bps: off.bps }], fixedUsd: 0, capacityUsd: off.depthUsd, payoutMin: 30, cutoffUtcHour: 24, always: true, source: off.source });
}

/** Measured bank markup for a corridor. Falls back to the average of measured corridors, then to the caller's value. */
export function bankMarkup(src: string, dest: string, fallbackBps: number): { bps: number; basis: string } {
  const k = MARKET.banks[`${src}/${dest}`] ?? MARKET.banks[`${dest}/${src}`];
  if (k) return { bps: k.bps, basis: `${k.provider}, ${k.basis} (${k.collectedAt.slice(0, 10)})` };
  const all = Object.values(MARKET.banks);
  if (all.length) {
    const avg = Math.round(all.reduce((s, b) => s + b.bps, 0) / all.length);
    return { bps: avg, basis: `no bank quote published for ${src}/${dest}; average of ${all.length} measured bank corridors` };
  }
  return { bps: fallbackBps, basis: `assumption (${fallbackBps} bps): live bank data unavailable` };
}

export function rateHistory(): Record<string, [string, number][]> { return MARKET.history ?? {}; }

export function midInfo(ccy: string): MidInfo {
  return MARKET.mids[ccy] ?? { rate: MID_PER_USD[ccy] ?? "?", source: "built-in demo table (synthetic)", date: "-" };
}

export function marketSummary() {
  return { mode: MARKET.mode, loadedAt: MARKET.loadedAt, sources: MARKET.sources, notes: MARKET.notes,
    banks: MARKET.banks,
    mids: Object.fromEntries(Object.entries(MARKET.mids).map(([c, m]) => [c, `${m.rate} (${m.source}${m.date !== "-" ? `, ${m.date}` : ""})`])) };
}
