// Live market data, loaded once per process (top-level await) and cached in data/market.json for 6 hours.
//   mid rates      : European Central Bank reference rates via Frankfurter (api.frankfurter.dev), then
//                    open.er-api.com for currencies the ECB does not publish. Each rate keeps its source and date.
//   bank baseline  : what banks actually charge, measured by Wise's public comparison data
//                    (api.wise.com/v3/comparisons): FX markup over mid for a 100,000 USD send, per corridor.
//   partner rail   : the best all-in price a licensed payment partner quotes in the same data (provider names are not kept).
//                    It prices our "partner" rail: what a partner integration would cost us per corridor.
// If the network is down: last cached data (labeled stale), else the built-in demo table (labeled synthetic).
// LIVE_MARKET=0 forces the built-in demo table (for offline demos and tests).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { MID_PER_USD } from "./registry.js";

const FILE = "data/market.json";
const MAX_AGE_MS = 6 * 3600e3;
const CORRIDORS = ["CAD", "EUR", "GBP", "MXN", "SGD", "JPY", "INR", "BRL", "AUD", "CHF", "PHP", "CNY"];
const SEND_USD = 100_000;

export interface MidInfo { rate: string; source: string; date: string }
export interface BankInfo { bps: number; provider: string; collectedAt: string; basis: string }
export interface PartnerInfo { totalCostBps: number; collectedAt: string; basis: string }
export interface Market {
  mode: "live" | "cached" | "stale-cache" | "synthetic";
  loadedAt: string; mids: Record<string, MidInfo>; banks: Record<string, BankInfo>; partners: Record<string, PartnerInfo>;
  sources: string[]; notes: string[];
}

const BUILTIN_MIDS = { ...MID_PER_USD };
const rateStr = (n: number) => n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");

async function getJson(url: string, ms: number) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
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
  const banks: Record<string, BankInfo> = {}, partners: Record<string, PartnerInfo> = {};
  await Promise.all(CORRIDORS.map(async (dest) => {
    try {
      const w: any = await getJson(`https://api.wise.com/v3/comparisons/?sourceCurrency=USD&targetCurrency=${dest}&sendAmount=${SEND_USD}`, 6000);
      const quotes = (w.providers ?? []).flatMap((p: any) => (p.quotes ?? []).map((q: any) => ({ name: p.name, type: p.type, ...q })));
      // Wise's own quote has markup 0, so its rate is the comparison's mid; total cost = everything below mid incl. fees
      const wise = quotes.find((q: any) => q.name === "Wise");
      const refMid = wise ? Number(wise.rate) : undefined;
      const bankQuotes = quotes.filter((q: any) => q.type === "bank" && Number.isFinite(Number(q.markup)));
      if (bankQuotes.length) {
        const sorted = bankQuotes.map((q: any) => Number(q.markup) * 100).sort((a: number, b: number) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        banks[`USD/${dest}`] = { bps: Math.round(median), provider: bankQuotes.map((q: any) => q.name).join(", "),
          collectedAt: bankQuotes[0].dateCollected, basis: `median bank FX markup for a ${SEND_USD.toLocaleString()} USD send, measured by Wise comparison data` };
      }
      if (refMid) {
        const best = quotes.filter((q: any) => q.type !== "bank" && Number(q.receivedAmount) > 0)
          .map((q: any) => ({ totalCostBps: Math.max(0, Math.round((1 - Number(q.receivedAmount) / (SEND_USD * refMid)) * 10000)), collectedAt: String(q.dateCollected ?? "") }))
          .sort((a: any, b: any) => a.totalCostBps - b.totalCostBps)[0];
        if (best) partners[`USD/${dest}`] = { ...best, basis: `best all-in partner price for a ${SEND_USD.toLocaleString()} USD send, measured by Wise comparison data` };
      }
    } catch (e: any) { notes.push(`USD/${dest} bank comparison unavailable (${e.message})`); }
  }));
  return { mode: "live", loadedAt: new Date().toISOString(), mids, banks, partners, notes,
    sources: ["https://api.frankfurter.dev (European Central Bank reference rates)", "https://open.er-api.com (currencies the ECB does not publish)",
              "https://api.wise.com/v3/comparisons (measured bank and provider pricing)"] };
}

function synthetic(note: string): Market {
  const mids: Record<string, MidInfo> = {};
  for (const [c, r] of Object.entries(BUILTIN_MIDS)) mids[c] = { rate: r, source: "built-in demo table (synthetic)", date: "-" };
  return { mode: "synthetic", loadedAt: new Date().toISOString(), mids, banks: {}, partners: {}, sources: [], notes: [note] };
}

async function loadMarket(): Promise<Market> {
  if (process.env.LIVE_MARKET === "0") return synthetic("LIVE_MARKET=0: using the built-in demo table");
  let cached: Market | undefined;
  try { if (existsSync(FILE)) cached = JSON.parse(readFileSync(FILE, "utf8")); } catch { /* ignore a corrupt cache */ }
  if (cached && !cached.partners) cached = undefined;           // cache from an older version: refetch
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

export function midInfo(ccy: string): MidInfo {
  return MARKET.mids[ccy] ?? { rate: MID_PER_USD[ccy] ?? "?", source: "built-in demo table (synthetic)", date: "-" };
}

export function marketSummary() {
  return { mode: MARKET.mode, loadedAt: MARKET.loadedAt, sources: MARKET.sources, notes: MARKET.notes,
    banks: MARKET.banks, partners: MARKET.partners,
    mids: Object.fromEntries(Object.entries(MARKET.mids).map(([c, m]) => [c, `${m.rate} (${m.source}${m.date !== "-" ? `, ${m.date}` : ""})`])) };
}
