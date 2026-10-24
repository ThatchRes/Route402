// Exact money for ANY currency: integer minor units (BigInt) + decimal-string rates. Never floats.
// Fiat precision comes from the runtime's ISO 4217 data (Intl), with ISO overrides where CLDR differs.
// Stablecoins/tokens must be registered explicitly with their on-chain decimals.
const ISO_OVERRIDES: Record<string, number> = { IQD: 3, CLF: 4, UYW: 4, ISK: 0, HUF: 2, TWD: 2, IDR: 2, PKR: 2, RSD: 2 };
import { TOKENS as CATALOG } from "./router/registry.js";
/** Every catalog stablecoin with its on-chain decimals (catalog assumption: verify per contract). */
export const TOKENS: Record<string, number> = Object.fromEntries(CATALOG.map((t) => [t.id, t.decimals]));

let FIAT: Set<string> | null = null;
function fiatCodes(): Set<string> {
  if (!FIAT) FIAT = new Set((Intl as any).supportedValuesOf?.("currency") ?? []);
  return FIAT;
}

export function isSupported(ccy: string) { return ccy in TOKENS || fiatCodes().has(ccy); }

export function decimals(ccy: string): number {
  if (!/^[A-Z]{3,5}$/.test(ccy)) throw new Error(`invalid currency code ${ccy}`);
  if (ccy in TOKENS) return TOKENS[ccy];
  if (ccy in ISO_OVERRIDES) return ISO_OVERRIDES[ccy];
  if (!fiatCodes().has(ccy)) throw new Error(`unknown currency ${ccy} (not ISO 4217 and not a registered token)`);
  return new Intl.NumberFormat("en", { style: "currency", currency: ccy }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function listCurrencies() {
  return [...fiatCodes()].map((c) => ({ code: c, decimals: decimals(c), kind: "fiat" }))
    .concat(Object.entries(TOKENS).map(([c, d]) => ({ code: c, decimals: d, kind: "token" })));
}

export function toMinor(amount: string, ccy: string): bigint {
  const d = decimals(ccy);
  if (!/^\d+(\.\d+)?$/.test(String(amount))) throw new Error(`invalid amount ${amount}`);
  const [i, f = ""] = String(amount).split(".");
  if (f.length > d) throw new Error(`${amount} has more than ${d} decimals for ${ccy}`);
  return BigInt(i) * 10n ** BigInt(d) + BigInt((f + "0".repeat(d)).slice(0, d) || "0");
}

export function fmt(minor: bigint, ccy: string): string {
  const d = decimals(ccy);
  const neg = minor < 0n; const m = neg ? -minor : minor;
  const s = m.toString().padStart(d + 1, "0");
  return `${neg ? "-" : ""}${d ? `${s.slice(0, -d)}.${s.slice(-d)}` : s} ${ccy}`;
}

function parseRate(rate: string) {
  if (!/^\d+(\.\d+)?$/.test(String(rate)) || /^0+(\.0+)?$/.test(String(rate))) throw new Error(`invalid rate ${rate}`);
  const [ri, rf = ""] = String(rate).split(".");
  return { num: BigInt(ri + rf), den: 10n ** BigInt(rf.length) };
}

/** amount(from) * rate -> to, rounded DOWN to the target minor unit (recipient is never over-credited). */
export function convert(amountMinor: bigint, from: string, to: string, rate: string) {
  const r = parseRate(rate);
  const num = amountMinor * r.num * 10n ** BigInt(decimals(to));
  const den = r.den * 10n ** BigInt(decimals(from));
  const out = num / den;
  return { minor: out, residual: `${num - out * den}/${den} of one ${to} minor unit (rounded down, kept by provider)` };
}

/** Smallest amount(from) whose conversion at `rate` yields at least `targetMinor` (to). Rounds UP. */
export function requiredInput(targetMinor: bigint, from: string, to: string, rate: string) {
  const r = parseRate(rate);
  const num = targetMinor * r.den * 10n ** BigInt(decimals(from));
  const den = r.num * 10n ** BigInt(decimals(to));
  let x = (num + den - 1n) / den;
  while (convert(x, from, to, rate).minor < targetMinor) x += 1n;   // guard against rounding edge cases
  return x;
}
