// Compliance built into the router: rules a payment must pass before a route is quoted and again before money moves,
// the same way the USDC depeg breaker works. Each rule is a company setting (Policy & people), never a legal opinion:
//   - sanctioned jurisdictions: no route to a supplier in a comprehensively sanctioned country
//   - GENIUS Act (US): from the date the company sets (default Jan 18, 2027, when the OCC's final rule takes effect),
//     stablecoin legs only in tokens the company has marked as issued by a permitted payment stablecoin issuer
//   - MiCA (EU/EEA): payouts to an EEA supplier only through e-money tokens authorized under MiCA
//   - wallet screening: a supplier's wallet is checked against sanctions lists (Chainalysis) before it is paid
//   - Travel Rule: originator and beneficiary details travel with stablecoin transfers above the threshold (always in the EEA)
//   - tax reporting: stablecoin transfers are recorded with the fields Form 1099-DA and CARF/DAC8 reporting need
// Tokenized deposits are bank deposits, so the stablecoin rules do not apply to them.
import type { Policy } from "../company/controls.js";

export interface Check { id: string; label: string; status: "pass" | "fail" | "warn" | "n/a"; detail: string }
export interface ComplianceInput { routeKind: "stablecoin" | "bank_wire" | "tokenized_deposit"; coins: string[]; destCcy: string;
  country?: string; supplierWallet?: string; amountUsd: number; supplierName?: string }

/** What is known about each stablecoin in the registry for the rules above. MiCA status per the issuer's EU authorization. */
export const STABLECOINS: Record<string, { issuer: string; micaEmt: boolean; note: string }> = {
  USDC: { issuer: "Circle", micaEmt: true, note: "issued in the EU by Circle's French e-money institution as a MiCA e-money token" },
  EURC: { issuer: "Circle", micaEmt: true, note: "issued in the EU by Circle's French e-money institution as a MiCA e-money token" },
  EURCV: { issuer: "SG-Forge (Societe Generale)", micaEmt: true, note: "MiCA e-money token from an authorized French issuer" },
  EURE: { issuer: "Monerium", micaEmt: true, note: "MiCA e-money token from an authorized e-money institution" },
  PYUSD: { issuer: "Paxos", micaEmt: false, note: "US issuer; not offered as a MiCA e-money token" },
  USDG: { issuer: "Paxos", micaEmt: true, note: "issued in the EU by Paxos Issuance Europe (Finland) as a MiCA e-money token" },
  USDP: { issuer: "Paxos", micaEmt: false, note: "US issuer; not offered as a MiCA e-money token" },
  RLUSD: { issuer: "Ripple", micaEmt: false, note: "US issuer; not offered as a MiCA e-money token" },
  GUSD: { issuer: "Gemini", micaEmt: false, note: "US issuer; not offered as a MiCA e-money token" },
  QCAD: { issuer: "Stablecorp", micaEmt: false, note: "Canadian issuer" }, TGBP: { issuer: "BCP", micaEmt: false, note: "UK issuer" },
  XSGD: { issuer: "StraitsX", micaEmt: false, note: "regulated in Singapore; not a MiCA e-money token" },
  AUDD: { issuer: "Novatti", micaEmt: false, note: "Australian issuer" }, JPYC: { issuer: "JPYC", micaEmt: false, note: "Japanese issuer" },
  GYEN: { issuer: "GMO Trust", micaEmt: false, note: "US trust company" }, MXNB: { issuer: "Juno (Bitso)", micaEmt: false, note: "Mexican issuer" },
  BRZ: { issuer: "Transfero", micaEmt: false, note: "Brazilian issuer" }, TRYB: { issuer: "BiLira", micaEmt: false, note: "Turkish issuer" },
};
const EEA = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO".split(" "));
export const isEea = (country?: string) => !!country && EEA.has(country);

