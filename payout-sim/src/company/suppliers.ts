// Supplier records are separate from invoices and payment history. Adding a supplier never invents a payable.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { validate, type Beneficiary } from "./validate.js";
import { decimals } from "../money.js";
import type { Linked } from "../assistant/linked.js";

interface SavedSupplier { companyId: string; beneficiary: Beneficiary; createdBy: string; createdAt: string }
const FILE = "data/suppliers.json";
const saved = (): SavedSupplier[] => existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : [];
export function supplierRecords(l: Linked): Beneficiary[] {
  const records = new Map<string, Beneficiary>();
  for (const bill of l.input.payables) records.set(bill.beneficiary.id, bill.beneficiary);
  for (const row of saved().filter((s) => s.companyId === l.input.company.companyId)) records.set(row.beneficiary.id, row.beneficiary);
  return [...records.values()];
}
export function supplierDirectory(l: Linked) {
  return supplierRecords(l).map((b) => {
    const bills = l.input.payables.filter((p) => p.beneficiary.id === b.id), check = validate(b);
    const account = b.iban ?? b.accountNumber ?? b.usdcWallet;
    return { id: b.id, name: b.name, country: b.country, currencies: [...new Set([b.currency, ...bills.map((p) => p.ccy)])],
      billIds: bills.map((p) => p.id), bills: bills.map((p) => ({ id: p.id, amount: p.amount, currency: p.ccy, dueUtc: p.dueUtc })),
      check: check.status, issues: [...check.errors, ...check.warnings], acceptsUsdc: !!b.usdcWallet,
      maskedAccount: account ? `•••• ${account.replace(/\s/g, "").slice(-4)}` : "No receiving details" };
  });
}
export interface SupplierDraft { name?: string; country?: string; currency?: string }
export function addSupplier(l: Linked, draft: SupplierDraft, details: Record<string, unknown>, actor: string) {
  const name = String(draft.name ?? "").trim(), country = String(draft.country ?? "").toUpperCase(), currency = String(draft.currency ?? "").toUpperCase();
  if (!name || name.length > 120 || !/^[A-Z]{2}$/.test(country)) throw new Error("Supplier name and two-letter country are required");
  if (new Intl.DisplayNames(["en"], { type: "region" }).of(country) === country) throw new Error("Choose a recognized supplier country");
  decimals(currency);
  if (supplierRecords(l).some((b) => b.name.trim().toLowerCase() === name.toLowerCase())) throw new Error("A supplier with this name already exists; choose the existing supplier");
  const beneficiary: Beneficiary = { id: `supplier_${randomUUID()}`, name, country, currency };
  for (const key of ["iban", "swift", "accountNumber", "routing", "usdcWallet", "street", "city", "postcode"] as const) {
    const value = details[key]; if (value != null && typeof value !== "string") throw new Error(`Invalid ${key}`);
    if (value) { if (String(value).length > 100) throw new Error(`Invalid ${key}`); beneficiary[key] = String(value).trim(); }
  }
  const check = validate(beneficiary);
  if (check.status === "BLOCK") throw new Error(check.errors.join("; "));
  const all = saved(); all.push({ companyId: l.input.company.companyId, beneficiary, createdBy: actor, createdAt: new Date().toISOString() });
  mkdirSync("data", { recursive: true }); writeFileSync(`${FILE}.tmp`, JSON.stringify(all, null, 2)); renameSync(`${FILE}.tmp`, FILE);
  return { beneficiary, check };
}
