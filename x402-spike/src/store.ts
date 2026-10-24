// Tiny durable JSON store (spike only; Person A ports this to PostgreSQL tables).
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

export function save(db: Db) {
  mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  // Windows can briefly lock the target while another process reads it: retry instead of failing.
  for (let i = 0; ; i++) {
    try { renameSync(tmp, FILE); return; }
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
