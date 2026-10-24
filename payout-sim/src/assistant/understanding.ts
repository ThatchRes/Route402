// The LLM selects an action ID, never text to execute or money/identity/authority fields.
// All candidate requests are constructed here from the user's own message and server context.
import { createHash } from "node:crypto";
import { askConversation, conversationView, ConversationConflict, moneyIn } from "./conversation.js";
import { loadLinked } from "./linked.js";
import { currencyOf, place, window as paymentWindow } from "./prompts.js";
import { unsafeInstruction } from "./safety.js";

type Candidate = { id: string; description: string; request: string };
// Minimize data sent to the model. No provider payloads, accounts, wallets, quotes, keys or approvals.
const sensitive = /https?:\/\/\S+|\b[A-Z]{2}\d{2}[A-Z0-9 ]{10,32}|0x[a-f\d]{40,64}\b|\b\d{10,}\b|\b(?:sk-|Bearer\s+)\S+|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:api[_ -]?key|password|secret|token|iban|account number)\s*[:=]\s*\S+/gi;
function scrub(value: unknown, limit = 300) {
  return String(value ?? "").replace(sensitive, "[private detail omitted]").slice(0, limit);
}
const unsafeContext = (text: string) => unsafeInstruction(text) || /\b(?:decode|base64|eval|curl|powershell|javascript|credentials?)\b/i.test(text);
const affirmative = /^(?:yes|yep|yeah|ok|okay|confirm|approve|send it|go ahead|do it|yes please)[.! ]*$/i;
const negativeOrConditional = /\b(?:not|never|don't|do not|unless|if|hypothetical|pretend|imagine)\b|\bwhat if\b/i;
const financialAmbiguity = /%|\b(?:percent|half|double|triple|or|between|roughly|approximately|around|about|up to|at least|more than|less than)\b|\bby\s*[$£€]?\s*\d/i;

function snapshot(tenant: string, id: string, revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid conversation revision");
  const c = conversationView(tenant, id), last = c.turns.at(-1);
  if (c.conversationRevision !== revision || last?.reply.template !== "out_of_scope")
    throw new ConversationConflict("The conversation changed or this message is already understood.");
  const text = String(last.user), linked = loadLinked();
  const token = createHash("sha256").update(JSON.stringify([tenant, linked.input.company.companyId, id, revision, text, c.task, c.selectedSupplierIds])).digest("hex");
  const safe = !unsafeContext(text) && scrub(text, 500) === text && !affirmative.test(text)
    && !/\b(?:poems?|jokes?|recipes?|homework|weather|sports|write.*(?:code|story|essay))\b/i.test(text);
  const candidates: Candidate[] = [];
  const add = (id: string, description: string, request: string) => { if (request.length <= 500 && !unsafeInstruction(request)) candidates.push({ id, description, request }); };
  if (safe) {
    // Broad conversational intent is inferred, but no arbitrary generated wording reaches the parser.
    if (!negativeOrConditional.test(text) && /\b(?:money|cash|cost|price|budget|fees?|speed|quick|soon|wait|waiting|time|hurry|priority|prioriti[sz]e|prefer|balance|risk|cheap|fast)\b/i.test(text)) {
      add("prefer_cheapest", "Prefer lowest total cash cost, including fees; waiting is acceptable. Keeps the same payment details.", "I prefer the cheapest");
      add("prefer_fastest", "Prefer earliest arrival over cash cost. Keeps the same payment details.", "I prefer the fastest");
      add("prefer_balanced", "Balance cash cost and arrival time using the existing company cost of cash.", "I prefer balanced");
    }
    add("status", "Ask what happened to the current payment or how it is progressing. Read only.", "did it work?");
    add("suppliers", "List saved suppliers, without changing or sending a payment.", "list my suppliers");
    const ccy = currencyOf(text), region = place(text);
    if (ccy || region) add("supplier_filter", "Find suppliers using the currency or in the country explicitly named in this message.", `find suppliers ${text}`);
    const topics: Record<string, string> = { fees: "fees", routing: "payment routes", agents: "agents", approvals: "approval", deadlines: "deadlines", security: "security", escrow: "escrow", capabilities: "Route402" };
    for (const [id, topic] of Object.entries(topics)) add(`explain_${id}`, `Explain ${topic} using the product's verified explanation. Read only.`, `explain ${topic}`);
    const priorTopic = [...c.turns].reverse().find((t: any) => t.reply.explanationTopic)?.reply.explanationTopic;
    if (priorTopic) add("explain_previous", "Explain the topic discussed earlier in this conversation again.", "explain that");
    // Slot values are never supplied by the LLM. Only parse evidence in the latest user message.
    const amount = moneyIn(text);
    const exactMoney = !financialAmbiguity.test(text) && (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).length === 1;
    if (c.task && exactMoney && !negativeOrConditional.test(text) && !amount.goods && amount.amount != null && /\b(?:amount|budget|total|instead|rather|make|bump|raise|lower|adjust|actually)\b/i.test(text))
      add("edit_amount", "Change the current draft to the explicit amount in the latest message; keep supplier and other details.", `change the amount ${text}`);
    if (c.task && !negativeOrConditional.test(text) && paymentWindow(text, linked.input.nowUtc))
      add("edit_deadline", "Change the current draft's deadline to the explicit date in the latest message.", `change the deadline ${text}`);
    if (c.task && !negativeOrConditional.test(text) && ccy && amount.amount == null)
      add("edit_currency", "Change the current draft's currency to the currency explicitly named in this message.", `change the currency ${text}`);
    if (!negativeOrConditional.test(text) && !financialAmbiguity.test(text) && (amount.amount == null || exactMoney) && /\b(?:remit|remittance|disburse)\b/i.test(text))
      add("plan_payment", "Plan a new payment using only the amount and supplier explicitly given, asking for anything missing. Does not send it.", `pay ${text}`);
  }
  const history = c.turns.slice(-7, -1).filter((t: any) => !unsafeContext(t.user)).map((t: any) => ({
    user: scrub(t.user), responseType: t.reply.template, reply: scrub(t.reply.clarification ?? t.reply.title),
  }));
  return { c, text, token, candidates, data: { eligible: safe, snapshotToken: token, message: safe ? text : "",
    history: safe ? history : [], state: safe ? { topic: c.topic, taskKind: c.task?.kind ?? null,
      hasAmount: c.task?.amount != null, hasSupplier: !!c.task?.supplierId, routingPreference: c.routingPolicy ?? "balanced",
      selectedSupplierCount: c.selectedSupplierIds.length } : {},
    candidates: candidates.map(({ id, description }) => ({ id, description })) } };
}

export function understandingContext(tenant: string, id: string, revision: number) {
  return snapshot(tenant, id, revision).data;
}

export function applyUnderstanding(tenant: string, id: string, revision: number, token: string, choice: unknown) {
  const s = snapshot(tenant, id, revision);
  if (s.token !== token) throw new ConversationConflict("This interpretation belongs to a different conversation state.");
  if (typeof choice !== "string") throw new Error("Choose one supported interpretation");
  const candidate = s.candidates.find((x) => x.id === choice);
  if (!candidate) throw new Error("Unsupported or unsafe interpretation");
  return askConversation(tenant, candidate.request, id, revision, { original: s.text });
}
