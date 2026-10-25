// Reviewer inputs and approvals for accounting records, one row per payment request (data/accounting.json).
// Records themselves are recomputed from payment data; an approved record is frozen as the snapshot taken at approval.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AccountingRecord, ReviewInputs } from "./accounting.js";

const FILE = "data/accounting.json";
interface Row { review?: ReviewInputs; approval?: { by: string; at: string; hash: string; snapshot: AccountingRecord } }
const all = (): Record<string, Row> => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});
const save = (m: Record<string, Row>) => { mkdirSync("data", { recursive: true }); writeFileSync(`${FILE}.tmp`, JSON.stringify(m, null, 2)); renameSync(`${FILE}.tmp`, FILE); };
export const accountingRow = (requestId: string): Row => all()[requestId] ?? {};
export const accountingRows = () => all();

export function saveReview(requestId: string, body: any, by: string): ReviewInputs {
  const m = all(), row = m[requestId] ?? {};
  if (row.approval) throw new Error("This entry is approved; its inputs can no longer change");
  const text = (v: any, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
  const carrying = text(body?.carryingAmount, 24);
  if (carrying && !/^\d+(\.\d{1,2})?$/.test(carrying)) throw new Error("Enter the carrying amount as a positive number with up to 2 decimals");
  row.review = { invoiceRef: text(body?.invoiceRef, 60), carryingAmount: carrying, carryingSource: text(body?.carryingSource, 80), by, at: new Date().toISOString() };
  m[requestId] = row; save(m); return row.review;
}
/** Approve once: a second approval of the same record is refused, so no duplicate entry can be created. */
export function approveRecord(rec: AccountingRecord, by: string): Row["approval"] {
  const m = all(), row = m[rec.requestId] ?? {};
  if (row.approval) throw new Error(`Already approved by ${row.approval.by}`);
  if (rec.journal.status !== "draft" || !rec.journal.balanced) throw new Error("Only a balanced entry with nothing missing can be approved");
  const at = new Date().toISOString();
  const snapshot: AccountingRecord = { ...rec, journal: { ...rec.journal, status: "approved" } };
  const hash = createHash("sha256").update(JSON.stringify({ lines: rec.journal.lines, totals: rec.journal.totals, requestId: rec.requestId })).digest("hex");
  row.approval = { by, at, hash, snapshot: { ...snapshot, approval: { by, at, hash } } }; m[rec.requestId] = row; save(m); return row.approval;
}
