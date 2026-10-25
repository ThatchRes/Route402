// ASI:One authorization state only. This module never approves or sends a payment.
// A signed transport sender is not a company user: the browser must link an existing
// authenticated session, and callers must validate that session on every chat action.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const FILE = "data/asi-chat.json";
const LINK_MS = 5 * 60e3, AUTHORITY_MS = 12 * 3600e3, MAX_ROWS = 2000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const scopeKey = (tenant: string, sender: string, session: string, companyId: string) =>
  digest(JSON.stringify([tenant, sender, session, companyId]));
const unavailable = () => new Error("Chat authorization is unavailable. Reconnect through the company app.");
const unlinked = () => new Error("Connect this chat to your company account before confirming a payment.");

export interface AsiBinding {
  id: string; tenant: string; sender: string; session: string; companyId: string;
  userId: string; sessionHash: string; createdAt: number; expiresAt: number;
}
export interface AsiPlan {
  intentId: string; payable: string; termsHash: string; expiresAt: number;
}
export interface AsiPending {
  id: string; state: "ready" | "processing" | "done" | "cancelled" | "unknown";
  conversationId: string; conversationRevision: number; plans: AsiPlan[];
  details: any[]; expiresAt: number; result?: any; requestIds?: string[];
  [field: string]: unknown;
}
interface LinkChallenge {
  tenant: string; sender: string; session: string; companyId: string; expiresAt: number;
}
interface SavedPending { authorityId: string; value: AsiPending }
interface State {
  version: 1; challenges: Record<string, LinkChallenge>;
  bindings: Record<string, AsiBinding>; pending: Record<string, SavedPending>;
}
const blank = (): State => ({ version: 1, challenges: {}, bindings: {}, pending: {} });
const object = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function read(): State {
  if (!existsSync(FILE)) return blank();
  try {
    const s = JSON.parse(readFileSync(FILE, "utf8"));
    if (s.version !== 1 || !object(s.challenges) || !object(s.bindings) || !object(s.pending)) throw unavailable();
    return s;
  } catch { throw unavailable(); }
}
function clean(s: State) {
  const now = Date.now();
  s.challenges = Object.fromEntries(Object.entries(s.challenges)
    .filter(([, row]) => row.expiresAt > now).slice(-MAX_ROWS));
  s.bindings = Object.fromEntries(Object.entries(s.bindings)
    .filter(([, row]) => row.expiresAt > now).slice(-MAX_ROWS));
  s.pending = Object.fromEntries(Object.entries(s.pending).filter(([key, row]) =>
    s.bindings[key]?.id === row.authorityId).slice(-MAX_ROWS));
}
function write(s: State) {
  clean(s);
  try {
    mkdirSync("data", { recursive: true });
    const temporary = `${FILE}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(s), { mode: 0o600 });
    renameSync(temporary, FILE);
  } catch { throw unavailable(); }
}
function text(value: string, limit = 256) {
  if (typeof value !== "string" || !value || value.length > limit || /[\u0000-\u001f]/.test(value))
    throw new Error("Invalid chat authorization context.");
}
function context(tenant: string, sender: string, session: string, companyId: string) {
  [tenant, sender, session, companyId].forEach((v) => text(v));
}
function current(s: State, binding: AsiBinding): { key: string; value: AsiBinding } {
  const key = scopeKey(binding.tenant, binding.sender, binding.session, binding.companyId), value = s.bindings[key];
  if (!value || value.id !== binding.id || value.userId !== binding.userId || value.sessionHash !== binding.sessionHash || value.expiresAt <= Date.now()) throw unlinked();
  return { key, value };
}

/** Only the random challenge is returned. Its hash, never its plaintext, is persisted. */
export function beginLink(tenant: string, sender: string, session: string, companyId: string) {
  context(tenant, sender, session, companyId);
  const s = read(), token = randomBytes(32).toString("hex"), expiresAt = Date.now() + LINK_MS;
  // A replacement challenge for the same conversation supersedes earlier unconsumed links.
  for (const [key, row] of Object.entries(s.challenges))
    if (scopeKey(row.tenant, row.sender, row.session, row.companyId) === scopeKey(tenant, sender, session, companyId)) delete s.challenges[key];
  s.challenges[digest(token)] = { tenant, sender, session, companyId, expiresAt }; write(s);
  return { token, expiresAt };
}

/** Call only after the browser has authenticated the user and explicitly accepted linking. */
export function describeLink(token: string, companyId: string) {
  const challenge = typeof token === "string" && /^[a-f0-9]{64}$/.test(token) ? read().challenges[digest(token)] : undefined;
  if (!challenge || challenge.expiresAt <= Date.now() || challenge.companyId !== companyId)
    throw new Error("This connection link is invalid or expired. Request a new link in chat.");
  return { sender: challenge.sender, session: challenge.session, expiresAt: challenge.expiresAt };
}

/** Call only after the browser has authenticated the user and explicitly accepted linking. */
export function completeLink(token: string, userId: string, sessionHash: string, companyId: string): AsiBinding {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new Error("This connection link is invalid or expired. Request a new link in chat.");
  text(userId); text(companyId);
  if (!/^[a-f0-9]{64}$/.test(sessionHash)) throw new Error("Sign in to the company app before connecting this chat.");
  const s = read(), tokenKey = digest(token), challenge = s.challenges[tokenKey];
  if (!challenge || challenge.expiresAt <= Date.now() || challenge.companyId !== companyId)
    throw new Error("This connection link is invalid or expired. Request a new link in chat.");
  delete s.challenges[tokenKey];
  const key = scopeKey(challenge.tenant, challenge.sender, challenge.session, challenge.companyId);
  const binding: AsiBinding = { ...challenge, id: randomUUID(), userId, sessionHash, createdAt: Date.now(), expiresAt: Date.now() + AUTHORITY_MS };
  s.bindings[key] = binding; delete s.pending[key]; write(s);
  return clone(binding);
}

// Server-configured chat authority (no browser sign-in). Never derived from chat text or the gateway's request body.
const AGENT_AUTHORITY = "asi-agent:";
export const isAgentAuthority = (sessionHash: string) => typeof sessionHash === "string" && sessionHash.startsWith(AGENT_AUTHORITY);

/** Bind this signed sender + session to the company user the router is configured to act as for ASI:One. */
export function autoLink(tenant: string, sender: string, session: string, companyId: string, userId: string): AsiBinding {
  context(tenant, sender, session, companyId); text(userId);
  const s = read(), key = scopeKey(tenant, sender, session, companyId), existing = s.bindings[key];
  if (existing && existing.expiresAt > Date.now() && existing.userId === userId && isAgentAuthority(existing.sessionHash)) return clone(existing);
  const binding: AsiBinding = { tenant, sender, session, companyId, id: randomUUID(), userId,
    sessionHash: AGENT_AUTHORITY + digest(JSON.stringify([tenant, sender, session, companyId, userId])), createdAt: Date.now(), expiresAt: Date.now() + AUTHORITY_MS };
  s.bindings[key] = binding; delete s.pending[key]; write(s);
  return clone(binding);
}

export function requireBinding(tenant: string, sender: string, session: string, companyId: string,
  sessionValidFn: (sessionHash: string, userId: string) => boolean): AsiBinding {
  context(tenant, sender, session, companyId);
  const s = read(), key = scopeKey(tenant, sender, session, companyId), binding = s.bindings[key];
  let valid = false;
  if (binding && binding.expiresAt > Date.now()) {
    try { valid = sessionValidFn(binding.sessionHash, binding.userId) === true; } catch { valid = false; }
  }
  if (!valid) {
    if (binding) { delete s.bindings[key]; delete s.pending[key]; write(s); }
    throw unlinked();
  }
  return clone(binding);
}

export function revokeBinding(tenant: string, sender: string, session: string, companyId: string) {
  context(tenant, sender, session, companyId);
  const s = read(), key = scopeKey(tenant, sender, session, companyId);
  delete s.bindings[key]; delete s.pending[key];
  for (const [token, challenge] of Object.entries(s.challenges))
    if (scopeKey(challenge.tenant, challenge.sender, challenge.session, challenge.companyId) === key) delete s.challenges[token];
  write(s);
}

function validatePending(pending: AsiPending) {
  text(pending.id); text(pending.conversationId);
  if (!["ready", "processing", "done", "cancelled", "unknown"].includes(pending.state)
    || !Number.isInteger(pending.conversationRevision) || pending.conversationRevision < 0
    || !Number.isFinite(pending.expiresAt) || !Array.isArray(pending.plans) || pending.plans.length > 25 || !Array.isArray(pending.details))
    throw new Error("Invalid chat confirmation state.");
  for (const plan of pending.plans) {
    text(plan.intentId); text(plan.payable); text(plan.termsHash);
    if (!Number.isFinite(plan.expiresAt)) throw new Error("Invalid chat confirmation state.");
  }
  // Bound disk use even if upstream result data accidentally contains an entire transcript.
  if (JSON.stringify(pending).length > 200_000) throw new Error("Chat confirmation is too large. Review a smaller payment run.");
}
export function setPending(binding: AsiBinding, pending: AsiPending): AsiPending {
  validatePending(pending);
  const s = read(), { key } = current(s, binding);
  s.pending[key] = { authorityId: binding.id, value: clone(pending) }; write(s); return clone(pending);
}
export function getPending(binding: AsiBinding): AsiPending | undefined {
  const s = read(), { key } = current(s, binding), saved = s.pending[key];
  return saved?.authorityId === binding.id ? clone(saved.value) : undefined;
}
/** A synchronous read/modify/write; callers move ready -> processing before awaiting any effect. */
export function updatePending(binding: AsiBinding, patch: Partial<AsiPending>): AsiPending {
  const s = read(), { key } = current(s, binding), saved = s.pending[key];
  if (!saved || saved.authorityId !== binding.id) throw new Error("There is no current payment confirmation in this chat.");
  if (patch.id !== undefined && patch.id !== saved.value.id) throw new Error("The payment confirmation changed. Review the latest plan.");
  const value = { ...saved.value, ...patch }; validatePending(value);
  saved.value = clone(value); write(s); return clone(value);
}
export function clearPending(binding: AsiBinding) {
  const s = read(), { key } = current(s, binding); delete s.pending[key]; write(s);
}

/** Matches controls.ts tokenHash without persisting or returning the browser's session token. */
export function sessionFingerprint(cookie?: string): string | undefined {
  const token = /(?:^|;\s*)r402=([a-f0-9]+)(?:;|$)/.exec(cookie ?? "")?.[1];
  return token && token.length <= 256 ? digest(token) : undefined;
}
