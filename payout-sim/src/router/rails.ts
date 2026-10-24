// The rails a payment can settle on, described as data. A payment request is approved once, with its condition and its
// ISO 20022 message; the rail is chosen at release. When a company's bank joins a tokenized-deposit network, that rail
// is switched on here and existing approvals, conditions and supplier records carry over unchanged.
// Nothing below invents a price: the tokenized rail has no quote until a bank offers one.
export type RailStatus = "live" | "simulated" | "planned";
export interface Rail {
  id: "bank_wire" | "stablecoin_usdc" | "tokenized_deposit"; label: string; status: RailStatus; statusNote: string;
  hours: string; conditional: string; intermediaries: string;
}

export const RAILS: Rail[] = [
  { id: "bank_wire", label: "Your bank (wire)", status: "simulated", statusNote: "quoted from your bank's measured pricing; payout simulated in the demo",
    hours: "business days and cut-offs", conditional: "held by Route402 until the condition is met", intermediaries: "may pass through correspondent banks" },
  { id: "stablecoin_usdc", label: "Our stablecoin rail (USDC)", status: "live", statusNote: "testnet: x402 settlement proof on Base Sepolia",
    hours: "24/7", conditional: "held by Route402 until the condition is met", intermediaries: "none when the supplier accepts USDC" },
  { id: "tokenized_deposit", label: "Tokenized deposit (your bank)", status: "planned",
    statusNote: "not open to companies yet: turns on when your bank joins a tokenized-deposit network",
    hours: "designed for 24/7", conditional: "can be locked on the ledger and released when the evidence arrives", intermediaries: "bank-to-bank on a shared ledger" },
];

// Networks being built, with what is actually known and the page it comes from.
export const TOKENIZED_NETWORKS = [
  { name: "The Clearing House on-chain money (US)", status: "Quant named as technology provider, Sep 24 2026; bank access targeted H1 2027; linked to RTP and CHIPS",
    url: "https://genfinity.io/2026/09/24/clearing-house-quant-on-chain-money-initiative/" },
  { name: "GB Tokenised Deposits (UK)", status: "first live transactions 2026 between seven banks, incl. funds locked until goods changed hands; platform built by Quant",
    url: "https://www.pymnts.com/blockchain/2026/uk-banks-execute-first-transactions-with-tokenized-deposits/" },
  { name: "BIS Project Agorá", status: "prototype tested, May 2026: tokenised deposits + central bank money, atomic and conditional cross-border settlement",
    url: "https://www.bis.org/press/p260527.htm" },
];

export function tokenizedQuote() {
  return { provider: "tokenized_deposit", status: "NOT_AVAILABLE",
    reason: "your bank is not on a tokenized-deposit network yet; no price is shown until it offers one" };
}
