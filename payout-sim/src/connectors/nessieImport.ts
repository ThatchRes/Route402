// Seed a demo company into Nessie, and import any Nessie customer into a payment run.
// Mapping:  Nessie customer -> company | checking/savings accounts -> USD balances (available funds)
//           bills (pending) -> payables | deposits (pending/completed) -> receivables
//           local metadata (by Nessie id) -> foreign currency, amount and supplier bank details
import { nessie, loadMeta, saveMeta } from "./nessie.js";
import { mid } from "../router/optimizer.js";
import { DEMO_RUN } from "../company/demo.js";
import type { PaymentRunInput, RunPayable, RunReceivable } from "../company/paymentRun.js";
import type { CompanyProfile } from "../company/profile.js";

const TAG = "XB-DEMO";
const usdOf = (amount: string, ccy: string) => Math.round((Number(amount) / Number(mid("USD", ccy))) * 100) / 100;   // Nessie stores USD only

export async function seedDemo(fresh = false) {
  const meta = loadMeta();
  const existing = (await nessie.customers()).find((c: any) => c.last_name === `${TAG} Acme Imports` && !fresh && meta[`customer:${c._id}`]);
  if (existing) return { customerId: existing._id, created: false };
  for (const k of Object.keys(meta)) if (k.startsWith("customer:")) delete meta[k];   // the newest seeded customer becomes the linked one
  const cust = await nessie.createCustomer({ first_name: "Acme", last_name: `${TAG} Acme Imports`,
    address: { street_number: "100", street_name: "Market St", city: "Atlanta", state: "GA", zip: "30303" } });
  const ops = await nessie.createAccount(cust._id, { type: "Checking", nickname: `${TAG} Operating`, rewards: 0, balance: 3500000 });
  await nessie.createAccount(cust._id, { type: "Savings", nickname: `${TAG} Reserve`, rewards: 0, balance: 1200000 });
  for (const p of DEMO_RUN.payables) {
    // Nessie accepts recurring_date on create but rejects upcoming_payment_date (it sets that itself);
    // if its bill listing still fails, the import falls back to our local mapping.
    const b = await nessie.createBill(ops._id, { status: "pending", payee: p.beneficiary.name, nickname: `${TAG} ${p.id}`,
      payment_date: p.dueUtc.slice(0, 10), recurring_date: Number(p.dueUtc.slice(8, 10)), payment_amount: usdOf(p.amount, p.ccy) });
    meta[b._id] = { kind: "payable", accountId: ops._id, id: p.id, ccy: p.ccy, amount: p.amount, beneficiary: p.beneficiary, discountPct: p.discountPct, discountByUtc: p.discountByUtc, dueUtc: p.dueUtc };
  }
  for (const r of DEMO_RUN.receivables) {
    const d = await nessie.createDeposit(ops._id, { medium: "balance", transaction_date: r.dateUtc.slice(0, 10), status: r.status === "confirmed" ? "pending" : "pending",
      amount: usdOf(r.amount, r.ccy), description: `${TAG} ${r.id}` });
    meta[d._id] = { kind: "receivable", accountId: ops._id, id: r.id, ccy: r.ccy, amount: r.amount, dateUtc: r.dateUtc, status: r.status };
  }
  meta[`customer:${cust._id}`] = { operatingAccountId: ops._id };
  saveMeta(meta);
  return { customerId: cust._id, created: true };
}

export async function importFromNessie(customerId: string, company: CompanyProfile, nowUtc: string) {
  const meta = loadMeta(), accounts = await nessie.accounts(customerId), opAcct = meta[`customer:${customerId}`]?.operatingAccountId;
  const ownedBy = (m: any, acctId: string) => m.accountId === acctId || (!m.accountId && opAcct === acctId);   // older seeds lack accountId
  const payables: RunPayable[] = [], receivables: RunReceivable[] = [], unmapped: string[] = [];
  let usdBalance = 0;
  for (const a of accounts) {
    if (a.type !== "Credit Card") usdBalance += Number(a.balance ?? 0);
    // If Nessie can't return this account's bills/deposits (schema validation on its side), fall back to our local mapping.
    let bills: any[], deps: any[];
    try { bills = await nessie.bills(a._id); }
    catch (e: any) { unmapped.push(`Nessie could not list bills for ${a._id} (${String(e.message).slice(0, 80)}): used local mapping`);
      bills = Object.entries(meta).filter(([, m]: any) => m.kind === "payable" && ownedBy(m, a._id)).map(([id]) => ({ _id: id, status: "pending" })); }
    try { deps = await nessie.deposits(a._id); }
    catch (e: any) { unmapped.push(`Nessie could not list deposits for ${a._id}: used local mapping`);
      deps = Object.entries(meta).filter(([, m]: any) => m.kind === "receivable" && ownedBy(m, a._id)).map(([id]) => ({ _id: id })); }
    for (const b of bills) {
      if (b.status !== "pending" && b.status !== "recurring") continue;
      const m = meta[b._id];
      if (m) payables.push({ id: m.id, ccy: m.ccy, amount: m.amount, dueUtc: m.dueUtc, beneficiary: m.beneficiary,
                             discountPct: m.discountPct, discountByUtc: m.discountByUtc, ...({ nessieBillId: b._id, nessieAccountId: a._id } as any) });
      else { // plain Nessie bill with no foreign details: a domestic USD payment
        payables.push({ id: b.nickname || b._id, ccy: "USD", amount: Number(b.payment_amount).toFixed(2), dueUtc: new Date(`${b.payment_date ?? b.upcoming_payment_date}T20:00:00Z`).toISOString(),
                        beneficiary: { id: b.payee, name: b.payee, country: "US", currency: "USD" } });
        unmapped.push(`${b._id} (${b.payee}): no foreign metadata, treated as a domestic USD bill`);
      }
    }
    for (const d of deps) {
      const m = meta[d._id];
      if (m) receivables.push({ id: m.id, ccy: m.ccy, amount: m.amount, dateUtc: m.dateUtc, status: m.status });
    }
  }
  const input: PaymentRunInput = { company: { ...company }, nowUtc, payables, receivables };
  return { input, source: "nessie", customerId, usdAvailable: usdBalance.toFixed(2), imported: { accounts: accounts.length, payables: payables.length, receivables: receivables.length }, unmapped };
}

/** After a converted payment executes, record the USD debit back in Nessie (sandbox write; no real money). */
export async function writeBack(accountId: string, usdAmount: string, transferId: string) {
  return nessie.createWithdrawal(accountId, { medium: "balance", transaction_date: new Date().toISOString().slice(0, 10), status: "pending",
    amount: Number(usdAmount), description: `XB-DEMO payment ${transferId}` });
}
