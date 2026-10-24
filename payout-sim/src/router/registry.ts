// Routing catalog. Bank routes = the company's own bank only. Stablecoin rail = OUR rail, with sourced costs (SOURCES below).
// MID_PER_USD is only the offline fallback table: live mid rates replace it at startup (market.ts).
// Replace each entry with real provider quotes/capabilities when integrations exist (same shapes).

/** Synthetic mid rates per 1 USD. Pairs not listed need explicit rates supplied with the intent. */
export const MID_PER_USD: Record<string, string> = {
  USD: "1", CAD: "1.3700", EUR: "0.9250", GBP: "0.7900", JPY: "152.80", MXN: "18.40", BRL: "5.4500", INR: "83.30",
  KRW: "1388.0", PHP: "56.10", NGN: "1550.0", KWD: "0.3075", CHF: "0.8800", AUD: "1.5200", SGD: "1.3400", HKD: "7.8100",
  CNY: "7.2400", ZAR: "18.20", AED: "3.6725", SAR: "3.7500", TRY: "32.50", PLN: "3.9800", SEK: "10.45", NOK: "10.70",
  DKK: "6.9000", COP: "3900", CLP: "935", ARS: "870", EGP: "47.50", KES: "129.0", IDR: "15800", THB: "36.20",
  VND: "25400", PKR: "278.5", BDT: "117.5", NZD: "1.6600", ILS: "3.7000", MAD: "10.05", GHS: "14.60", UAH: "41.20",
};

export interface Tier { upToUsd: number; bps: number }          // size-dependent spread
export interface BankProvider {
  id: string; label: string; fixedUsd: number; tiers: Tier[]; businessDays: number; sameDayBeforeUtcHour?: number;
  cutoffUtcHour: number; capacityUsd: number; dest: string[] | "*"; isBaseline?: boolean;
}
// Only the company's OWN bank. No third-party FX providers are routed to.
// Fallback values when the company's bank terms are not set: wire fee = median outgoing international wire fee at US banks
// ($45, NerdWallet survey of bank fee schedules); FX markup 120 bps = labeled assumption, replaced by measured data when live.
export const BANKS: BankProvider[] = [
  { id: "legacy_wire", label: "Your bank (international wire)", fixedUsd: 45, tiers: [{ upToUsd: Infinity, bps: 120 }],
    businessDays: 2, cutoffUtcHour: 21, capacityUsd: Infinity, dest: "*", isBaseline: true },
];

