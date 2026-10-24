// CSV import: how a company ports in data exported from its accounting system (QuickBooks, Xero, NetSuite...).
// One row per payable (bill to pay) or receivable (money coming in). Header names are case-insensitive.
//   type,id,counterparty,country,currency,amount,due_date,iban,account,swift,routing,discount_pct,discount_by,status
import type { PaymentRunInput, RunPayable, RunReceivable } from "../company/paymentRun.js";
import type { CompanyProfile } from "../company/profile.js";

function parseLine(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur); return out.map((x) => x.trim());
}
const iso = (d: string) => (d ? new Date(/T/.test(d) ? d : `${d}T20:00:00Z`).toISOString() : "");

export function importCsv(text: string, company: CompanyProfile, nowUtc: string) {
  const rows = text.replace(/\r/g, "").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  const head = parseLine(rows[0]).map((h) => h.toLowerCase());
  const col = (r: string[], n: string) => r[head.indexOf(n)] ?? "";
  const payables: RunPayable[] = [], receivables: RunReceivable[] = [], problems: string[] = [];
  rows.slice(1).forEach((line, i) => {
    const r = parseLine(line), type = col(r, "type").toLowerCase(), amount = col(r, "amount").replace(/,/g, "");
    const ccy = col(r, "currency").toUpperCase(), id = col(r, "id") || `row${i + 2}`;
    if (!/^\d+(\.\d+)?$/.test(amount) || !/^[A-Z]{3}$/.test(ccy)) { problems.push(`row ${i + 2}: bad amount or currency`); return; }
    if (type === "payable") payables.push({ id, ccy, amount, dueUtc: iso(col(r, "due_date")),
      beneficiary: { id: col(r, "counterparty"), name: col(r, "counterparty"), country: col(r, "country").toUpperCase(), currency: ccy,
        iban: col(r, "iban") || undefined, accountNumber: col(r, "account") || undefined, swift: col(r, "swift") || undefined, routing: col(r, "routing") || undefined },
      discountPct: col(r, "discount_pct") ? Number(col(r, "discount_pct")) : undefined, discountByUtc: col(r, "discount_by") ? iso(col(r, "discount_by")) : undefined });
    else if (type === "receivable") receivables.push({ id, ccy, amount, dateUtc: iso(col(r, "due_date")),
      status: col(r, "status").toLowerCase() === "expected" ? "expected" : "confirmed" });
    else problems.push(`row ${i + 2}: type must be payable or receivable`);
  });
  const input: PaymentRunInput = { company, nowUtc, payables, receivables };
  return { input, imported: { payables: payables.length, receivables: receivables.length }, problems };
}
