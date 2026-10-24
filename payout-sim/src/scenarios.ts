// Synthetic, labeled quote inputs. Rates and fees are NOT market data and NOT provider offers.
// One route model for every corridor (no country-specific code):
//   source debit (srcCcy) - funding fee -> [onramp srcCcy->fundingAsset, stablecoin routes only, funded via x402]
//   -> provider FX fundingAsset->destCcy -> payout fee (destCcy) -> beneficiary credit
import { toMinor, convert, requiredInput, fmt, decimals, TOKENS } from "./money.js";

export type Outcome = "delivered" | "delayed" | "rejected" | "mismatch" | "partial" | "late_success" | "timeout" | "chaos";
export const OUTCOMES: Outcome[] = ["delivered", "delayed", "rejected", "mismatch", "partial", "late_success", "timeout", "chaos"];

export interface QuoteInput {
  route: "stablecoin" | "bank"; srcCcy: string; destCcy: string;
  amountType: "SOURCE_FIXED" | "RECIPIENT_FIXED"; amount: string;   // amount in srcCcy (SOURCE_FIXED) or destCcy (RECIPIENT_FIXED)
  fundingAsset?: string; onrampRate?: string;                         // stablecoin routes: token + srcCcy->token rate
  fxRate: string;                                                     // fundingAsset (or srcCcy on bank routes) -> destCcy
  fundingFee: string; payoutFee: string;                              // in srcCcy / destCcy
}
export interface Scenario { id: string; label: string; outcome: Outcome; input: QuoteInput }

const usdCad: QuoteInput = { route: "stablecoin", srcCcy: "USD", destCcy: "CAD", amountType: "SOURCE_FIXED", amount: "50210.00",
  fundingAsset: "USDC", onrampRate: "1.000000", fxRate: "1.3650", fundingFee: "10.00", payoutFee: "23.00" };
const sc = (id: string, label: string, outcome: Outcome, input: QuoteInput): Scenario => ({ id, label, outcome, input });

export const SCENARIOS: Record<string, Scenario> = Object.fromEntries([
  sc("usd_cad_stablecoin", "USD->CAD via USDC, delivered", "delivered", usdCad),
  sc("usd_cad_recipient_fixed", "USD->CAD via USDC, recipient gets exactly 68,500.00 CAD", "delivered", { ...usdCad, amountType: "RECIPIENT_FIXED", amount: "68500.00" }),
  sc("usd_cad_delayed", "USD->CAD via USDC, recipient credit delayed", "delayed", usdCad),
  sc("usd_cad_rejected", "USD->CAD via USDC, payout rejected after funding", "rejected", usdCad),
  sc("usd_cad_mismatch", "USD->CAD via USDC, recipient credited short", "mismatch", usdCad),
  sc("usd_cad_partial", "USD->CAD via USDC, partial credit then rejection", "partial", usdCad),
  sc("usd_cad_late", "USD->CAD via USDC, rejected then late success", "late_success", usdCad),
  sc("usd_cad_timeout", "USD->CAD via USDC, provider call times out (accepted anyway)", "timeout", usdCad),
  sc("usd_cad_chaos", "USD->CAD via USDC, duplicate + out-of-order webhooks", "chaos", usdCad),
  sc("usd_eur_bank", "USD->EUR bank route (no stablecoin, no x402)", "delivered", { route: "bank", srcCcy: "USD", destCcy: "EUR",
     amountType: "SOURCE_FIXED", amount: "50150.00", fxRate: "0.9215", fundingFee: "25.00", payoutFee: "15.00" }),
  sc("usd_jpy_stablecoin", "USD->JPY via USDC (zero-decimal payout)", "delivered", { ...usdCad, destCcy: "JPY", fxRate: "152.37", payoutFee: "300" }),
  sc("usd_kwd_stablecoin", "USD->KWD via USDC (three-decimal payout)", "delivered", { ...usdCad, destCcy: "KWD", fxRate: "0.3071", payoutFee: "0.250" }),
  sc("usd_brl_stablecoin", "USD->BRL via USDC", "delivered", { ...usdCad, destCcy: "BRL", fxRate: "5.4321", payoutFee: "12.00" }),
  sc("eur_mxn_eurc", "EUR->MXN via EURC", "delivered", { route: "stablecoin", srcCcy: "EUR", destCcy: "MXN", amountType: "SOURCE_FIXED",
     amount: "20000.00", fundingAsset: "EURC", onrampRate: "1.000000", fxRate: "19.8740", fundingFee: "8.00", payoutFee: "40.00" }),
  sc("cad_usd_reverse", "CAD->USD reverse via USDC (own rates and fees)", "delivered", { route: "stablecoin", srcCcy: "CAD", destCcy: "USD",
     amountType: "SOURCE_FIXED", amount: "68500.00", fundingAsset: "USDC", onrampRate: "0.731000", fxRate: "1.0000", fundingFee: "15.00", payoutFee: "20.00" }),
  sc("usd_usd_crossborder", "USD->USD cross-border, no FX", "delivered", { route: "bank", srcCcy: "USD", destCcy: "USD",
     amountType: "SOURCE_FIXED", amount: "50040.00", fxRate: "1", fundingFee: "25.00", payoutFee: "15.00" }),
].map((s) => [s.id, s]));