// STABLECOIN CATALOG: fiat-reserved coins only (no algorithmic or synthetic-dollar designs). Issuer, peg,
// networks, decimals and liquidity are DEMO ASSUMPTIONS: verify each contract, issuer status and venue before enabling.
// A coin is used only when it is cheaper or faster AND passes the stability gate.
export interface Token { id: string; label: string; peg: string; pegDeviation: number; decimals: number; networks: string[] }
export const TOKENS: Token[] = [
  // USD
  { id: "USDC", label: "USDC (Circle)", peg: "USD", pegDeviation: 0.0002, decimals: 6, networks: ["base", "solana", "ethereum", "polygon", "arbitrum", "stellar"] },
  { id: "PYUSD", label: "PayPal USD (Paxos)", peg: "USD", pegDeviation: 0.0005, decimals: 6, networks: ["ethereum", "solana"] },
  { id: "USDG", label: "Global Dollar (Paxos)", peg: "USD", pegDeviation: 0.0004, decimals: 6, networks: ["ethereum", "solana"] },
  { id: "USDP", label: "Pax Dollar (Paxos)", peg: "USD", pegDeviation: 0.0006, decimals: 18, networks: ["ethereum"] },
  { id: "RLUSD", label: "Ripple USD", peg: "USD", pegDeviation: 0.0005, decimals: 18, networks: ["ethereum", "xrpl"] },
  { id: "GUSD", label: "Gemini Dollar", peg: "USD", pegDeviation: 0.0008, decimals: 2, networks: ["ethereum"] },
  // EUR
  { id: "EURC", label: "EURC (Circle)", peg: "EUR", pegDeviation: 0.0004, decimals: 6, networks: ["base", "ethereum", "solana", "stellar"] },
  { id: "EURCV", label: "EUR CoinVertible (SG-Forge)", peg: "EUR", pegDeviation: 0.0006, decimals: 18, networks: ["ethereum", "solana"] },
  { id: "EURE", label: "EURe (Monerium)", peg: "EUR", pegDeviation: 0.0007, decimals: 18, networks: ["ethereum", "polygon", "gnosis"] },
  // local-currency coins (open direct local payout corridors)
  { id: "QCAD", label: "QCAD (Stablecorp)", peg: "CAD", pegDeviation: 0.0008, decimals: 2, networks: ["ethereum", "solana", "stellar"] },
  { id: "TGBP", label: "tGBP (BCP)", peg: "GBP", pegDeviation: 0.0008, decimals: 18, networks: ["ethereum"] },
  { id: "XSGD", label: "XSGD (StraitsX)", peg: "SGD", pegDeviation: 0.0006, decimals: 6, networks: ["ethereum", "polygon", "base"] },
  { id: "AUDD", label: "AUDD (Novatti)", peg: "AUD", pegDeviation: 0.0008, decimals: 6, networks: ["ethereum", "solana", "stellar"] },
  { id: "JPYC", label: "JPYC", peg: "JPY", pegDeviation: 0.0009, decimals: 18, networks: ["ethereum", "polygon"] },
  { id: "GYEN", label: "GYEN (GMO Trust)", peg: "JPY", pegDeviation: 0.0009, decimals: 6, networks: ["ethereum", "solana"] },
  { id: "MXNB", label: "MXNB (Juno)", peg: "MXN", pegDeviation: 0.0009, decimals: 6, networks: ["arbitrum", "ethereum"] },
  { id: "BRZ", label: "BRZ (Transfero)", peg: "BRL", pegDeviation: 0.0009, decimals: 4, networks: ["ethereum", "solana", "polygon"] },
  { id: "TRYB", label: "BiLira TRYB", peg: "TRY", pegDeviation: 0.0010, decimals: 6, networks: ["ethereum", "solana", "avalanche"] },
  { id: "ZARP", label: "ZARP", peg: "ZAR", pegDeviation: 0.0010, decimals: 18, networks: ["ethereum", "polygon", "base"] },
  { id: "XIDR", label: "XIDR (StraitsX)", peg: "IDR", pegDeviation: 0.0010, decimals: 6, networks: ["ethereum", "polygon"] },
  { id: "PHPC", label: "PHPC (Coins.ph)", peg: "PHP", pegDeviation: 0.0010, decimals: 6, networks: ["ronin", "polygon"] },
  { id: "CNGN", label: "cNGN", peg: "NGN", pegDeviation: 0.0010, decimals: 6, networks: ["base", "ethereum"] },
];
/** Hard stability gate: a coin trading further than this from its peg is excluded entirely. */
export const STABILITY = { maxPegDeviation: 0.001 };

// ---------------------------------------------------------------- OUR stablecoin rail (sourced; nothing invented)
// Every number below has a source. Where a provider does not publish a price (USDC -> local-currency coin conversion),
// the route is NOT priced: it needs a live venue quote (VENUE_QUOTES env, see venueQuote()) before it can be offered.
export const SOURCES = {
  circleMint: "Circle Mint: standard USDC redemption free up to $15M/day, 0.1% above (circle.com/blog/usdc-redemption-process-updated-to-expand-liquidity-worldwide)",
  networkFees: "Spark, Stablecoin Transfer Cost Comparison by Chain (mid-2026): Base $0.005-0.01, Solana $0.001-0.005 normal congestion",
  wireFee: "NerdWallet survey of US bank fee schedules: median outgoing international wire fee $45",
  straitsx: "StraitsX business fee schedule: SGD FAST transfer out 1 XSGD; USDC/XSGD swap price not published",
  juno: "Bitso/Juno docs: MXNB redemption to a bank account via SPEI, minimum 100 MXNB; fee not published",
  circleFx: "Circle Mint cross-currency exchange USDC<->EURC: quotes valid 3 s; fee/spread not published",
};

export interface Onramp { src: string; token: string; bps: number; fixedUsd: number; capacityUsd: number; source: string }
// USD -> USDC through Circle Mint: free up to $15M/day (redemption terms; minting has no published fee)
export const ONRAMPS: Onramp[] = [
  { src: "USD", token: "USDC", bps: 0, fixedUsd: 0, capacityUsd: 15_000_000, source: SOURCES.circleMint },
];

/** Network fee per transfer (upper end of "normal congestion", Spark mid-2026) and time to finality (minutes, labeled assumption). */
export const NETWORK_COST: Record<string, { gasUsd: number; finalityMin: number }> = {
  base: { gasUsd: 0.01, finalityMin: 1 }, solana: { gasUsd: 0.005, finalityMin: 1 }, ethereum: { gasUsd: 5, finalityMin: 6 },
  polygon: { gasUsd: 0.005, finalityMin: 2 }, arbitrum: { gasUsd: 0.05, finalityMin: 1 },
};
export interface Network { token: string; id: string; gasUsd: number; finalityMin: number; x402Executable?: boolean }
export const NETWORKS: Network[] = TOKENS.flatMap((t) => t.networks.filter((n) => NETWORK_COST[n]).map((n) => ({ token: t.id, id: n, ...NETWORK_COST[n],
  x402Executable: t.id === "USDC" && n === "base" })));

