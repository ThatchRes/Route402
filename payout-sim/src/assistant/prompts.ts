// Prompt templates: everyday requests -> a ready-made plan built from the company's linked data.
// Deterministic matching + slot filling (no LLM needed for these, so it is fast, cheap and repeatable).
// Every result is a PREVIEW; executing always needs an explicit approval step.
import { runPaymentRun } from "../company/paymentRun.js";
import { validate } from "../company/validate.js";
import { optimize, type Intent } from "../router/optimizer.js";
import { decimals, fmt, toMinor } from "../money.js";
import type { Linked } from "./linked.js";
import { supplierRecords } from "../company/suppliers.js";
import { exposureContext } from "../router/exposureState.js";

const PLACES: Record<string, { country: string; ccy: string }> = {
  german: { country: "DE", ccy: "EUR" }, germany: { country: "DE", ccy: "EUR" }, french: { country: "FR", ccy: "EUR" }, france: { country: "FR", ccy: "EUR" },
  european: { country: "*", ccy: "EUR" }, europe: { country: "*", ccy: "EUR" }, eu: { country: "*", ccy: "EUR" }, dutch: { country: "NL", ccy: "EUR" },
  canadian: { country: "CA", ccy: "CAD" }, canada: { country: "CA", ccy: "CAD" }, mexican: { country: "MX", ccy: "MXN" }, mexico: { country: "MX", ccy: "MXN" },
  british: { country: "GB", ccy: "GBP" }, uk: { country: "GB", ccy: "GBP" }, england: { country: "GB", ccy: "GBP" },
  singapore: { country: "SG", ccy: "SGD" }, singaporean: { country: "SG", ccy: "SGD" }, brazilian: { country: "BR", ccy: "BRL" }, brazil: { country: "BR", ccy: "BRL" },
  japanese: { country: "JP", ccy: "JPY" }, japan: { country: "JP", ccy: "JPY" }, indian: { country: "IN", ccy: "INR" }, india: { country: "IN", ccy: "INR" },
  australian: { country: "AU", ccy: "AUD" }, australia: { country: "AU", ccy: "AUD" }, us: { country: "US", ccy: "USD" }, american: { country: "US", ccy: "USD" },
};
const CCY = /\b(USD|EUR|CAD|MXN|GBP|SGD|BRL|JPY|INR|AUD|CHF|PHP|NGN|ZAR|TRY|KRW|IDR)\b/i;
const WORDS: Record<string, string> = { euro: "EUR", euros: "EUR", dollar: "USD", dollars: "USD", "canadian dollars": "CAD", pesos: "MXN", peso: "MXN",
  pound: "GBP", pounds: "GBP", sterling: "GBP", yen: "JPY", reais: "BRL", "brazilian real": "BRL", lira: "TRY", rupees: "INR", "singapore dollars": "SGD" };
export function currencyOf(text: string): string | undefined {
  const c = [...text.matchAll(new RegExp(CCY.source, "gi"))].find((m) => m[1].toUpperCase() !== "TRY" || m[1] === "TRY")?.[1]?.toUpperCase(); if (c) return c;
  const t = text.toLowerCase(); const k = Object.keys(WORDS).sort((a, b) => b.length - a.length).find((w) => new RegExp(`\\b${w}\\b`).test(t));
  return k ? WORDS[k] : undefined;
}
const AMOUNT = /(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\b/i;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function window(text: string, nowUtc: string): { from: string; to: string; label: string } | null {
  const now = new Date(nowUtc), t = text.toLowerCase(), day = (n: number) => new Date(now.getTime() + n * 86400e3);
  const end = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59)).toISOString();
  if (/\btoday\b/.test(t)) return { from: nowUtc, to: end(now), label: "today" };
  if (/\btomorrow\b/.test(t)) return { from: nowUtc, to: end(day(1)), label: "by tomorrow" };
  if (/\bthis week\b/.test(t)) { const toSun = (7 - now.getUTCDay()) % 7; return { from: nowUtc, to: end(day(toSun)), label: "this week" }; }
  if (/\bnext week\b/.test(t)) { const toSun = (7 - now.getUTCDay()) % 7; return { from: nowUtc, to: end(day(toSun + 7)), label: "through next week" }; }
  if (/\bthis month\b/.test(t)) return { from: nowUtc, to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59)).toISOString(), label: "this month" };
  const iso = t.match(/\b(20\d\d-\d\d-\d\d)\b/); if (iso) return { from: nowUtc, to: `${iso[1]}T23:59:59.000Z`, label: `by ${iso[1]}` };
  const wd = DAYS.findIndex((d) => new RegExp(`\\b(by |on |before )?${d}\\b`).test(t));
  if (wd >= 0) { const n = (wd - now.getUTCDay() + 7) % 7 || 7; return { from: nowUtc, to: end(day(n)), label: `by ${DAYS[wd]}` }; }
  return null;
}
// Every ISO country name the runtime knows ("Switzerland" -> CH), plus everyday aliases. Used for supplier countries.
const REGION = new Intl.DisplayNames(["en"], { type: "region" });
const COUNTRY_NAMES = new Map<string, string>();
for (let a = 65; a < 91; a++) for (let b = 65; b < 91; b++) {
  const code = String.fromCharCode(a, b), name = REGION.of(code);
  if (name && name !== code && !/unknown/i.test(name)) COUNTRY_NAMES.set(name.toLowerCase(), code);
}
for (const [alias, code] of Object.entries({ usa: "US", "united states of america": "US", america: "US", uk: "GB", britain: "GB", "great britain": "GB",
  england: "GB", holland: "NL", "the netherlands": "NL", "south korea": "KR", korea: "KR", uae: "AE", "czech republic": "CZ", swiss: "CH", deutschland: "DE" }))
  COUNTRY_NAMES.set(alias, code);
