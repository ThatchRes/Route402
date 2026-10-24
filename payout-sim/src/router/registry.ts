// SYNTHETIC routing catalog. Every number is a labeled demo assumption, not market data or a provider offer.
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
export const BANKS: BankProvider[] = [
  { id: "legacy_wire", label: "Correspondent wire (customer's current policy)", fixedUsd: 35, tiers: [{ upToUsd: Infinity, bps: 80 }],
    businessDays: 2, cutoffUtcHour: 21, capacityUsd: Infinity, dest: "*", isBaseline: true },
  { id: "negotiated_bank", label: "Negotiated bank FX", fixedUsd: 20,
    tiers: [{ upToUsd: 100_000, bps: 45 }, { upToUsd: 1_000_000, bps: 30 }, { upToUsd: Infinity, bps: 20 }],
    businessDays: 1, cutoffUtcHour: 20, capacityUsd: Infinity, dest: "*" },
  { id: "local_rail_fx", label: "Local-rail FX partner", fixedUsd: 8, tiers: [{ upToUsd: Infinity, bps: 55 }],
    businessDays: 1, sameDayBeforeUtcHour: 18, cutoffUtcHour: 18, capacityUsd: 250_000, dest: ["CAD", "EUR", "GBP", "MXN", "BRL", "INR", "PHP"] },
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

export interface Onramp { src: string; token: string; bps: number; fixedUsd: number; capacityUsd: number }
// Fiat -> coin mints/purchases. Coins pegged to the source currency mint at par minus a small fee.
export const ONRAMPS: Onramp[] = [
  { src: "USD", token: "USDC", bps: 5, fixedUsd: 0, capacityUsd: 5_000_000 },
  { src: "USD", token: "PYUSD", bps: 0, fixedUsd: 0, capacityUsd: 150_000 },
  { src: "USD", token: "USDG", bps: 2, fixedUsd: 0, capacityUsd: 1_000_000 },
  { src: "USD", token: "USDP", bps: 3, fixedUsd: 0, capacityUsd: 1_000_000 },
  { src: "USD", token: "RLUSD", bps: 4, fixedUsd: 0, capacityUsd: 2_000_000 },
  { src: "USD", token: "GUSD", bps: 5, fixedUsd: 0, capacityUsd: 500_000 },
  { src: "EUR", token: "EURC", bps: 8, fixedUsd: 0, capacityUsd: 2_000_000 },
  { src: "EUR", token: "EURCV", bps: 5, fixedUsd: 0, capacityUsd: 1_000_000 },
  { src: "EUR", token: "EURE", bps: 0, fixedUsd: 0, capacityUsd: 500_000 },
  { src: "EUR", token: "USDC", bps: 30, fixedUsd: 0, capacityUsd: 2_000_000 },
  { src: "CAD", token: "QCAD", bps: 10, fixedUsd: 0, capacityUsd: 500_000 },
  { src: "CAD", token: "USDC", bps: 25, fixedUsd: 0, capacityUsd: 1_000_000 },
  { src: "GBP", token: "TGBP", bps: 10, fixedUsd: 0, capacityUsd: 500_000 },
  { src: "GBP", token: "USDC", bps: 25, fixedUsd: 0, capacityUsd: 1_000_000 },
  { src: "SGD", token: "XSGD", bps: 10, fixedUsd: 0, capacityUsd: 1_000_000 },
  { src: "AUD", token: "AUDD", bps: 10, fixedUsd: 0, capacityUsd: 500_000 },
];

/** Gas and finality per network (USD-equivalent, synthetic). */
export const NETWORK_COST: Record<string, { gasUsd: number; finalityMin: number }> = {
  base: { gasUsd: 0.01, finalityMin: 2 }, solana: { gasUsd: 0.002, finalityMin: 1 }, ethereum: { gasUsd: 2.5, finalityMin: 6 },
  polygon: { gasUsd: 0.02, finalityMin: 3 }, arbitrum: { gasUsd: 0.03, finalityMin: 2 }, stellar: { gasUsd: 0.001, finalityMin: 1 },
  xrpl: { gasUsd: 0.001, finalityMin: 1 }, gnosis: { gasUsd: 0.01, finalityMin: 2 }, avalanche: { gasUsd: 0.05, finalityMin: 1 },
  ronin: { gasUsd: 0.01, finalityMin: 1 },
};
export interface Network { token: string; id: string; gasUsd: number; finalityMin: number; x402Executable?: boolean }
export const NETWORKS: Network[] = TOKENS.flatMap((t) => t.networks.map((n) => ({ token: t.id, id: n, ...NETWORK_COST[n],
  x402Executable: t.id === "USDC" && n === "base" })));

/** On-chain FX between stablecoins (pool/RFQ venues), same network. Opens USDC -> local-coin corridors. */
export interface Swap { from: string; to: string; networks: string[]; bps: number; capacityUsd: number; minutes: number }
export const SWAPS: Swap[] = [
  { from: "USDC", to: "EURC", networks: ["base", "ethereum", "solana"], bps: 8, capacityUsd: 2_000_000, minutes: 1 },
  { from: "USDC", to: "XSGD", networks: ["ethereum", "polygon", "base"], bps: 12, capacityUsd: 500_000, minutes: 1 },
  { from: "USDC", to: "QCAD", networks: ["ethereum", "solana"], bps: 15, capacityUsd: 300_000, minutes: 1 },
  { from: "USDC", to: "AUDD", networks: ["ethereum", "solana"], bps: 15, capacityUsd: 300_000, minutes: 1 },
  { from: "USDC", to: "MXNB", networks: ["arbitrum"], bps: 15, capacityUsd: 300_000, minutes: 1 },
  { from: "USDC", to: "BRZ", networks: ["solana", "polygon"], bps: 18, capacityUsd: 300_000, minutes: 1 },
  { from: "USDC", to: "TRYB", networks: ["solana", "avalanche"], bps: 25, capacityUsd: 150_000, minutes: 1 },
  { from: "USDC", to: "JPYC", networks: ["polygon"], bps: 20, capacityUsd: 200_000, minutes: 1 },
  { from: "USDC", to: "GYEN", networks: ["ethereum"], bps: 20, capacityUsd: 200_000, minutes: 1 },
  { from: "USDC", to: "ZARP", networks: ["base", "polygon"], bps: 25, capacityUsd: 100_000, minutes: 1 },
  { from: "USDC", to: "XIDR", networks: ["polygon"], bps: 25, capacityUsd: 150_000, minutes: 1 },
  { from: "USDC", to: "PHPC", networks: ["polygon"], bps: 25, capacityUsd: 100_000, minutes: 1 },
  { from: "USDC", to: "CNGN", networks: ["base"], bps: 30, capacityUsd: 100_000, minutes: 1 },
  { from: "USDC", to: "TGBP", networks: ["ethereum"], bps: 15, capacityUsd: 300_000, minutes: 1 },
  { from: "USDG", to: "XSGD", networks: ["ethereum"], bps: 10, capacityUsd: 300_000, minutes: 1 },
  { from: "EURC", to: "USDC", networks: ["base", "ethereum", "solana"], bps: 8, capacityUsd: 2_000_000, minutes: 1 },
];

export interface Offramp {
  id: string; label: string; tokens: string[]; networks: string[]; dest: string[] | "*"; tiers: Tier[];
  fixedUsd: number; capacityUsd: number; payoutMin: number; cutoffUtcHour: number;
}
export const OFFRAMPS: Offramp[] = [
  { id: "payout_partner_ca", label: "Canadian payout partner", tokens: ["USDC", "PYUSD"], networks: ["base", "solana", "ethereum"],
    dest: ["CAD"], tiers: [{ upToUsd: 50_000, bps: 35 }, { upToUsd: 150_000, bps: 25 }, { upToUsd: Infinity, bps: 20 }],
    fixedUsd: 4, capacityUsd: 200_000, payoutMin: 30, cutoffUtcHour: 20 },
  { id: "payout_partner_global", label: "Global payout network", tokens: ["USDC"], networks: ["base", "solana", "polygon", "ethereum"],
    dest: "*", tiers: [{ upToUsd: 100_000, bps: 60 }, { upToUsd: Infinity, bps: 45 }], fixedUsd: 3, capacityUsd: 500_000, payoutMin: 120, cutoffUtcHour: 19 },
  { id: "eurc_desk", label: "EUR coin redemption (SEPA Instant)", tokens: ["EURC", "EURCV", "EURE"], networks: ["base", "ethereum", "solana", "polygon", "gnosis"],
    dest: ["EUR"], tiers: [{ upToUsd: Infinity, bps: 5 }], fixedUsd: 1, capacityUsd: 1_000_000, payoutMin: 20, cutoffUtcHour: 17 },
  { id: "usd_redemption", label: "USD coin redemption (domestic wire/RTP)", tokens: ["USDC", "PYUSD", "USDG", "USDP", "RLUSD", "GUSD"],
    networks: ["base", "solana", "ethereum", "polygon", "arbitrum", "stellar", "xrpl"], dest: ["USD"], tiers: [{ upToUsd: Infinity, bps: 3 }],
    fixedUsd: 2, capacityUsd: 5_000_000, payoutMin: 30, cutoffUtcHour: 21 },
  // local-coin redemption at par into local rails: the cheap last mile for many corridors
  ...([["QCAD", "CAD", ["ethereum", "solana", "stellar"], 30, 20], ["TGBP", "GBP", ["ethereum"], 20, 16], ["XSGD", "SGD", ["ethereum", "polygon", "base"], 15, 10],
       ["AUDD", "AUD", ["ethereum", "solana", "stellar"], 30, 7], ["JPYC", "JPY", ["ethereum", "polygon"], 60, 6], ["GYEN", "JPY", ["ethereum", "solana"], 60, 6],
       ["MXNB", "MXN", ["arbitrum", "ethereum"], 20, 22], ["BRZ", "BRL", ["ethereum", "solana", "polygon"], 20, 21], ["TRYB", "TRY", ["ethereum", "solana", "avalanche"], 30, 14],
       ["ZARP", "ZAR", ["ethereum", "polygon", "base"], 30, 15], ["XIDR", "IDR", ["ethereum", "polygon"], 30, 9], ["PHPC", "PHP", ["ronin", "polygon"], 20, 9],
       ["CNGN", "NGN", ["base", "ethereum"], 30, 15]] as [string, string, string[], number, number][])
    .map(([tok, ccy, nets, mins, cutoff]) => ({ id: `${tok.toLowerCase()}_redeem`, label: `${tok} redemption to local ${ccy} rail`, tokens: [tok], networks: nets,
      dest: [ccy], tiers: [{ upToUsd: Infinity, bps: 10 }], fixedUsd: 1, capacityUsd: 400_000, payoutMin: mins, cutoffUtcHour: cutoff })),
];

export const PLATFORM = { flatFeeBps: 15, timeValueBpsPerDay: 1.5 };   // fee = 0.15% of converted volume (at mid); time value for cost+speed ranking
/** Partner rail: priced from measured partner pricing (market.ts). Arrival and capacity are labeled assumptions. */
export const PARTNER = { businessDays: 1, cutoffUtcHour: 20, capacityUsd: 1_000_000 };
