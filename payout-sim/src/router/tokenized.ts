// Tokenized bank deposits as a payment route. A deposit token is an ordinary deposit at the company's bank, recorded on the
// bank's (or a shared) ledger, so it moves 24/7 and settles in minutes. Legally it stays a bank deposit: the GENIUS Act's
// stablecoin-issuer rules do not apply to it. Economically it is the company's own bank converting at its own rate, so the
// route is priced and executed like a bank route; only the arrival (24/7, minutes) and the rail differ.
// Nothing is invented: the route exists only after an admin enters the tariff the bank actually offers (Policy & people).

/** Networks companies can be offered access to through their bank, with what is publicly known and where it is from. */
export const TOKENIZED_CATALOG = [
  { id: "kinexys", label: "Kinexys Digital Payments", operator: "J.P. Morgan",
    status: "live for J.P. Morgan institutional clients: blockchain deposit accounts with 24/7 payments and FX in USD, EUR and GBP; JPMD deposit token on Base",
    url: "https://www.jpmorgan.com/payments/newsroom/jpm-coin-usd-deposit-token-institutional-clients" },
  { id: "citi_token_services", label: "Citi Token Services", operator: "Citi",
    status: "live since October 2024 for Citi institutional clients: 24/7 transfers between Citi branches on Citi's permissioned ledger; linked to 24/7 USD Clearing (US, UK) in 2025",
    url: "https://finextra.com/newsarticle/44865/citi-token-services-for-cash-goes-live" },
  { id: "swift_ledger", label: "Swift shared ledger", operator: "Swift with 30+ banks",
    status: "being built (announced Sep 29, 2025): a blockchain-based shared ledger for real-time, 24/7 cross-border payments; Consensys prototype",
    url: "https://www.theblock.co/post/372706/swift-blockchain-ledger-consensys" },
  { id: "gbtd", label: "GB Tokenised Deposits", operator: "UK banks",
    status: "first live transactions in 2026 between seven UK banks, including funds locked until goods changed hands",
    url: "https://www.pymnts.com/blockchain/2026/uk-banks-execute-first-transactions-with-tokenized-deposits/" },
  { id: "tch_onchain", label: "The Clearing House on-chain money", operator: "The Clearing House (US)",
    status: "bank access targeted for the first half of 2027; linked to RTP and CHIPS",
    url: "https://genfinity.io/2026/09/24/clearing-house-quant-on-chain-money-initiative/" },
] as const;

/** What the company's bank offers, entered by an admin from the bank's tariff. */
export interface TokenizedConfig {
  network: string;            // TOKENIZED_CATALOG id
  currencies: string[];       // currencies the bank settles in deposit tokens (source and destination)
  countries: string[];        // countries where the bank credits the supplier's local account
  fxMarginBps: number;        // the bank's FX margin over mid on this rail (from its tariff)
  feeUsd: number;             // fixed fee per payment (from its tariff)
  settlementMinutes: number;  // the bank's stated settlement time
  tariffSource: string;       // where the numbers come from, shown with every quote
  enabledBy?: string; enabledAt?: string;
}

let current: TokenizedConfig | null = null;
/** Set by the router at start and whenever the policy changes (the optimizer itself stays free of I/O). */
export function setTokenizedConfig(c: TokenizedConfig | null | undefined) { current = c && c.network ? c : null; }
export const tokenizedConfig = () => current;
export const networkLabel = (id: string) => TOKENIZED_CATALOG.find((n) => n.id === id)?.label ?? id;

/** Validates an admin's entry; returns the clean config or an error message. */
export function cleanTokenizedConfig(x: any): { config: TokenizedConfig | null; error?: string } {
  if (!x || !x.network) return { config: null };
  if (!TOKENIZED_CATALOG.some((n) => n.id === x.network)) return { config: null, error: "choose a network from the list" };
  const list = (v: any) => (Array.isArray(v) ? v : String(v ?? "").split(/[,\s]+/)).map((s: string) => s.trim().toUpperCase()).filter(Boolean);
  const currencies = list(x.currencies).filter((c) => /^[A-Z]{3}$/.test(c)), countries = list(x.countries).filter((c) => /^[A-Z]{2}$/.test(c));
  const fx = Number(x.fxMarginBps), fee = Number(x.feeUsd), mins = Number(x.settlementMinutes);
  if (!currencies.length || !countries.length) return { config: null, error: "enter the currencies and countries your bank's tariff covers" };
  if (!(fx >= 0 && fx <= 500) || !(fee >= 0 && fee <= 1000) || !(mins > 0 && mins <= 7 * 1440)) return { config: null, error: "enter the FX margin (0-500 bps), fee (0-1000 USD) and settlement time from the tariff" };
  const tariffSource = String(x.tariffSource ?? "").trim().slice(0, 120);
  if (tariffSource.length < 4) return { config: null, error: "say where the tariff comes from (for example the bank's fee schedule and its date)" };
  return { config: { network: x.network, currencies, countries, fxMarginBps: fx, feeUsd: fee, settlementMinutes: mins, tariffSource } };
}

/** Why the route is not offered for a payment (or null when it is). */
export function tokenizedUnavailable(srcCcy: string, destCcy: string, country?: string): string | null {
  const c = current;
  if (!c) return "not switched on: when your bank offers a tokenized-deposit network, an admin enters its tariff in Policy & people";
  if (!c.currencies.includes(srcCcy) || !c.currencies.includes(destCcy)) return `${networkLabel(c.network)} does not settle ${srcCcy}->${destCcy} under your bank's tariff (${c.currencies.join(", ")})`;
  if (country && !c.countries.includes(country)) return `${networkLabel(c.network)} cannot credit a supplier in ${country} under your bank's tariff (${c.countries.join(", ")})`;
  return null;
}