const editDistance = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
/** A country named in the text: an exact name anywhere, or, when `loose`, a short answer with a small typo ("Switzerlan"). */
export function countryOf(text: string, loose = false): { code: string; name: string } | null {
  const t = text.toLowerCase().replace(/[^a-z\s.'-]/g, " ").replace(/\s+/g, " ").trim();
  const names = [...COUNTRY_NAMES.keys()].sort((x, y) => y.length - x.length);
  const exact = names.find((n) => n.length > 2 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
  if (exact) return { code: COUNTRY_NAMES.get(exact)!, name: REGION.of(COUNTRY_NAMES.get(exact)!)! };
  if (/^[a-z]{2}$/.test(t) && REGION.of(t.toUpperCase()) !== t.toUpperCase()) return { code: t.toUpperCase(), name: REGION.of(t.toUpperCase())! };
  if (!loose || t.length < 4 || t.split(" ").length > 3) return null;
  let best: { n: string; d: number } | null = null;
  for (const n of names) {
    const d = n.startsWith(t) ? 0 : editDistance(t, n);
    if (d <= (t.length >= 8 ? 2 : 1) && (!best || d < best.d)) best = { n, d };
  }
  return best ? { code: COUNTRY_NAMES.get(best.n)!, name: REGION.of(COUNTRY_NAMES.get(best.n)!)! } : null;
}
// The usual payout currency for a supplier's country (a suggestion only; the person confirms it)
const EURO = "AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK".split(" ");
export function usualCurrency(country: string): string | undefined {
  if (EURO.includes(country)) return "EUR";
  return ({ US: "USD", CA: "CAD", MX: "MXN", GB: "GBP", SG: "SGD", BR: "BRL", JP: "JPY", IN: "INR", AU: "AUD", CH: "CHF", PH: "PHP", NG: "NGN",
    ZA: "ZAR", TR: "TRY", KR: "KRW", ID: "IDR", CN: "CNY", HK: "HKD", NZ: "NZD", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", VN: "VND" } as Record<string, string>)[country];
}

export function place(text: string) { const t = text.toLowerCase(); const k = Object.keys(PLACES).find((p) => (p !== "us" || /\bUS\b/.test(text)) && new RegExp(`\\b${p}\\b`).test(t)); return k ? PLACES[k] : null; }
export function amountOf(text: string) {
  const m = text.replace(/\$/g, "").match(AMOUNT); if (!m) return null;
  let n = Number(m[1].replace(/,/g, "")); if (m[2]?.toLowerCase() === "k") n *= 1e3; if (m[2]?.toLowerCase() === "m") n *= 1e6;
  return n > 0 ? n : null;
}

/** `sourceFixed`: the amount is what the company sends, in its home currency ("transfer 50000" means 50,000 USD for a US
 *  company); the supplier receives the converted amount in its own currency. Otherwise the amount is what the supplier receives. */
export function planSend(l: Linked, supplierId: string, value: string | number, currency?: string, deadlineUtc?: string, sourceFixed = false, objective: Intent["objective"] = "balanced") {
  const ben = supplierRecords(l).find((b) => b.id === supplierId);
  if (!ben) return { clarification: "Choose a saved supplier before planning a payment." };
  const home = l.input.company.homeCcy, dest = sourceFixed ? ben.currency : currency ?? ben.currency, amountCcy = sourceFixed ? home : dest;
  const receivingCurrencies = new Set([ben.currency, ...l.input.payables.filter((p) => p.beneficiary.id === ben.id).map((p) => p.ccy)]);
  if (!receivingCurrencies.has(dest)) return { template: "send_to", clarification: `${ben.name} has receiving details on file for ${[...receivingCurrencies].join(", ")}. Choose one of those currencies before planning this payment.` };
  let amount: string;
  try { amount = Number(value).toFixed(decimals(amountCcy)); toMinor(String(value), amountCcy); if (!(Number(value) > 0)) throw new Error("positive amount required"); }
  catch { return { clarification: `Enter a positive amount with valid precision for ${amountCcy}.` }; }
  const v = validate(ben); if (v.status === "BLOCK") return { blocked: v.errors, beneficiary: ben.name };
  const intent = { srcCcy: home, destCcy: dest, amountType: (sourceFixed ? "SOURCE_FIXED" : "RECIPIENT_FIXED") as "SOURCE_FIXED" | "RECIPIENT_FIXED", amount, deadlineUtc, objective };
  const q: any = optimize({ ...intent, exposureContext: exposureContext(), costOfCashPct: l.input.company.costOfCashPct, nowUtc: l.input.nowUtc, currentBank: l.input.company.currentBank, beneficiary: ben, beneficiaryAcceptsUsdc: !!ben.usdcWallet });
  const shown = Number(amount).toLocaleString("en-US", { minimumFractionDigits: decimals(amountCcy), maximumFractionDigits: decimals(amountCcy) });
  return { template: "send_to", title: sourceFixed ? `Send ${shown} ${home} to ${ben.name}${dest !== home ? ` (they receive ${dest})` : ""}` : `Send ${shown} ${dest} to ${ben.name}`,
    message: sourceFixed && dest !== home ? `No currency was given, so I used your home currency: ${shown} ${home} leaves your account, fees included, and ${ben.name} receives the converted amount in ${dest}.` : undefined,
    beneficiaryCheck: v.status, beneficiary: ben,
    preview: q.status === "OK" ? { route: q.allocations.map((a: any) => a.routeId).join(" + "), youPay: q.totals.sourceDebit,
      theyGet: q.totals.recipientNet, arrives: q.totals.arrivalUtc, yourBankWould: q.baseline?.sourceDebit, youSave: q.value.customerNetSaving, timing: q.timing } : q,
    intent, nextStep: "A new preview only: review and approve before execution." };
}

export interface Template { id: string; example: string; match: RegExp; build: (text: string, l: Linked, options?: { objective?: Intent["objective"] }) => any }

export const TEMPLATES: Template[] = [
  { id: "pay_bills", example: "pay my German suppliers this week", match: /\b(pay|run|settle)\b.*\b(suppliers?|vendors?|bills?|invoices?|payables?|everyone|all)\b/i,
    build: (text, l) => {
      const p = place(text), w = window(text, l.input.nowUtc), ccy = currencyOf(text);
      const pays = l.input.payables.filter((x) => (!p || p.country === "*" ? true : x.beneficiary.country === p.country) && (!(p?.ccy || ccy) || x.ccy === (ccy ?? p!.ccy))
        && (!w || (Date.parse(x.dueUtc) <= Date.parse(w.to) || (x.discountByUtc && Date.parse(x.discountByUtc) <= Date.parse(w.to)))));
      if (!pays.length) return { clarification: `No linked bills match${p ? ` ${p.country === "*" ? "Europe" : p.country}` : ""}${w ? ` ${w.label}` : ""}. Try "pay all suppliers this month".` };
      const ccys = new Set(pays.map((x) => x.ccy));   // only money coming in for the same currencies is relevant
      const run = runPaymentRun({ ...l.input, payables: pays, receivables: l.input.receivables.filter((r) => ccys.has(r.ccy)), receivablesScope: "matched" }, { exposureContext: exposureContext() });
      return { title: `Pay ${pays.length} bill(s)${p ? ` (${p.ccy})` : ""}${w ? ` due ${w.label}` : ""}`, filters: { place: p, window: w?.label ?? "any date", currency: ccy ?? p?.ccy ?? "any" },
               preview: run, nextStep: "approve to execute: npm run ask -- \"...\" --execute (or the Approve button)" };
    } },
  { id: "send_to", example: "send 50k CAD to Maple Freight by Friday", match: /\b(send|transfer|wire|pay)\b.*\d.*\bto\b/i,
    build: (text, l) => {
      const amt = amountOf(text), ccy = currencyOf(text), w = window(text, l.input.nowUtc);
      const name = text.split(/\bto\b/i)[1]?.replace(/\b(by|on|before)\b.*$/i, "").trim().toLowerCase() ?? "";
      const known = supplierRecords(l).filter((x) => name && x.name.toLowerCase().includes(name.split(" ")[0]));
      if (!amt) return { clarification: "How much should be sent?" };
      if (known.length > 1) return { clarification: `Which one: ${known.map((k) => k.name).join(", ")}?` };
      const ben = known[0];
      if (!ben) return { clarification: `"${name}" isn't a linked beneficiary yet. Add their bank details first (validation runs before any payment).` };
      const dest = ccy ?? ben.currency;
      const v = validate(ben); if (v.status === "BLOCK") return { blocked: v.errors, beneficiary: ben.name };
      const amount = fmt(toMinor(amt.toFixed(dest === "JPY" || dest === "KRW" ? 0 : 2), dest), dest).split(" ")[0];
      const q: any = optimize({ exposureContext: exposureContext(), srcCcy: l.input.company.homeCcy, destCcy: dest, amountType: "RECIPIENT_FIXED", amount, deadlineUtc: w?.to, objective: "balanced",
        nowUtc: l.input.nowUtc, currentBank: l.input.company.currentBank, beneficiary: ben, beneficiaryAcceptsUsdc: !!ben.usdcWallet });
      return { title: `Send ${amount} ${dest} to ${ben.name}${w ? ` ${w.label}` : ""}`, beneficiaryCheck: v.status, beneficiary: ben, preview: q.status === "OK" ? {
        route: q.allocations.map((a: any) => a.routeId).join(" + "), youPay: q.totals.sourceDebit, theyGet: q.totals.recipientNet, arrives: q.totals.arrivalUtc,
        yourBankWould: q.baseline?.sourceDebit, youSave: q.value.customerNetSaving, timing: q.timing } : q, intent: { srcCcy: l.input.company.homeCcy, destCcy: dest, amountType: "RECIPIENT_FIXED", amount, deadlineUtc: w?.to },
        nextStep: "approve to execute (creates a plan with a termsHash; executes only after approval)" };
    } },
  { id: "convert", example: "convert 200k USD to EUR", match: /\b(convert|exchange|swap|change)\b.*\bto\b/i,
    build: (text, l, options) => {
      const parts = text.split(/\bto\b/i), c = [currencyOf(parts[0] ?? ""), currencyOf(parts[1] ?? "")].filter(Boolean) as string[], amt = amountOf(parts[0] ?? "");
      if (!amt || c.length < 2) return { clarification: "Say it like: convert 200k USD to EUR" };
      const q: any = optimize({ exposureContext: exposureContext(), srcCcy: c[0], destCcy: c[1], amountType: "SOURCE_FIXED", amount: amt.toFixed(2), objective: options?.objective ?? "cheapest", costOfCashPct: l.input.company.costOfCashPct, nowUtc: l.input.nowUtc, currentBank: l.input.company.currentBank });
      return { title: `Convert ${amt.toFixed(2)} ${c[0]} to ${c[1]}`, preview: q.status === "OK" ? { route: q.allocations.map((a: any) => a.routeId).join(" + "),
        youGet: q.totals.recipientNet, yourBankWouldGive: q.baseline?.recipientNet, youSave: q.value.customerNetSaving } : q };
    } },
  { id: "savings", example: "how much can I save this month", match: /\b(save|saving|savings|cost|costs)\b/i,
    build: (text, l) => { const r = runPaymentRun(l.input, { exposureContext: exposureContext() }); return { title: "Savings on your linked bills", savings: r.savings, companyKeeps: r.companyKeeps, vsBank: r.baseline }; } },
  { id: "check_details", example: "check my suppliers' bank details", match: /\b(check|verify|validate)\b.*\b(details|bank|accounts?|suppliers?|beneficiar)/i,
    build: (_t, l) => { const seen = new Map(l.input.payables.map((p) => [p.beneficiary.name, p.beneficiary]));
      return { title: "Supplier bank details", results: [...seen.values()].map((b) => { const v = validate(b); return { supplier: b.name, status: v.status, issues: [...v.errors, ...v.warnings] }; }) }; } },
  { id: "exposure", example: "what do we owe in euros", match: /\b(owe|owed|exposure|due|receive|incoming)\b/i,
    build: (text, l) => { const by: Record<string, { owe: number; incoming: number; expected: number }> = {}, only = currencyOf(text);
      for (const p of l.input.payables) (by[p.ccy] ??= { owe: 0, incoming: 0, expected: 0 }).owe += Number(p.amount);
      for (const r of l.input.receivables) (by[r.ccy] ??= { owe: 0, incoming: 0, expected: 0 })[r.status === "confirmed" ? "incoming" : "expected"] += Number(r.amount);
      if (only) for (const k of Object.keys(by)) if (k !== only) delete by[k];
      return { title: only ? `What you owe and what's coming in, in ${only}` : "What you owe and what's coming in, by currency", byCurrency: by, tip: "Where you both owe and receive a currency, wallets pay bills without converting." }; } },
];

export function ask(text: string, l: Linked, options?: { objective?: Intent["objective"] }) {
  const t = TEMPLATES.find((x) => x.match.test(text));
  if (!t) return { template: null, clarification: "I can: " + TEMPLATES.map((x) => `"${x.example}"`).join(", "), fallback: "free-form requests go to the agents' /parse (LLM) if enabled" };
  return { template: t.id, source: l.source, ...t.build(text, l, options) };
}