/** Company compliance settings (Policy & people). None of these is legal advice; counsel confirms them. */
export interface CompliancePolicy {
  blockedCountries: string[];        // comprehensively sanctioned jurisdictions (OFAC); the admin keeps this current
  geniusEnforceFrom: string;         // ISO date the GENIUS Act issuer rule applies from (OCC final rule effective Jan 18, 2027)
  geniusPermittedTokens: string[];   // tokens whose issuer the company has confirmed is permitted (empty until approvals are public)
  micaForEea: boolean;               // EEA payouts only through MiCA-authorized e-money tokens
  requireWalletScreening: boolean;   // fail closed when a supplier wallet cannot be screened
  travelRuleThresholdUsd: number;    // US Travel Rule threshold for transmittals of funds (3,000 USD); EEA transfers always carry it
}
export const DEFAULT_COMPLIANCE: CompliancePolicy = { blockedCountries: ["CU", "IR", "KP"], geniusEnforceFrom: "2027-01-18",
  geniusPermittedTokens: [], micaForEea: true, requireWalletScreening: true, travelRuleThresholdUsd: 3000 };

export function cleanCompliance(x: any): CompliancePolicy {
  const list = (v: any, re: RegExp) => (Array.isArray(v) ? v : String(v ?? "").split(/[,\s]+/)).map((s: string) => s.trim().toUpperCase()).filter((s: string) => re.test(s));
  const d = { ...DEFAULT_COMPLIANCE, ...(x ?? {}) };
  return { blockedCountries: list(d.blockedCountries, /^[A-Z]{2}$/), geniusEnforceFrom: /^\d{4}-\d{2}-\d{2}$/.test(d.geniusEnforceFrom) ? d.geniusEnforceFrom : DEFAULT_COMPLIANCE.geniusEnforceFrom,
    geniusPermittedTokens: list(d.geniusPermittedTokens, /^[A-Z0-9]{2,8}$/).filter((t) => t in STABLECOINS), micaForEea: d.micaForEea !== false,
    requireWalletScreening: d.requireWalletScreening !== false, travelRuleThresholdUsd: Math.max(0, Number(d.travelRuleThresholdUsd) || 0) };
}
export const compliancePolicy = (p: Policy): CompliancePolicy => cleanCompliance((p as any).compliance);

