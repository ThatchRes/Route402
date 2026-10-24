// Beneficiary validation BEFORE sending: catches the details that cause returns (return fees, double FX, delays).
// Format checks only; a production version adds account-name verification and sanctions screening via a provider.
export interface Beneficiary { id: string; name: string; country: string; currency: string; iban?: string; swift?: string; accountNumber?: string; routing?: string;
  usdcWallet?: string }   // supplier accepts USDC at this address (USD-invoiced suppliers)
import { detailsChanged } from "./payees.js";
const IBAN_OPTIONAL = new Set(["BR"]);   // IBAN exists but local account details are common

const IBAN_LEN: Record<string, number> = { DE: 22, FR: 27, GB: 22, ES: 24, IT: 27, NL: 18, BE: 16, CH: 21, AT: 20, IE: 22, PT: 25, PL: 28, SE: 24,
  DK: 18, NO: 15, FI: 18, LU: 20, AE: 23, SA: 24, TR: 26, BR: 29, MX: 0 };
const COUNTRY_CCY: Record<string, string[]> = { US: ["USD"], CA: ["CAD", "USD"], GB: ["GBP", "EUR", "USD"], DE: ["EUR"], FR: ["EUR"], ES: ["EUR"], IT: ["EUR"], NL: ["EUR"],
  BE: ["EUR"], IE: ["EUR"], CH: ["CHF", "EUR"], MX: ["MXN", "USD"], BR: ["BRL"], SG: ["SGD", "USD"], JP: ["JPY"], IN: ["INR"], PH: ["PHP", "USD"],
  NG: ["NGN", "USD"], AU: ["AUD"], AE: ["AED", "USD"], TR: ["TRY", "EUR", "USD"], ZA: ["ZAR"] };
const IBAN_COUNTRIES = new Set(Object.keys(IBAN_LEN).filter((k) => IBAN_LEN[k] > 0));

function ibanOk(iban: string) {
  const s = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return "IBAN has invalid characters";
  const len = IBAN_LEN[s.slice(0, 2)];
  if (len && s.length !== len) return `IBAN length ${s.length}, expected ${len} for ${s.slice(0, 2)}`;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0; for (const ch of r) m = (m * 10 + Number(ch)) % 97;
  return m === 1 ? null : "IBAN checksum fails (typo likely)";
}

export function validate(b: Beneficiary) {
  const errors: string[] = [], warnings: string[] = [];
  if (!b.name || b.name.trim().length < 2) errors.push("beneficiary name missing");
  const okCcy = COUNTRY_CCY[b.country];
  if (okCcy && !okCcy.includes(b.currency)) warnings.push(`${b.currency} to ${b.country} is unusual (expected ${okCcy.join("/")}): likely converted again on arrival`);
  const acct = (b.accountNumber ?? "").replace(/[\s-]/g, "");
  if (!b.iban && !acct) errors.push("no bank account details (IBAN or account number)");
  if (b.country === "MX" && acct) {
    if (!/^\d{18}$/.test(acct)) errors.push("Mexican CLABE must be 18 digits");
    else { const w = [3, 7, 1]; const sum = acct.slice(0, 17).split("").reduce((s2, d, i) => s2 + ((Number(d) * w[i % 3]) % 10), 0);
           if ((10 - (sum % 10)) % 10 !== Number(acct[17])) errors.push("CLABE check digit fails (typo likely)"); }
  }
  if (b.country === "CA" && acct && !/^\d{3}\d{5}\d{5,12}$/.test(acct)) errors.push("Canadian account must be institution (3) + transit (5) + account (5-12 digits)");
  if (IBAN_COUNTRIES.has(b.country) && IBAN_OPTIONAL.has(b.country) && !b.iban) warnings.push(`${b.country}: no IBAN, using local account details`);
  if (IBAN_COUNTRIES.has(b.country) && !IBAN_OPTIONAL.has(b.country) || (b.iban && IBAN_OPTIONAL.has(b.country))) {
    if (!b.iban) errors.push(`${b.country} requires an IBAN`); else { const e = ibanOk(b.iban); if (e) errors.push(e);
      else if (b.iban.replace(/\s+/g, "").slice(0, 2).toUpperCase() !== b.country) warnings.push("IBAN country differs from beneficiary country"); }
  }
  if (b.swift && !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(b.swift.toUpperCase())) errors.push("SWIFT/BIC format invalid (8 or 11 characters)");
  if (b.swift && b.swift.slice(4, 6).toUpperCase() !== b.country) warnings.push(`SWIFT country ${b.swift.slice(4, 6)} differs from ${b.country}`);
  if (b.country === "US" && b.routing && !/^\d{9}$/.test(b.routing)) errors.push("US routing number must be 9 digits");
  if (b.country === "US" && b.routing && /^\d{9}$/.test(b.routing)) {
    const d = b.routing.split("").map(Number), sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
    if (sum % 10 !== 0) errors.push("US routing number checksum fails");
  }
  if (b.usdcWallet && !/^0x[0-9a-fA-F]{40}$/.test(b.usdcWallet)) errors.push("USDC wallet address is not a valid EVM address");
  const changed = detailsChanged(b);
  if (changed) warnings.push(changed);
  return { beneficiary: b.id, status: errors.length ? "BLOCK" : warnings.length ? "REVIEW" : "OK", errors, warnings, detailsChanged: !!changed };
}
