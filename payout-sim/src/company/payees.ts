// Payee history: the bank details each supplier was last paid to. A change since the last payment is the classic
// vendor-impersonation pattern (AFP 2025: 45% of organizations saw vendor impersonation; BEC targets wires most),
// so a changed account is held for a call-back on a number already on file, never one from the change request.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Beneficiary } from "./validate.js";

const FILE = "data/payees.json";
export interface PayeeRecord { fingerprint: string; display: string; lastPaidAt: string; transferId?: string }
const key = (b: Beneficiary) => b.name.trim().toLowerCase();

export function fingerprint(b: Beneficiary): { fp: string; display: string } {
  const n = (x?: string) => (x ?? "").replace(/[\s-]/g, "").toUpperCase();
  const parts = [n(b.iban), n(b.accountNumber), n(b.routing), n(b.swift), n(b.usdcWallet)];
  const shown = b.iban ? `IBAN ...${n(b.iban).slice(-4)}` : b.usdcWallet ? `USDC wallet ...${n(b.usdcWallet).slice(-4)}` : b.accountNumber ? `account ...${n(b.accountNumber).slice(-4)}` : "no account";
  return { fp: parts.join("|"), display: shown };
}

// Demo history: one supplier was last paid to different details (shows the hold in the demo). Real history is written on payment.
const DEMO_HISTORY: Record<string, PayeeRecord> = {
  "northwind ltd": { fingerprint: "GB33BUKB20201555555555||||", display: "IBAN ...5555", lastPaidAt: "2026-09-30T15:00:00Z" },
};

export function loadPayees(): Record<string, PayeeRecord> {
  const saved = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
  return { ...DEMO_HISTORY, ...saved };
}

export function recordPayment(b: Beneficiary, transferId: string) {
  const saved = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
  const { fp, display } = fingerprint(b);
  saved[key(b)] = { fingerprint: fp, display, lastPaidAt: new Date().toISOString(), transferId };
  mkdirSync("data", { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(saved, null, 2)); renameSync(tmp, FILE);
}

/** null = never paid before or unchanged; otherwise a description of the change */
export function detailsChanged(b: Beneficiary): string | null {
  const prev = loadPayees()[key(b)];
  if (!prev) return null;
  const { fp, display } = fingerprint(b);
  return prev.fingerprint === fp ? null
    : `bank details changed since the last payment (${prev.lastPaidAt.slice(0, 10)}: ${prev.display} -> now ${display}). Confirm by calling the supplier on a number already on file, not one from the change request`;
}