/** USDC -> local-currency coin. Conversion price is not published by any of these venues: priced only with a venue quote. */
export interface Swap { from: string; to: string; networks: string[]; capacityUsd: number; minutes: number; source: string }
export const SWAPS: Swap[] = [
  { from: "USDC", to: "EURC", networks: ["base", "ethereum", "solana"], capacityUsd: 15_000_000, minutes: 1, source: SOURCES.circleFx },
  { from: "USDC", to: "XSGD", networks: ["polygon", "base", "ethereum"], capacityUsd: 1_000_000, minutes: 1, source: SOURCES.straitsx },
  { from: "USDC", to: "MXNB", networks: ["arbitrum"], capacityUsd: 1_000_000, minutes: 1, source: SOURCES.juno },
];

export interface Offramp {
  id: string; label: string; tokens: string[]; networks: string[]; dest: string[] | "*"; tiers: Tier[];
  fixedUsd: number; capacityUsd: number; payoutMin: number; cutoffUtcHour: number;
  fixedDest?: number;            // fee in the destination currency (e.g. 1 XSGD for a FAST payout)
  always?: boolean;              // 24/7: no bank cut-off or business days on this leg
  requiresUsdcWallet?: boolean;  // the supplier must accept USDC (wallet on file)
  source: string;
}
export const OFFRAMPS: Offramp[] = [
  // USD-invoiced supplier that accepts USDC: delivered to its wallet, exact amount, 24/7; cost = network fee only
  { id: "supplier_usdc_wallet", label: "Supplier's USDC wallet (exact amount, 24/7)", tokens: ["USDC"], networks: ["base", "solana"], dest: ["USD"],
    tiers: [{ upToUsd: Infinity, bps: 0 }], fixedUsd: 0, capacityUsd: 15_000_000, payoutMin: 0, cutoffUtcHour: 24, always: true, requiresUsdcWallet: true,
    source: SOURCES.networkFees },
  { id: "eurc_redeem", label: "EURC redemption to EUR (Circle Mint)", tokens: ["EURC"], networks: ["base", "ethereum", "solana"], dest: ["EUR"],
    tiers: [{ upToUsd: Infinity, bps: 0 }], fixedUsd: 0, capacityUsd: 15_000_000, payoutMin: 30, cutoffUtcHour: 17, source: SOURCES.circleFx },
  { id: "xsgd_redeem", label: "XSGD redemption to SGD via FAST (StraitsX)", tokens: ["XSGD"], networks: ["polygon", "base", "ethereum"], dest: ["SGD"],
    tiers: [{ upToUsd: Infinity, bps: 0 }], fixedUsd: 0, fixedDest: 1, capacityUsd: 1_000_000, payoutMin: 10, cutoffUtcHour: 24, always: true, source: SOURCES.straitsx },
  { id: "mxnb_redeem", label: "MXNB redemption to MXN via SPEI (Juno)", tokens: ["MXNB"], networks: ["arbitrum"], dest: ["MXN"],
    tiers: [{ upToUsd: Infinity, bps: 0 }], fixedUsd: 0, capacityUsd: 1_000_000, payoutMin: 10, cutoffUtcHour: 24, always: true, source: SOURCES.juno },
];

/** A live conversion quote for USDC -> local coin + redemption, entered from the venue (never a default).
 *  VENUE_QUOTES='{"EUR":{"bps":12,"source":"Circle Mint quote 2026-10-24 14:05"}}' */
export function venueQuote(destCcy: string): { bps: number; source: string } | null {
  try {
    const q = JSON.parse(process.env.VENUE_QUOTES ?? "{}")[destCcy];
    return q && Number.isFinite(Number(q.bps)) && q.source ? { bps: Number(q.bps), source: String(q.source) } : null;
  } catch { return null; }
}

// Our price (a pricing choice, not market data): a flat fee per payment sent on OUR stablecoin rail, set below the $45 median
// international wire fee it replaces. Payments through the company's own bank and all treasury suggestions are free.
export const PLATFORM = { feeBpsOfRailVolume: 15, timeValueBpsPerDay: 1.5 };   // 0.15% of rail volume, capped at the payment's saving

