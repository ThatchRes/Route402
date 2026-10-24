// Payment controls for the company workspace: who may prepare, approve and release a payment, and a tamper-evident log.
// These follow published treasury fraud-prevention practice (dual authorization, per-user limits, segregation of duties,
// call-back verification on a known number before acting on changed bank details, MFA). The thresholds below are COMPANY
// SETTINGS the admin can change, not market data.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ConditionSpec } from "./conditions.js";

export type Role = "preparer" | "approver" | "receiving" | "admin";
export interface User { id: string; name: string; title: string; roles: Role[]; approvalLimitUsd: number | null }

// Demo users. In production these come from the company's identity provider (SSO), not this file.
export const USERS: User[] = [
  { id: "maya", name: "Maya Chen", title: "AP specialist", roles: ["preparer"], approvalLimitUsd: null },
  { id: "jordan", name: "Jordan Ellis", title: "Treasury manager", roles: ["approver"], approvalLimitUsd: 250_000 },
  { id: "priya", name: "Priya Raman", title: "CFO", roles: ["approver", "admin"], approvalLimitUsd: null },   // null = no limit (for approvers)
  { id: "sam", name: "Sam Ortiz", title: "Receiving / logistics", roles: ["receiving"], approvalLimitUsd: null },
];
export const user = (id?: string) => USERS.find((u) => u.id === id);
export const can = (u: User | undefined, r: Role) => !!u && (u.roles.includes(r) || u.roles.includes("admin"));

export interface Policy { dualApprovalOverUsd: number; requireCallbackOnDetailsChange: boolean; requoteTolerancePct: number; quoteValidMinutes: number;
  depegBandPct: number;          // pause the USDC route if its live price is further than this from 1.00 USD
  depegFailClosed: boolean;      // pause it too when no live price can be read
  issuerCapUsd: number;          // most that may be in flight or in escrow with one stablecoin issuer at once
  escrowDeadlineDays: number;    // days after approval before an unreleased escrow can be refunded
  fxRiskLimitUsd: number }       // flag a currency when its 95% one-sided FX move on open bills exceeds this
const POLICY_FILE = "data/policy.json";
// Defaults are starting company settings, editable by the admin; none of them is market data.
const DEFAULT_POLICY: Policy = { dualApprovalOverUsd: 100_000, requireCallbackOnDetailsChange: true, requoteTolerancePct: 0.5, quoteValidMinutes: 14,
  depegBandPct: 0.5, depegFailClosed: true, issuerCapUsd: 250_000, escrowDeadlineDays: 30, fxRiskLimitUsd: 25_000 };
export const loadPolicy = (): Policy => ({ ...DEFAULT_POLICY, ...(existsSync(POLICY_FILE) ? JSON.parse(readFileSync(POLICY_FILE, "utf8")) : {}) });
export const savePolicy = (p: Policy) => write(POLICY_FILE, p);

function write(file: string, v: unknown) { mkdirSync("data", { recursive: true }); writeFileSync(file, JSON.stringify(v, null, 2)); }
const read = <T>(file: string, d: T): T => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : d);

// ------------------------------------------------------------------ tamper-evident audit log (hash chain)
// Each entry stores the hash of the previous one; editing or deleting any past entry breaks every hash after it.
export interface AuditEntry { seq: number; at: string; actor: string; action: string; ref: string; detail: string; prev: string; hash: string }
const AUDIT = "data/audit.json";
const digest = (e: Omit<AuditEntry, "hash">) => createHash("sha256").update(JSON.stringify([e.seq, e.at, e.actor, e.action, e.ref, e.detail, e.prev])).digest("hex");
export const loadAudit = (): AuditEntry[] => read(AUDIT, []);
export function audit(actor: string, action: string, ref: string, detail = ""): AuditEntry {
  const log = loadAudit(), prev = log.at(-1)?.hash ?? "genesis";
  const base = { seq: log.length + 1, at: new Date().toISOString(), actor, action, ref, detail: detail.slice(0, 400), prev };
  const e = { ...base, hash: digest(base) }; log.push(e); write(AUDIT, log); return e;
}
export function verifyAudit(): { ok: boolean; entries: number; brokenAt?: number } {
  const log = loadAudit(); let prev = "genesis";
  for (const e of log) { const { hash, ...base } = e; if (e.prev !== prev || digest(base) !== hash) return { ok: false, entries: log.length, brokenAt: e.seq }; prev = hash; }
  return { ok: true, entries: log.length };
}

// ------------------------------------------------------------------ sessions with a second factor (demo)
// Sign-in = choose a user + enter a one-time code. In the demo the code is shown on screen ("sent to your device");
// in production this is SSO with a hardware key or authenticator app.
const pendingCodes = new Map<string, { code: string; exp: number }>();
const sessions = new Map<string, { userId: string; exp: number }>();
export function issueCode(userId: string) { const code = String(randomInt(0, 1_000_000)).padStart(6, "0"); pendingCodes.set(userId, { code, exp: Date.now() + 5 * 60e3 }); return code; }
export function signIn(userId: string, code: string): string | null {
  const p = pendingCodes.get(userId); if (!p || p.exp < Date.now() || p.code !== String(code).trim()) return null;
  pendingCodes.delete(userId); const token = randomBytes(24).toString("hex"); sessions.set(token, { userId, exp: Date.now() + 8 * 3600e3 }); return token;
}
export function sessionUser(cookie?: string): User | undefined {
  const token = /(?:^|;\s*)r402=([a-f0-9]+)/.exec(cookie ?? "")?.[1]; const s = token ? sessions.get(token) : undefined;
  return s && s.exp > Date.now() ? user(s.userId) : undefined;
}
export function signOut(cookie?: string) { const t = /(?:^|;\s*)r402=([a-f0-9]+)/.exec(cookie ?? "")?.[1]; if (t) sessions.delete(t); }

