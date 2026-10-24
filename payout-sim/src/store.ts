import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import type { Entry } from "./ledger.js";

export type PayoutStatus =
  | "HOLD_QUOTE_EXPIRED" | "FUNDING_NOT_CONFIRMED" | "FUNDED" | "PAYOUT_REQUESTED" | "PAYOUT_UNKNOWN"
  | "PAYOUT_ACCEPTED" | "CONVERTED" | "PARTIALLY_CREDITED" | "DELIVERED" | "PAYOUT_REJECTED";

export interface Payout {
  payoutId: string; transferId: string; opRef: string; requestHash: string; scenario: string;
  quote: any; funding: any; status: PayoutStatus; lateSuccess?: boolean;
  lastSequence: number; creditedMinor: string; createdAt: string; history: { at: string; status: string; note?: string }[];
}

export interface ProviderEvent {
  eventId: string; opRef: string; sequence: number; type: string; occurredAt: string; observedAt: string;
  amount?: string; currency?: string; providerRef: string; provenance: "simulated"; applied: boolean; note?: string;
}

interface Db { payouts: Record<string, Payout>; byOpRef: Record<string, string>; events: ProviderEvent[]; entries: Entry[];
  provider: Record<string, { opRef: string; providerRef: string; plan: any[]; createdAt: string }> }

const FILE = "data/store.json";
export function load(): Db {
  if (!existsSync(FILE)) return { payouts: {}, byOpRef: {}, events: [], entries: [], provider: {} };
  return JSON.parse(readFileSync(FILE, "utf8"));
}
export function save(db: Db) {
  mkdirSync("data", { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  for (let i = 0; ; i++) {
    try { renameSync(tmp, FILE); return; }
    catch (e: any) { if (!["EPERM", "EBUSY", "EACCES"].includes(e?.code) || i >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
}
export function update<T>(fn: (db: Db) => T): T { const db = load(); const out = fn(db); save(db); return out; }
