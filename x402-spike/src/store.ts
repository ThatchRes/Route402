// Tiny durable JSON store (prototype only; production would use PostgreSQL).
// Writes go to a temp file and are renamed, so a crash never leaves a half-written file.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";

export type OrderStatus =
  | "AWAITING_FUNDING" | "SETTLED_PENDING_CONFIRMATION" | "FUNDING_CONFIRMED"
  | "FUNDING_FAILED" | "SETTLEMENT_UNKNOWN" | "EXPIRED";

export interface Order {
  orderId: string; transferId: string; planVersion: number; termsHash: string;
  network: string; asset: string; payTo: string; amountAtomic: string;
  status: OrderStatus; expiresAt: string; createdAt: string;
  settlement?: { transaction?: string; payer?: string; network?: string; recordedAt: string };
  confirmations?: string; failureReason?: string; provenance: "testnet";
}

export type AttemptStatus = "SUBMITTED" | "SETTLED" | "REJECTED" | "UNKNOWN" | "RECONCILED_SETTLED" | "RECONCILED_NOT_SETTLED";

export interface Attempt {
  attemptId: string; orderId: string; payer: string; amountAtomic: string;
  status: AttemptStatus; startedAt: string; startBlock?: string; transaction?: string; detail?: string;
}

interface Db { orders: Record<string, Order>; attempts: Attempt[]; txIndex: Record<string, string> }

const DIR = "data";
const FILE = `${DIR}/store.json`;

export function load(): Db {
  if (!existsSync(FILE)) return { orders: {}, attempts: [], txIndex: {} };
  return JSON.parse(readFileSync(FILE, "utf8"));
}

export function save(db: Db) { saveFile(FILE, db); }

/** Atomic JSON write (temp file + rename). Each file has exactly ONE writer process, so updates are never lost. */
export function saveFile(file: string, value: unknown) {
  mkdirSync(DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  // Windows can briefly lock the target while another process reads it: retry instead of failing.
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; }
    catch (e: any) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(e?.code) || i >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

export function update<T>(fn: (db: Db) => T): T {
  const db = load();
  const out = fn(db);
  save(db);
  return out;
}

// ---- Paid API calls (pay-per-request). Buyer side: data/calls-wallet.json (agent wallet). Seller side: data/calls-seller.json.
export type CallStatus = "SUBMITTED" | "SETTLED" | "REJECTED" | "UNKNOWN";
export interface CallRecord {
  callId: string; service: string; amountAtomic: string; status: CallStatus; at: string;
  transaction?: string; payer?: string; payTo?: string; correlationId?: string; caller?: string; detail?: string; request?: string;
}
export const WALLET_CALLS = `${DIR}/calls-wallet.json`;
export const SELLER_CALLS = `${DIR}/calls-seller.json`;
export const PROVIDER_CALLS = `${DIR}/calls-providers.json`;     // written only by `npm run providers`
export function loadCalls(file: string): CallRecord[] {
  for (let i = 0; ; i++) {
    try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []; }
    catch (e: any) { if (i >= 20) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }   // file mid-rename on Windows
  }
}
export function updateCalls<T>(file: string, fn: (calls: CallRecord[]) => T): T { const c = loadCalls(file); const out = fn(c); saveFile(file, c); return out; }