// ------------------------------------------------------------------ payment requests (prepare -> verify -> approve -> release)
export type ReqStatus = "NEEDS_CALLBACK" | "AWAITING_APPROVAL" | "AWAITING_DELIVERY" | "READY" | "PAUSED" | "EXECUTING" | "COMPLETED" | "FAILED" | "REJECTED" | "REFUNDED";
export interface PaymentRequest {
  id: string; payable: string; supplier: string; country: string; ccy: string; amount: string; reference: string;
  intentId: string; provider: string; route: string; debitUsd: number; recipientGets: string; arrivalUtc: string; agentReasons: string[];
  preparedBy: string; preparedAt: string; detailsChanged: boolean; detailsNote?: string;
  callback?: { by: string; at: string; phoneOnFile: string; contact: string; outcome: "confirmed" };
  approvals: { by: string; at: string }[]; rejected?: { by: string; at: string; why: string };
  releaseOnDelivery: boolean; delivery?: { by: string; at: string; documentRef: string };
  condition?: ConditionSpec;           // portable release condition (enforced by Route402 today, by a tokenized ledger later)
  msgId?: string;                      // ISO 20022 message id for this payment's pain.001
  purpose?: string; mode?: "invoice" | "budget"; checkedBy?: { userId: string; at: string };   // preparer's deliberate confirmation
  allowReroute?: boolean; fallbackIntentIds?: string[]; timing?: any; deadlineStatus?: string; costReview?: boolean;
  status: ReqStatus; note?: string; transferId?: string; proof?: string;
  escrow?: { chain: string; contract: string; lockId: string; amountUsdc: number; deadline: string; state: "LOCKING" | "LOCKED" | "RELEASED" | "REFUNDED" | "FAILED";
    lockTx?: string; releaseTx?: string; refundTx?: string; explorer?: string | null; error?: string };
}
const REQS = "data/requests.json";
export const loadRequests = (): Record<string, PaymentRequest> => read(REQS, {});
export const saveRequests = (m: Record<string, PaymentRequest>) => write(REQS, m);
export const newRequestId = () => `pr_${randomBytes(4).toString("hex")}`;

export const approvalsRequired = (r: PaymentRequest, p: Policy) => (r.debitUsd > p.dualApprovalOverUsd ? 2 : 1);

/** Where a request stands, given the policy. Terminal states are kept. */
export function computeStatus(r: PaymentRequest, p: Policy): ReqStatus {
  if (["PAUSED", "EXECUTING", "COMPLETED", "FAILED", "REJECTED", "REFUNDED"].includes(r.status)) return r.status;
  if (r.detailsChanged && p.requireCallbackOnDetailsChange && !r.callback) return "NEEDS_CALLBACK";
  if (r.approvals.length < approvalsRequired(r, p)) return "AWAITING_APPROVAL";
  if (r.releaseOnDelivery && !r.delivery) return "AWAITING_DELIVERY";
  return "READY";
}

/** What the signed-in user is allowed to do next on this request, and why not otherwise. */
export function nextActions(r: PaymentRequest, u: User | undefined, p: Policy) {
  const st = computeStatus(r, p), out: Record<string, { allowed: boolean; why?: string }> = {};
  const no = (why: string) => ({ allowed: false, why });
  if (!u) return { status: st, actions: { approve: no("sign in first") } };
  out.callback = st !== "NEEDS_CALLBACK" ? no("no call-back needed") : u.id === r.preparedBy ? no("the preparer cannot verify their own request")
    : can(u, "approver") ? { allowed: true } : no("only an approver or admin can record a call-back");
  out.approve = st !== "AWAITING_APPROVAL" ? no(st === "NEEDS_CALLBACK" ? "verify the bank-detail change by call-back first" : "not awaiting approval")
    : !can(u, "approver") ? no("your role cannot approve payments")
    : u.id === r.preparedBy ? no("segregation of duties: the preparer cannot approve")
    : r.approvals.some((a) => a.by === u.id) ? no("you already approved; a second, different approver is required")
    : u.approvalLimitUsd != null && r.debitUsd > u.approvalLimitUsd ? no(`above your approval limit (${u.approvalLimitUsd.toLocaleString()} USD)`)
    : { allowed: true };
  out.reject = ["NEEDS_CALLBACK", "AWAITING_APPROVAL", "AWAITING_DELIVERY"].includes(st) && can(u, "approver") ? { allowed: true } : no("cannot reject now");
  out.confirmDelivery = st !== "AWAITING_DELIVERY" ? no("not waiting for delivery")
    : u.id === r.preparedBy ? no("the preparer cannot confirm delivery") : can(u, "receiving") || can(u, "approver") ? { allowed: true } : no("receiving, approver or admin only");
  out.recheck = st === "PAUSED" && can(u, "approver") ? { allowed: true } : no("not paused");
  out.refund = r.escrow?.state === "LOCKED" && can(u, "approver") ? (Date.now() >= Date.parse(r.escrow.deadline) ? { allowed: true } : no(`refund opens at the escrow deadline (${r.escrow.deadline.slice(0, 10)})`)) : no("no locked escrow");
  return { status: st, actions: out };
}