// Wallet screening through Chainalysis' free sanctions API (needs CHAINALYSIS_API_KEY); results cached for an hour.
const screened = new Map<string, { at: number; hit: boolean; detail: string }>();
async function screenWallet(address: string): Promise<{ hit: boolean; detail: string } | null> {
  const key = process.env.CHAINALYSIS_API_KEY; if (!key) return null;
  const c = screened.get(address.toLowerCase()); if (c && Date.now() - c.at < 3600e3) return c;
  const r = await fetch(`https://public.chainalysis.com/api/v1/address/${encodeURIComponent(address)}`, { headers: { "X-API-Key": key, accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`screening service HTTP ${r.status}`);
  const j: any = await r.json(), ids = j?.identifications ?? [];
  const out = { at: Date.now(), hit: ids.length > 0, detail: ids.length ? `listed: ${ids.map((i: any) => i.name ?? i.category).join(", ")}` : "no sanctions identifications (Chainalysis)" };
  screened.set(address.toLowerCase(), out); return out;
}

/** Every rule for one payment on one route, in plain words. `ok` is false when any rule fails. */
export async function complianceChecks(x: ComplianceInput, policy: Policy, now = new Date()): Promise<{ ok: boolean; checks: Check[]; reason?: string }> {
  const cp = compliancePolicy(policy), checks: Check[] = [], coin = x.routeKind === "stablecoin";
  const add = (id: string, label: string, status: Check["status"], detail: string) => checks.push({ id, label, status, detail });
  add("sanctions_country", "Sanctioned countries", x.country && cp.blockedCountries.includes(x.country) ? "fail" : "pass",
    x.country && cp.blockedCountries.includes(x.country) ? `${x.country} is on the company's sanctioned-country list; no route is offered` : `${x.country ?? "supplier country"} is not on the sanctioned-country list`);
  if (!coin) {
    add("rail_type", "Rail", "pass", x.routeKind === "tokenized_deposit" ? "tokenized deposit: a bank deposit, so stablecoin issuer rules do not apply" : "bank wire: your bank's own sanctions and AML checks apply");
  } else {
    const enforce = Date.parse(`${cp.geniusEnforceFrom}T00:00:00Z`), unknown = x.coins.filter((c) => !cp.geniusPermittedTokens.includes(c));
    add("genius_issuer", "GENIUS Act issuer", now.getTime() < enforce ? "pass" : unknown.length ? "fail" : "pass",
      now.getTime() < enforce ? `issuer rule applies from ${cp.geniusEnforceFrom}; until then any listed issuer may be used (${x.coins.join(", ")})`
      : unknown.length ? `${unknown.join(", ")} not confirmed as issued by a permitted payment stablecoin issuer (mark it in Policy & people once approved)` : `${x.coins.join(", ")} from permitted issuers`);
    const eea = isEea(x.country), notEmt = x.coins.filter((c) => !STABLECOINS[c]?.micaEmt);
    add("mica_emt", "MiCA (EU)", !eea || !cp.micaForEea ? "n/a" : notEmt.length ? "fail" : "pass",
      !eea ? "supplier is outside the EEA" : !cp.micaForEea ? "rule switched off in policy" : notEmt.length ? `${notEmt.join(", ")} is not a MiCA-authorized e-money token` : `${x.coins.join(", ")}: MiCA e-money tokens`);
    if (x.supplierWallet) {
      let s: { hit: boolean; detail: string } | null = null, err = "";
      try { s = await screenWallet(x.supplierWallet); } catch (e: any) { err = e.message; }
      add("wallet_screening", "Wallet sanctions screening", s ? (s.hit ? "fail" : "pass") : cp.requireWalletScreening ? "fail" : "warn",
        s ? s.detail : `${err || "no screening service configured (set CHAINALYSIS_API_KEY)"}${cp.requireWalletScreening ? "; policy requires screening, so this wallet is not paid" : "; paid unscreened because policy allows it"}`);
    } else add("wallet_screening", "Wallet sanctions screening", "n/a", "paid to the supplier's bank account through a licensed partner, not to a wallet");
    const tr = isEea(x.country) || x.amountUsd >= cp.travelRuleThresholdUsd;
    add("travel_rule", "Travel Rule", tr ? "pass" : "n/a", tr ? "originator and beneficiary details are attached to the transfer" : `below the ${cp.travelRuleThresholdUsd.toLocaleString()} USD threshold`);
    add("tax_reporting", "Tax reporting", "pass", "recorded with the fields Form 1099-DA and CARF/DAC8 reporting need");
  }
  const failed = checks.filter((c) => c.status === "fail");
  return { ok: !failed.length, checks, reason: failed.length ? `compliance: ${failed.map((c) => `${c.label}: ${c.detail}`).join("; ")}` : undefined };
}

/** Coins the rules forbid for a supplier before any route is planned: non-MiCA tokens to the EEA, and after the GENIUS Act
 *  date every token not confirmed as from a permitted issuer. Planning around them avoids proposing a route that fails later. */
export function disallowedCoins(country: string | undefined, policy: Policy, now = new Date()): string[] {
  const cp = compliancePolicy(policy), out = new Set<string>();
  if (cp.micaForEea && isEea(country)) for (const [c, v] of Object.entries(STABLECOINS)) if (!v.micaEmt) out.add(c);
  if (now.getTime() >= Date.parse(`${cp.geniusEnforceFrom}T00:00:00Z`)) for (const c of Object.keys(STABLECOINS)) if (!cp.geniusPermittedTokens.includes(c)) out.add(c);
  return [...out];
}

/** Tokens a route's id uses: coin:USDC>EURC:base:eurc_redeem -> [USDC, EURC]. */
export const coinsOf = (routeIds: string[]) => [...new Set(routeIds.filter((r) => r.startsWith("coin:")).flatMap((r) => r.split(":")[1].split(">")))];
export const railOf = (routeIds: string[]): ComplianceInput["routeKind"] =>
  routeIds.some((r) => r.startsWith("coin:")) ? "stablecoin" : routeIds.some((r) => r.startsWith("tokenized:")) ? "tokenized_deposit" : "bank_wire";

/** Travel Rule data (IVMS 101 field names) that travels with a stablecoin transfer. */
export function travelRuleRecord(company: { name: string; country?: string }, sourceAccount: string, ben: any, amount: string, asset: string) {
  return { standard: "IVMS 101", createdAt: new Date().toISOString(), asset, amount,
    originator: { legalPerson: company.name, countryOfRegistration: company.country ?? "US", accountNumber: sourceAccount },
    beneficiary: { legalPerson: ben?.name ?? "-", country: ben?.country ?? "-", accountNumber: ben?.usdcWallet ?? (ben?.iban ? `IBAN ...${String(ben.iban).slice(-4)}` : "bank account on file") } };
}
