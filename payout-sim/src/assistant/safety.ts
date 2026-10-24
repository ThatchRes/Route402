// Defense in depth only. Authority comes from fixed tool paths, server records and approval gates,
// never from whether a phrase passes this screen. Encoded content is never decoded or executed.
export function unsafeInstruction(text: string) {
  const t = text.normalize("NFKC").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "");
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(t)
    || /\b(?:ignore|disregard|forget|override|bypass|disable|skip)\b.{0,70}\b(?:instructions?|rules?|checks?|approvals?|controls?|policy|policies|screens?|safety|security|limits?)\b/is.test(t)
    || /\b(?:system|developer)\s*(?:prompt|message)\b|\byou are now\b|\b(?:reveal|print|show|read|send|export)\b.{0,50}\b(?:secrets?|private keys?|api keys?|service tokens?|environment variables?|\.env)\b/is.test(t)
    || /<\/?(?:system|developer|assistant|tool)\b|\[INST\]|\[\/?SYSTEM\]|(?:^|\n)\s*(?:system|developer|assistant|tool)\s*:/i.test(t);
}

// Do not put receiving credentials or prototype keys into browser transcripts or public API projections.
const privateFields = /^(?:iban|accountNumber|routing|usdcWallet|privateKey|apiKey|serviceToken|authorization|__proto__|prototype|constructor)$/i;
export function publicData(value: any): any {
  if (Array.isArray(value)) return value.map(publicData);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !privateFields.test(key)).map(([key, v]) => [key, publicData(v)]));
  return value;
}

export function validateChatRequest(body: any) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !["text", "conversationId", "conversationRevision", "policy"].includes(k)))
    throw new Error("Send only a message, conversation ID, revision and optional routing policy");
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 500) throw new Error("Use a message between 1 and 500 characters");
  if (body.conversationId != null && (typeof body.conversationId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(body.conversationId))) throw new Error("Invalid conversation ID");
  if (body.conversationRevision != null && (!Number.isSafeInteger(body.conversationRevision) || body.conversationRevision < 0)) throw new Error("Invalid conversation revision");
  if (body.policy != null && !["cheapest", "fastest", "lowest_risk"].includes(body.policy)) throw new Error("Invalid routing policy");
}
