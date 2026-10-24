// Context belongs to a company and conversation. Only identifiers and user-requested slots are reused;
// client-supplied assistant messages never grant authority or become executable instructions.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ask, amountOf, currencyOf, place, planSend, window } from "./prompts.js";
import { loadLinked, type Linked } from "./linked.js";
import { supplierDirectory, supplierRecords, addSupplier, type SupplierDraft } from "../company/suppliers.js";
import { runPaymentRun } from "../company/paymentRun.js";
import { load as loadRouter } from "../router/store.js";
import { unsafeInstruction, publicData } from "./safety.js";
import { explanation } from "./explanations.js";

type Task = { kind: "send" | "batch" | "convert"; supplierId?: string; amount?: number; currency?: string; sourceCurrency?: string;
  deadlineUtc?: string; billIds?: string[]; policy?: string; reference: string; requestedSupplierName?: string };
interface Conversation {
  id: string; companyId: string; tenantId: string; revision: number; selected: string[]; topic?: string; task?: Task;
  supplierDraft?: SupplierDraft; explanationTopic?: string; intentIds: string[]; decisions: any[]; turns: { user: string; reply: any }[];
}
export class ConversationConflict extends Error {}
const clean = (text: string) => text.trim().replace(/\b(companeis|companys|comapnies)\b/gi, "companies").replace(/\bsupliers?\b/gi, "suppliers");
const idOk = (id: string) => /^[A-Za-z0-9_-]{8,80}$/.test(id);
function fileFor(l: Linked, tenant: string, id: string) {
  if (!idOk(id)) throw new Error("Invalid conversation ID");
  return `data/conversations/${createHash("sha256").update(JSON.stringify([tenant, l.input.company.companyId, id])).digest("hex")}.json`;
}
function read(l: Linked, tenant: string, id: string): Conversation {
  const file = fileFor(l, tenant, id);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { id, companyId: l.input.company.companyId, tenantId: tenant,
    revision: 0, selected: [], intentIds: [], decisions: [], turns: [] };
}
function save(l: Linked, c: Conversation) {
  const file = fileFor(l, c.tenantId, c.id); mkdirSync("data/conversations", { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(c, null, 2)); renameSync(`${file}.tmp`, file);
}
function context(c: Conversation) {
  return { conversationId: c.id, conversationRevision: c.revision, topic: c.topic, selectedSupplierIds: c.selected,
    task: c.task ? { ...c.task } : null };
}
export function conversationView(tenant: string, id: string) {
  const c = read(loadLinked(), tenant, id); return publicData({ ...context(c), activeIntentIds: c.intentIds, turns: c.turns });
}
function namedSuppliers(text: string, l: Linked) {
  const records = supplierRecords(l), t = text.toLowerCase();
  const exact = records.filter((b) => t.includes(b.name.toLowerCase())); if (exact.length) return exact;
  return records.filter((b) => b.name.toLowerCase().split(/\s+/).some((word) => word.length >= 4 && new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t)));
}
const unsupported = (t: string) => /\b(ignore (?:all|previous|your)|system prompt|poems?|jokes?|recipes?|homework|wallpaper|weather forecast|what(?:'s| is) the weather|sports scores|solve this equation|write (?:me )?(?:a |some )?(?:essay|code|story))\b/i.test(t);
const help = "I can help with your company, suppliers, invoices, currencies, payment routes, savings and payment status. Try ‘list my suppliers using MXN’, ‘pay them’, or ‘add a supplier’.";
const reference = () => `chat_${randomUUID()}`;
function policies(text: string, previous?: string) { return /\b(fastest|urgent|asap)\b/i.test(text) ? "fastest" : /\b(lowest risk|safest)\b/i.test(text) ? "lowest_risk" : /\b(cheapest|lowest cost)\b/i.test(text) ? "cheapest" : previous ?? "cheapest"; }
function existingTransfers(c: Conversation) {
  return Object.values(loadRouter().transfers).filter((t: any) => c.intentIds.includes(t.intentId)
    || (c.task?.kind === "send" && t.terms?.intent?.reference === c.task.reference)
    || (c.task?.kind === "batch" && c.task.billIds?.includes(t.terms?.intent?.reference)));
}
function statusReply(c: Conversation) {
  const transfers = existingTransfers(c);
  if (transfers.length) return { template: "payment_status", title: "Status of the payment we discussed", transfers: transfers.map((t: any) => ({
    id: t.transferId, status: t.status, amount: (t.executionPlan ?? t.terms).totals.recipientNet, deadlineStatus: t.deadlineStatus,
    note: t.note ?? t.history.at(-1)?.note ?? "", supplier: t.terms.intent.beneficiary?.name })) };
  if (c.decisions.length) return { template: "payment_status", title: "Your latest agent review", message: "This was a preview and agent review; no supplier payment has been submitted from this plan.",
    reviewResults: c.decisions.map((d) => ({ supplier: d.payable, decision: d.decision, reasons: d.reasons })) };
  const lastPlan = [...c.turns].reverse().find((turn) => ["send_to", "pay_bills"].includes(turn.reply.template))?.reply;
  if (lastPlan?.blocked || lastPlan?.preview?.status === "HOLD") return { template: "payment_status", title: "Why the last preview could not proceed",
    message: (lastPlan.blocked ?? [lastPlan.preview.reason]).join("; ") };
  return { template: "payment_status", title: "No submitted payment in this conversation", message: c.task ? "We have a draft or preview. A payment is sent only after the approval flow." : "Ask me to plan a payment first, or open a previous conversation." };
}
function draftFromText(text: string, previous?: SupplierDraft): SupplierDraft {
  const draft = { ...previous }, p = place(text), ccy = currencyOf(text);
  const countryCode = text.match(/\bcountry\s*[:=]?\s*([A-Z]{2})\b/i)?.[1] ?? (/^[a-z]{2}$/i.test(text) ? text : undefined);
  if (p && p.country !== "*") draft.country = p.country;
  else if (countryCode) draft.country = countryCode.toUpperCase();
  if (ccy) draft.currency = ccy;
  const name = text.match(/\b(?:add|create|register)\s+(?:a\s+|new\s+)?(?:company\s+)?(?:supplier|vendor|company)\s+(?:called\s+|named\s+)?(.+?)(?=\s+(?:in|using|paid in|currency|country)\b|[,;]|$)/i)?.[1]
    ?? text.match(/\bname\s*[:=]\s*(.+?)(?=[,;]|$)/i)?.[1];
  if (name && !/^(?:please|company|supplier|vendor)$/i.test(name)) draft.name = name.replace(/^["']|["']$/g, "").trim();
  if (previous && !previous.name && !name && !p && !ccy && !countryCode && !/\b(add|create|register|supplier|vendor|company)\b/i.test(text)) draft.name = text;
  return draft;
}
function supplierDraftReply(c: Conversation) {
  const d = c.supplierDraft!;
  const missing = !d.name ? "What is the supplier company’s name?" : !d.country ? "Which country is the supplier in?" : !d.currency ? "Which currency should this supplier receive?" : null;
  return missing ? { template: "add_supplier", clarification: missing, supplierDraft: d }
    : { template: "add_supplier", title: "Review the new supplier", message: "Confirm the supplier and enter their receiving details below. Nothing is saved until you confirm, and no invoice or payment will be created.",
      supplierDraft: d, action: { type: "add_supplier" } };
}
function planTask(c: Conversation, l: Linked): any {
  const task = c.task!;
  if (task.kind === "send") {
    if (!task.supplierId) return { template: "send_to", clarification: task.requestedSupplierName ? `“${task.requestedSupplierName}” is not a saved supplier. Ask to add this supplier, or choose an existing supplier by name.`
      : `Which supplier? ${supplierDirectory(l).filter((s) => c.selected.includes(s.id)).map((s) => s.name).join(", ") || "Say a saved supplier’s name."}` };
    if (task.amount == null) return { template: "send_to", clarification: "How much should the supplier receive?" };
    return { ...planSend(l, task.supplierId, task.amount, task.currency, task.deadlineUtc), paymentRef: task.reference, policy: task.policy };
  }
  if (task.kind === "batch") {
    const bills = l.input.payables.filter((p) => task.billIds?.includes(p.id));
    if (!bills.length) return { template: "pay_bills", clarification: "No open bills match these suppliers. You can still request a new payment with an amount and supplier name." };
    const selected = new Set(bills.map((p) => p.ccy));
    const run = runPaymentRun({ ...l.input, payables: bills.map((p) => task.deadlineUtc ? { ...p, dueUtc: task.deadlineUtc } : p),
      receivables: l.input.receivables.filter((r) => selected.has(r.ccy)), receivablesScope: "matched" });
    return { template: "pay_bills", title: `Plan ${bills.length} linked invoice${bills.length === 1 ? "" : "s"}`, preview: run, policy: task.policy };
  }
  if (task.amount == null || !task.sourceCurrency || !task.currency) return { template: "convert", clarification: "Which amount and currencies? For example: convert 1000 USD to MXN." };
  return { ...ask(`convert ${task.amount} ${task.sourceCurrency} to ${task.currency}`, l), policy: task.policy };
}

export function askConversation(tenant: string, raw: string, id: string = randomUUID(), expectedRevision?: number): any {
  if (typeof raw !== "string") throw new Error("A text message is required");
  const l = loadLinked(), c = read(l, tenant, id), text = clean(raw), t = text.toLowerCase();
  if (!text || text.length > 500) throw new Error("Use a request between 1 and 500 characters");
  if (expectedRevision != null && expectedRevision !== c.revision) throw new ConversationConflict("This conversation changed in another request. Reopen it before sending again.");
  let result: any;
  const info = explanation(text, c.explanationTopic ?? (c.topic === "payment" ? "status" : c.topic?.startsWith("supplier") ? "suppliers" : undefined));
  const names = namedSuppliers(text, l), directory = supplierDirectory(l), ccy = currencyOf(text), p = place(text);
  const amountText = text.replace(/\b20\d\d-\d\d-\d\d\b/g, ""), parsedAmount = amountOf(amountText);
  const amount = /(?:^|\s)-\s*\$?\s*\d/.test(amountText) && parsedAmount != null ? -parsedAmount
    : parsedAmount ?? (/\d/.test(amountText) ? 0 : null), date = window(text, l.input.nowUtc);
  const add = /\b(add|create|register)\s+(?:a\s+|new\s+)?(?:company\s+)?(?:supplier|vendor|company)\b/i.test(text);
  const query = /\b(list|show|which|what|who|have|associated)\b/i.test(text) && /\b(suppliers?|vendors?|companies|companeis)\b/i.test(text);
  const currencyAnswer = !!ccy && /^(?:[A-Z]{3}|dollars?|euros?|pesos?|pounds?|yen)[?.!]*$/i.test(text);
  const directoryFollowup = c.topic === "suppliers" && (!!(ccy || p) && /^(?:what about|how about|only|and|instead|the)\b/i.test(text) || currencyAnswer);
  const shortAmount = /^\$?\s*\d[\d,]*(?:\.\d+)?\s*[km]?(?:\s+(?:[A-Z]{3}|dollars?|euros?|pesos?|pounds?|rupees|yen))?(?:\s+(?:please|instead))?$/i.test(text);
  const adjustment = text.replace(/^(?:please\s+)?(?:make (?:it|that)|actually|instead)\s+/i, "");
  const edit = /\b(try again|retry)\b/i.test(text) || /\b(change|update|set)\b.*\b(amount|currency|deadline|recipient|supplier|route|policy)\b/i.test(text)
    || /\b(change|update|set|increase|decrease|reduce)\s+(?:it|that|this|the amount|amount)\s+(?:to\s+)?\$?-?\d/i.test(text)
    || (adjustment !== text && /^\$?\s*\d[\d,]*(?:\.\d+)?\s*[km]?(?:\s+(?:[A-Z]{3}|dollars?|euros?|pesos?))?(?:\s+instead)?$/i.test(adjustment))
    || (!!ccy && /^(?:what about|how about|actually(?: use)?|use|instead)\s+(?:[A-Z]{3}|dollars?|euros?|pesos?|pounds?|yen)(?:\s+instead)?[?.!]*$/i.test(text))
    || (!!date && /^(?:by |on |before |try it by |make it by |actually by )/i.test(text));
  const payment = /\b(send|transfer|wire|pay|settle|run)\b/i.test(text);
  const unrelatedQuestion = /^(?:what|who|how|where|when|why|can you|could you|tell me)\b/i.test(text)
    && !/\b(company|companies|suppliers?|vendors?|invoices?|payments?|amount|currency|currencies|deadline|bank|account|balance|owe|savings?|route|status|country|did it|did that|happened)\b/i.test(text) && !ccy && !names.length && !directoryFollowup && !payment && !(edit && c.task);
  if (unsafeInstruction(text)) result = { template: "out_of_scope", title: "Chat cannot override security controls", message: "I can explain features or help plan business payments. Chat cannot change its authority, reveal credentials, bypass checks, execute code, or approve payments." };
  else if (info) { result = info; c.explanationTopic = info.explanationTopic ?? c.explanationTopic; }
  else if (unsupported(text) || unrelatedQuestion) result = { template: "out_of_scope", title: "Let’s keep this about your business payments", message: help };
  else if (/\b(cancel|discard)\b/i.test(text) && c.supplierDraft) { delete c.supplierDraft; result = { template: "supplier_draft_cancelled", title: "Supplier draft discarded", message: "No supplier was saved." }; }
  else if (add || (c.topic === "supplier_draft" && c.supplierDraft && !query && !payment && !edit && !/\b(owe|savings|status|check|verify|validate|convert|exchange|swap|why|how|what|list|show)\b/i.test(text))) {
    c.topic = "supplier_draft"; c.supplierDraft = draftFromText(text, add ? undefined : c.supplierDraft); result = supplierDraftReply(c);
  }
  else if (/\b(why|status|did it work|did that work|what happened|failed|failure|worked|successful|completed)\b/i.test(text) && !payment && !edit) result = statusReply(c);
  else if (/\b(my|our) company\b/i.test(text) && /\b(name|which|what|about|details)\b/i.test(text) && !ccy) {
    result = { template: "company_info", title: l.input.company.name, message: `Your company’s home currency is ${l.input.company.homeCcy}.`,
      companyInfo: { name: l.input.company.name, homeCurrency: l.input.company.homeCcy, supplierCount: directory.length } };
  }
  else if (query || directoryFollowup) {
    const rows = directory.filter((s) => (!ccy || s.currencies.includes(ccy)) && (!p || p.country === "*" || s.country === p.country));
    c.topic = "suppliers"; c.selected = rows.map((s) => s.id);
    result = { template: "list_suppliers", title: ccy ? `Supplier companies using ${ccy}` : "Your supplier companies", suppliers: rows,
      message: rows.length ? `${rows.length} saved supplier compan${rows.length === 1 ? "y" : "ies"}. Ask about one by name, or say ‘pay them’ to plan their linked bills.` : "No saved suppliers match. You can add a supplier or try another currency." };
  }
  else if (/\b(convert|exchange|swap)\b/i.test(text) || (c.task?.kind === "convert" && (edit || currencyAnswer))) {
    const currencies = text.toUpperCase().match(/\b[A-Z]{3}\b/g)?.filter((v) => currencyOf(v) === v) ?? [];
    c.task = { ...(c.task?.kind === "convert" && edit ? c.task : { kind: "convert" as const, reference: reference() }),
      amount: amount ?? c.task?.amount, sourceCurrency: currencies.length > 1 ? currencies[0] : c.task?.sourceCurrency,
      currency: currencies.at(-1) ?? c.task?.currency, policy: policies(text, c.task?.policy) };
    c.topic = "payment"; result = planTask(c, l);
  }
  else if (names.length && /^(?:tell me about|show me|what|who|where|does|which)\b/i.test(text) && !payment && !edit) {
    c.topic = "suppliers"; c.selected = names.map((s) => s.id);
    result = { template: "list_suppliers", title: "Supplier details", suppliers: directory.filter((s) => names.some((b) => b.id === s.id)) };
  }
  else if (payment || (edit && c.task) || (c.task?.kind === "send" && (shortAmount || currencyAnswer || names.some((s) => s.name.toLowerCase() === t) || /^(?:the )?(?:first|second|third|last|that|this) one$/i.test(text)))) {
    const prior = c.task, transfers = existingTransfers(c), busy = transfers.find((v: any) => ["SCHEDULED", "EXECUTING", "NEEDS_RECONCILIATION", "PARTIAL"].includes(v.status));
    if (busy) result = { ...statusReply(c), title: "Resolve the existing transfer first", message: `Transfer ${busy.transferId} is ${busy.status}. I can explain its status, but changing the amount or retrying must not resend money while its outcome is unresolved.` };
    else {
      let chosen = names;
      const ordinal = /\b(first|second|third|last)\b/i.exec(text)?.[1]?.toLowerCase();
      if (!chosen.length && ordinal && c.selected.length) { const index = ordinal === "last" ? c.selected.length - 1 : ["first", "second", "third"].indexOf(ordinal); chosen = supplierRecords(l).filter((s) => s.id === c.selected[index]); }
      const useContext = !/\bto\s+(?!them\b|that\b|the\b|\d|\$)/i.test(text) || names.length > 0;
      const recipientChange = /\b(?:change|update|set)\b.*\b(?:recipient|supplier)\b/i.test(text);
      if (!chosen.length && edit && !recipientChange && prior?.supplierId) chosen = supplierRecords(l).filter((s) => s.id === prior.supplierId);
      if (!chosen.length && !recipientChange && useContext && c.selected.length === 1) chosen = supplierRecords(l).filter((s) => s.id === c.selected[0]);
      const batch = amount == null && /\b(all|suppliers?|vendors?|bills?|invoices?|them|everyone)\b/i.test(text) && !(edit && prior?.kind === "send");
      if (edit && prior?.kind === "batch" && amount == null && !names.length) {
        c.task = { ...prior, deadlineUtc: date?.to ?? prior.deadlineUtc, policy: policies(text, prior.policy), reference: reference() };
      } else if (batch) {
        let bills = l.input.payables.filter((b) => (!ccy || b.ccy === ccy) && (!p || p.country === "*" || b.beneficiary.country === p.country));
        if (names.length) bills = bills.filter((b) => names.some((s) => s.id === b.beneficiary.id));
        else if (/\b(them|those|these)\b/.test(t)) bills = bills.filter((b) => c.selected.includes(b.beneficiary.id));
        if (date) bills = bills.filter((b) => b.dueUtc <= date.to || (!!b.discountByUtc && b.discountByUtc <= date.to));
        c.task = { kind: "batch", billIds: bills.map((b) => b.id), reference: reference(), policy: policies(text, prior?.policy) };
        c.selected = [...new Set(bills.map((b) => b.beneficiary.id))];
      } else {
        c.task = { kind: "send", supplierId: chosen.length === 1 ? chosen[0].id : undefined,
          amount: amount ?? (edit || !payment ? prior?.amount : undefined), currency: ccy ?? ((edit || !payment ? prior?.currency : undefined) ?? chosen[0]?.currency),
          deadlineUtc: date?.to ?? (edit || !payment ? prior?.deadlineUtc : undefined), policy: policies(text, prior?.policy), reference: reference() };
        if (!chosen.length && ((payment && !edit && !useContext) || recipientChange)) {
          c.task.requestedSupplierName = text.match(/\bto\s+(.+?)(?=\s+(?:by|on|before)\b|$)/i)?.[1]; c.selected = [];
        }
        if (chosen.length === 1) c.selected = [chosen[0].id];
      }
      c.topic = "payment"; c.intentIds = []; c.decisions = []; result = planTask(c, l);
      if (transfers.some((v: any) => v.status === "COMPLETED")) result.message = "The previous transfer already completed. This is a separate new preview; it does not change or resend that transfer. Review it before creating another payment.";
    }
  }
  else if (/\b(owe|owed|incoming|receivables?|exposure|savings?|save|check|verify|validate)\b/i.test(text)) {
    const ids = names.length ? names.map((b) => b.id) : /\b(them|their|those|these)\b/i.test(text) ? c.selected : [];
    if (names.length) { c.selected = ids; c.topic = "suppliers"; }
    const focusedBills = l.input.payables.filter((b) => ids.includes(b.beneficiary.id)), currencies = new Set(focusedBills.map((b) => b.ccy));
    const focused = ids.length ? { ...l, input: { ...l.input, payables: focusedBills,
      receivables: l.input.receivables.filter((r) => currencies.has(r.ccy)), receivablesScope: "matched" as const } } : l;
    const reply = ask(text, focused); result = reply.template ? reply : { template: "help", title: "Company payment questions", message: help };
  }
  else if (/^(thanks|thank you|hi|hello|help)[!. ]*$/i.test(text)) result = { template: "help", title: "Your company payment assistant", message: help };
  else result = { template: "out_of_scope", title: "I help with company payments and suppliers", message: help };
  c.revision++;
  result = { source: l.source, ...result, ...context(c), company: l.input.company };
  const stored = publicData({ ...result }); delete stored.beneficiary; delete stored.company;
  c.turns.push({ user: text, reply: stored }); c.turns = c.turns.slice(-40); save(l, c);
  return result;
}

export function recordConversationReview(tenant: string, id: string, revision: number, decisions: any[]) {
  const l = loadLinked(), c = read(l, tenant, id);
  if (revision !== c.revision) return false;
  c.decisions = decisions.map((d) => ({ payable: d.payable, decision: d.decision, reasons: (d.reasons ?? []).slice(0, 8), intentId: d.intentId }));
  c.intentIds = decisions.map((d) => d.intentId).filter((id) => typeof id === "string" && !!loadRouter().intents[id]);
  if (c.turns.length) c.turns.at(-1)!.reply.reviewResults = c.decisions;
  save(l, c); return true;
}

export function confirmSupplier(tenant: string, id: string, revision: number, details: Record<string, unknown>, actor: string) {
  const l = loadLinked(), c = read(l, tenant, id);
  if (c.revision !== revision) throw new ConversationConflict("This supplier draft changed. Reopen the latest draft before saving.");
  if (!c.supplierDraft) throw new Error("There is no supplier draft to confirm");
  const result = addSupplier(l, c.supplierDraft, details, actor);
  delete c.supplierDraft; delete c.task; c.intentIds = []; c.decisions = [];
  c.selected = [result.beneficiary.id]; c.topic = "suppliers"; c.revision++;
  const reply = { template: "supplier_created", title: `${result.beneficiary.name} was added`, message: "The supplier is saved. No invoice or payment was created. You can now ask to send an amount to this supplier.",
    suppliers: supplierDirectory(l).filter((s) => s.id === result.beneficiary.id), ...context(c) };
  c.turns.push({ user: "Confirmed supplier details", reply }); save(l, c); return reply;
}