/** Validate an arbitrary custom pair. Every rate and fee must be supplied: nothing is guessed. */
export function validateInput(i: QuoteInput): string[] {
  const e: string[] = [];
  if (!["stablecoin", "bank"].includes(i.route)) e.push("route must be stablecoin or bank");
  if (!["SOURCE_FIXED", "RECIPIENT_FIXED"].includes(i.amountType)) e.push("amountType must be SOURCE_FIXED or RECIPIENT_FIXED");
  for (const [k, v] of Object.entries({ amount: i.amount, fxRate: i.fxRate, fundingFee: i.fundingFee, payoutFee: i.payoutFee }))
    if (v === undefined || v === "") e.push(`missing ${k} (explicit synthetic input required; rates are never invented)`);
  try { decimals(i.srcCcy); } catch (x: any) { e.push(x.message); }
  try { decimals(i.destCcy); } catch (x: any) { e.push(x.message); }
  if (i.route === "stablecoin") {
    if (!i.fundingAsset || !(i.fundingAsset in TOKENS)) e.push("stablecoin route needs a registered fundingAsset (USDC, EURC, USDT, PYUSD)");
    if (!i.onrampRate) e.push(`missing onrampRate (${i.srcCcy}->${i.fundingAsset})`);
  }
  return e;
}

/** Deterministic quote with exact integer arithmetic, in either economic mode. */
export function quoteFor(i: QuoteInput, id = "custom") {
  const errs = validateInput(i);
  if (errs.length) throw new Error(errs.join("; "));
  const asset = i.route === "stablecoin" ? i.fundingAsset! : i.srcCcy;
  const fee = toMinor(i.fundingFee, i.srcCcy), pFee = toMinor(i.payoutFee, i.destCcy);
  const onramp = (x: bigint) => (i.route === "stablecoin" ? convert(x, i.srcCcy, asset, i.onrampRate!).minor : x);
  let S: bigint, F: bigint, C: bigint, net: bigint, surplus = 0n;
  if (i.amountType === "SOURCE_FIXED") {
    S = toMinor(i.amount, i.srcCcy);
    F = onramp(S - fee); C = convert(F, asset, i.destCcy, i.fxRate).minor; net = C - pFee;
  } else {
    net = toMinor(i.amount, i.destCcy);
    F = requiredInput(net + pFee, asset, i.destCcy, i.fxRate);
    const afterFee = i.route === "stablecoin" ? requiredInput(F, i.srcCcy, asset, i.onrampRate!) : F;
    S = afterFee + fee;
    F = onramp(S - fee);                                   // re-derive forward so every leg is exact
    C = convert(F, asset, i.destCcy, i.fxRate).minor;
    surplus = C - pFee - net;                              // sub-unit rounding gain, kept by provider and booked
  }
  if (S <= fee || net <= 0n) throw new Error("fees exceed the amount");
  const m = (x: bigint, c: string) => ({ minor: x.toString(), ccy: c, display: fmt(x, c) });
  return { quoteId: `sq_${id}`, provenance: "synthetic", route: i.route, amountType: i.amountType, input: i,
    sourceDebit: m(S, i.srcCcy), fundingFee: m(fee, i.srcCcy),
    funding: { ...m(F, asset), rate: i.route === "stablecoin" ? i.onrampRate : null, viaX402: i.route === "stablecoin" },
    converted: { ...m(C, i.destCcy), rate: i.fxRate }, payoutFee: m(pFee, i.destCcy),
    roundingSurplus: m(surplus, i.destCcy), recipientNet: m(net, i.destCcy) };
}
