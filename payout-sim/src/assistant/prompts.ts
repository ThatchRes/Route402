// Prompt templates: everyday requests -> a ready-made plan built from the company's linked data.
// Deterministic matching + slot filling (no LLM needed for these, so it is fast, cheap and repeatable).
// Every result is a PREVIEW; executing always needs an explicit approval step.
import { runPaymentRun } from "../company/paymentRun.js";
import { validate } from "../company/validate.js";
import { optimize } from "../router/optimizer.js";
import { fmt, toMinor } from "../money.js";
import type { Linked } from "./linked.js";

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
  pound: "GBP", pounds: "GBP", sterling: "GBP", yen: "JPY", reais: "BRL", real: "BRL", rupees: "INR", "singapore dollars": "SGD" };
function currencyOf(text: string): string | undefined {
  const c = text.match(CCY)?.[1]?.toUpperCase(); if (c) return c;
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
function place(text: string) { const t = text.toLowerCase(); const k = Object.keys(PLACES).find((p) => new RegExp(`\\b${p}\\b`).test(t)); return k ? PLACES[k] : null; }
function amountOf(text: string) {
  const m = text.replace(/\$/g, "").match(AMOUNT); if (!m) return null;
  let n = Number(m[1].replace(/,/g, "")); if (m[2]?.toLowerCase() === "k") n *= 1e3; if (m[2]?.toLowerCase() === "m") n *= 1e6;
  return n > 0 ? n : null;
}

export interface Template { id: string; example: string; match: RegExp; build: (text: string, l: Linked) => any }

export const TEMPLATES: Template[] = [
  { id: "pay_bills", example: "pay my German suppliers this week", match: /\b(pay|run|settle)\b.*\b(suppliers?|vendors?|bills?|invoices?|payables?|everyone|all)\b/i,
    build: (text, l) => {
      const p = place(text), w = window(text, l.input.nowUtc), ccy = currencyOf(text);
      const pays = l.input.payables.filter((x) => (!p || p.country === "*" ? true : x.beneficiary.country === p.country) && (!(p?.ccy || ccy) || x.ccy === (ccy ?? p!.ccy))
        && (!w || (Date.parse(x.dueUtc) <= Date.parse(w.to) || (x.discountByUtc && Date.parse(x.discountByUtc) <= Date.parse(w.to)))));
      if (!pays.length) return { clarification: `No linked bills match${p ? ` ${p.country === "*" ? "Europe" : p.country}` : ""}${w ? ` ${w.label}` : ""}. Try "pay all suppliers this month".` };
      const ccys = new Set(pays.map((x) => x.ccy));   // only money coming in for the same currencies is relevant
      const run = runPaymentRun({ ...l.input, payables: pays, receivables: l.input.receivables.filter((r) => ccys.has(r.ccy)), receivablesScope: "matched" });
      return { title: `Pay ${pays.length} bill(s)${p ? ` (${p.ccy})` : ""}${w ? ` due ${w.label}` : ""}`, filters: { place: p, window: w?.label ?? "any date", currency: ccy ?? p?.ccy ?? "any" },
               preview: run, nextStep: "approve to execute: npm run ask -- \"...\" --execute (or the Approve button)" };
    } },
  { id: "send_to", example: "send 50k CAD to Maple Freight by Friday", match: /\b(send|transfer|wire|pay)\b.*\d.*\bto\b/i,
    build: (text, l) => {
      const amt = amountOf(text), ccy = currencyOf(text), w = window(text, l.input.nowUtc);
      const name = text.split(/\bto\b/i)[1]?.replace(/\b(by|on|before)\b.*$/i, "").trim().toLowerCase() ?? "";
      const known = [...new Map(l.input.payables.map((x) => [x.beneficiary.name, x])).values()].filter((x) => name && x.beneficiary.name.toLowerCase().includes(name.split(" ")[0]));
      if (!amt) return { clarification: "How much should be sent?" };
      if (known.length > 1) return { clarification: `Which one: ${known.map((k) => k.beneficiary.name).join(", ")}?` };
      const ben = known[0]?.beneficiary;
      if (!ben) return { clarification: `"${name}" isn't a linked beneficiary yet. Add their bank details first (validation runs before any payment).` };
      const dest = ccy ?? ben.currency;
      const v = validate(ben); if (v.status === "BLOCK") return { blocked: v.errors, beneficiary: ben.name };
      const amount = fmt(toMinor(amt.toFixed(dest === "JPY" || dest === "KRW" ? 0 : 2), dest), dest).split(" ")[0];
      const q: any = optimize({ srcCcy: l.input.company.homeCcy, destCcy: dest, amountType: "RECIPIENT_FIXED", amount, deadlineUtc: w?.to, objective: "balanced",
        nowUtc: l.input.nowUtc, currentBank: l.input.company.currentBank });
      return { title: `Send ${amount} ${dest} to ${ben.name}${w ? ` ${w.label}` : ""}`, beneficiaryCheck: v.status, preview: q.status === "OK" ? {
        route: q.allocations.map((a: any) => a.routeId).join(" + "), youPay: q.totals.sourceDebit, theyGet: q.totals.recipientNet, arrives: q.totals.arrivalUtc,
        yourBankWould: q.baseline?.sourceDebit, youSave: q.value.customerNetSaving } : q, intent: { srcCcy: l.input.company.homeCcy, destCcy: dest, amountType: "RECIPIENT_FIXED", amount, deadlineUtc: w?.to },
        nextStep: "approve to execute (creates a plan with a termsHash; executes only after approval)" };
    } },
  { id: "convert", example: "convert 200k USD to EUR", match: /\b(convert|exchange|swap|change)\b.*\bto\b/i,
    build: (text, l) => {
      const parts = text.split(/\bto\b/i), c = [currencyOf(parts[0] ?? ""), currencyOf(parts[1] ?? "")].filter(Boolean) as string[], amt = amountOf(parts[0] ?? "");
      if (!amt || c.length < 2) return { clarification: "Say it like: convert 200k USD to EUR" };
      const q: any = optimize({ srcCcy: c[0], destCcy: c[1], amountType: "SOURCE_FIXED", amount: amt.toFixed(2), objective: "cheapest", nowUtc: l.input.nowUtc, currentBank: l.input.company.currentBank });
      return { title: `Convert ${amt.toFixed(2)} ${c[0]} to ${c[1]}`, preview: q.status === "OK" ? { route: q.allocations.map((a: any) => a.routeId).join(" + "),
        youGet: q.totals.recipientNet, yourBankWouldGive: q.baseline?.recipientNet, youSave: q.value.customerNetSaving } : q };
    } },
  { id: "savings", example: "how much can I save this month", match: /\b(save|saving|savings|cost|costs)\b/i,
    build: (text, l) => { const r = runPaymentRun(l.input); return { title: "Savings on your linked bills", savings: r.savings, companyKeeps: r.companyKeeps, vsBank: r.baseline }; } },
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

export function ask(text: string, l: Linked) {
  const t = TEMPLATES.find((x) => x.match.test(text));
  if (!t) return { template: null, clarification: "I can: " + TEMPLATES.map((x) => `"${x.example}"`).join(", "), fallback: "free-form requests go to the agents' /parse (LLM) if enabled" };
  return { template: t.id, source: l.source, ...t.build(text, l) };
}
