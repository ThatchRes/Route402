// Payment accounting: journal balance, missing data, conversion conventions, variance, duplicates, lifecycle,
// aggregates and CSV. Synthetic ledgers mirror the payout service's postings (src/server.ts). Isolated temp directory.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
process.chdir(mkdtempSync(path.join(tmpdir(), "route402-accounting-")));
const A = await import("./company/accounting.js");
const S = await import("./company/accountingStore.js");
const { quoteFor } = await import("./scenarios.js");
let n = 0; const pass = (m: string) => console.log(`PASS ${++n}: ${m}`);
const NOW = Date.parse("2026-10-24T12:00:00Z");
const policy = { ...A.DEFAULT_ACCOUNTING, configured: true };
const input = (o: any = {}) => ({ route: "bank", srcCcy: "USD", destCcy: "CAD", amountType: "RECIPIENT_FIXED", amount: "50000.00", fxRate: "1.35904", fundingFee: "15.00", payoutFee: "0", ...o });
// What the payout service posts for an executed quote (SOURCE_DEBIT, FUNDING_FEE, PROVIDER_FUNDING, PROVIDER_FX, PAYOUT_FEE, ROUNDING, CREDIT)
function child(id: string, inp: any, opts: { skip?: string[]; credited?: bigint } = {}) {
  const q = quoteFor(inp, id), L: any[] = [], line = (asset: string, account: string, m: bigint) => ({ asset, account, amountMinor: m.toString() });
  const post = (kind: string, lines: any[]) => { if (!opts.skip?.includes(kind)) L.push({ entryId: `le_${kind}_${id}`, transferId: id, kind, lines, at: "2026-10-24T10:00:00Z" }); };
  const S0 = BigInt(q.sourceDebit.minor), fee = BigInt(q.fundingFee.minor), F = BigInt(q.funding.minor), C = BigInt(q.converted.minor), src = inp.srcCcy, dest = inp.destCcy;
  post("SOURCE_DEBIT", [line(src, "source:US-Operating", -S0), line(src, "clearing:funding", S0)]);
  post("FUNDING_FEE", [line(src, "clearing:funding", -fee), line(src, "fees:funding", fee)]);
  post("PROVIDER_FUNDING", [line(src, "clearing:funding", -(S0 - fee)), line(src, "provider:clearing", S0 - fee)]);
  post("PROVIDER_FX", [line(src, "provider:clearing", -F), line(src, "counterparty:fx", F), line(dest, "counterparty:fx", -C), line(dest, "payout:clearing", C)]);
  post("PAYOUT_FEE", [line(dest, "payout:clearing", -BigInt(q.payoutFee.minor)), line(dest, "fees:payout", BigInt(q.payoutFee.minor))]);
  if (BigInt(q.roundingSurplus.minor) > 0n) post("ROUNDING_SURPLUS", [line(dest, "payout:clearing", -BigInt(q.roundingSurplus.minor)), line(dest, "provider:rounding", BigInt(q.roundingSurplus.minor))]);
  const X = opts.credited ?? BigInt(q.recipientNet.minor);
  post("BENEFICIARY_CREDIT", [line(dest, "payout:clearing", -X), line(dest, "beneficiary:recipient", X)]);
  return { transferId: id, payoutId: `po_${id}`, status: "DELIVERED", quote: q, ledger: L, funding: { mode: "simulated_bank" } };
}
const req = (o: any = {}) => ({ id: "pr_1", payable: "AP-CA-Maple", supplier: "Maple Freight", ccy: "CAD", amount: "50000.00", status: "COMPLETED", transferId: "tr_1",
  preparedAt: "2026-10-24T09:00:00Z", route: "bank:local_express", ...o });
const transfer = (inp: any, o: any = {}) => ({ transferId: "tr_1", status: "COMPLETED", terms: { intent: { amountType: inp.amountType }, allocations: [{ routeId: "bank:local_express", input: inp }], totals: { arrivalUtc: "2026-10-24T11:00:00Z" } },
  creditedAtUtc: "2026-10-24T10:05:00Z", value: { platformFee: "0.00 USD" }, ...o });
const build = (o: any = {}) => A.buildRecord({ request: req(o.request), transfer: o.transfer === undefined ? transfer(o.quoted ?? input()) : o.transfer,
  children: o.children === undefined ? [child("tr_1_c1", o.executed ?? o.quoted ?? input())] : o.children, bill: o.bill === undefined ? { id: "AP-CA-Maple", ccy: "CAD", amount: "50000.00" } : o.bill,
  functionalCcy: "USD", policy: o.policy ?? policy, review: o.review ?? null, now: NOW });
const amt = (l: any) => l.amount?.display;

// 1. Balance in the functional currency
const usd = input({ destCcy: "USD", fxRate: "1", amount: "1000.00" });
let r = build({ quoted: usd, request: { ccy: "USD", amount: "1000.00" }, bill: { id: "B-1", ccy: "USD", amount: "1000.00" } });
assert.equal(r.journal.status, "draft"); assert.equal(r.journal.balanced, true);
assert.deepEqual(r.journal.lines.map((l) => [l.side, l.account.code, amt(l)]), [["debit", "2010", "1000.00 USD"], ["debit", "6150", "15.00 USD"], ["credit", "1010", "1015.00 USD"]]);
r = build({ review: { carryingAmount: "36500.00", carryingSource: "ERP bill 4471", by: "priya" } });
assert.equal(r.journal.balanced, true); assert.equal(r.journal.totals!.debit.display, r.journal.totals!.credit.display); assert.equal(r.journal.totals!.credit.display, "36805.68 USD");
pass("entries balance in USD: same-currency and foreign-currency with a carrying amount");

// 2. Missing or inconsistent data keeps the entry in review
r = build();
assert.equal(r.journal.status, "needs_review"); assert.equal(r.journal.lines[0].amount, null); assert.equal(r.journal.totals, null);
assert.ok(r.journal.missing.some((m) => /carrying amount/.test(m)));
r = build({ bill: null, request: { payable: "chat_x" }, review: { carryingAmount: "36500.00" } });
assert.equal(r.journal.status, "needs_review"); assert.ok(r.journal.missing.some((m) => /invoice reference/.test(m)));
r = build({ bill: { id: "AP-CA-Maple", ccy: "EUR", amount: "50000.00" }, review: { carryingAmount: "36500.00" } });
assert.ok(r.journal.errors.some((e) => /invoice is in EUR/.test(e))); assert.equal(r.journal.status, "needs_review");
r = build({ policy: A.DEFAULT_ACCOUNTING, review: { carryingAmount: "36500.00" } });
assert.equal(r.journal.status, "needs_review"); assert.ok(r.journal.missing.some((m) => /illustrative/.test(m)));
pass("missing carrying amount, invoice, currency mismatch or unconfirmed mapping block approval");

// 3. Conversions: realized FX from the carrying amount; payout fee valued at the executed rate, summing exactly
r = build({ review: { carryingAmount: "36500.00" } });
const fx = r.journal.lines.find((l) => l.account.code === "7910")!;
assert.equal(fx.side, "debit"); assert.equal(amt(fx), "290.68 USD");   // 36,790.68 settlement value - 36,500.00 booked = loss
r = build({ review: { carryingAmount: "37000.00" } });
assert.equal(r.journal.lines.find((l) => l.account.code === "7910")!.side, "credit");
const withFee = input({ payoutFee: "25.00" });
r = build({ quoted: withFee, review: { carryingAmount: "36800.00" } });
const pf = r.journal.lines.find((l) => /Payout fee/.test(l.description))!;
assert.equal(r.journal.balanced, true); assert.match(pf.calculation, /executed rate 1\.35904/);
r = build({ quoted: withFee, policy: { ...policy, apMeasurement: "settlement_value" } });
assert.equal(r.journal.status, "draft"); assert.ok(!r.journal.lines.some((l) => l.account.code === "7910"));
pass("FX gain/loss only against a booked carrying amount; fees converted at the executed rate");

// 4. Variance: higher fee and worse rate decompose exactly into the source-debit difference
const worse = input({ fxRate: "1.35500", fundingFee: "20.00" });
r = build({ executed: worse });
const src = r.variance.metrics.find((m) => m.key === "source")!, rate = r.variance.metrics.find((m) => m.key === "rate")!;
assert.equal(r.variance.comparable, true); assert.ok(Number(src.diff!.split(" ")[0]) > 0); assert.ok(rate.pct! < 0);
const eff = r.variance.effects.reduce((s, e) => s + Number(e.amount.minor), 0) + Number(r.variance.residual!.minor);
assert.equal(eff, Math.round(Number(src.diff!.split(" ")[0]) * 100));
assert.equal(r.variance.effects.find((e) => e.key === "funding_fee")!.amount.display, "5.00 USD");
assert.ok(Math.abs(Number(r.variance.residual!.minor)) <= 1);
assert.deepEqual(r.flags.map((f) => f.key).sort(), ["fee_over_quote", "fx_deviation"]);
r = build({ executed: input({ fxRate: "1.35900" }) });   // 0.3 bps: below the 10 bps threshold
assert.ok(!r.flags.some((f) => f.key === "fx_deviation"));
r = build({ executed: input({ fxRate: "1.35900" }), policy: { ...policy, variance: { ...policy.variance, fxDeviationBps: 0.1 } } });
assert.ok(r.flags.some((f) => f.key === "fx_deviation"));
pass("fee and rate variances calculated, decomposed and flagged against configurable thresholds");

// 5. Missing execution data never produces a comparison
r = build({ children: [child("tr_1_c1", input(), { skip: ["PROVIDER_FX"] })] });
assert.equal(r.variance.comparable, false); assert.ok(r.variance.metrics.every((m) => m.key === "rate" ? m.actual == null : m.key === "platform_fee" || m.actual == null));
assert.equal(r.journal.status, "needs_review"); assert.ok(r.flags.some((f) => f.key === "missing_execution"));
r = build({ children: null }); assert.equal(r.variance.comparable, false); assert.equal(r.journal.lines.length, 0);
r = build({ transfer: transfer(input(), { status: "EXECUTING", creditedAtUtc: null }), request: { status: "EXECUTING" }, children: [] });
assert.equal(r.journal.status, "not_ready"); assert.equal(r.lifecycle, "initiated"); assert.equal(r.variance.comparable, false);
assert.ok(!r.flags.some((f) => f.key === "settlement_overdue"));   // 1 h past arrival, inside the 24 h grace
r = build({ transfer: transfer(input(), { status: "EXECUTING", creditedAtUtc: null }), request: { status: "EXECUTING" }, children: [], policy: { ...policy, variance: { ...policy.variance, settlementGraceHours: 0 } } });
assert.ok(r.flags.some((f) => f.key === "settlement_overdue"));
pass("incomplete or absent execution data: no comparison, no entry, a flag instead");

// 6. Duplicate processing: same id and lines on every build; a second approval is refused; one stored row
const one = build({ review: { carryingAmount: "36500.00" } }), two = build({ review: { carryingAmount: "36500.00" } });
assert.equal(one.id, "je_pr_1"); assert.deepEqual(one.journal, two.journal);
S.approveRecord(one, "priya"); assert.throws(() => S.approveRecord(two, "jordan"), /Already approved/);
assert.equal(Object.keys(S.accountingRows()).length, 1); assert.equal(S.accountingRow("pr_1").approval!.snapshot.journal.status, "approved");
assert.throws(() => S.saveReview("pr_1", { carryingAmount: "1.00" }, "priya"), /approved/);
assert.throws(() => S.approveRecord(build({ request: { id: "pr_2" } }), "priya"), /balanced entry/);
pass("deterministic ids, single approval, frozen inputs after approval, unbalanced entries refused");

// 7. Building records never changes payment status; lifecycle keeps quoted / initiated / settled apart
const rq = req(), tr = transfer(input()), before = JSON.stringify([rq, tr]);
A.buildRecord({ request: rq, transfer: tr, children: [child("tr_1_c1", input())], bill: null, functionalCcy: "USD", policy, now: NOW });
assert.equal(JSON.stringify([rq, tr]), before);
assert.equal(build({ transfer: null, request: { status: "AWAITING_APPROVAL", transferId: undefined }, children: [] }).lifecycle, "quoted");
assert.equal(build({ transfer: transfer(input(), { status: "SCHEDULED" }), children: [] }).lifecycle, "initiated");
assert.equal(build({ transfer: transfer(input(), { status: "NEEDS_RECONCILIATION" }) }).journal.status, "not_ready");
assert.equal(build({}).lifecycle, "settled");
pass("inputs unchanged; quoted, initiated, settled and reconciliation states stay distinct");

// 8. Aggregates: settled in the period only
const recs = [build({ review: { carryingAmount: "36500.00" } }),
  build({ request: { id: "pr_old" }, transfer: transfer(input(), { creditedAtUtc: "2026-08-01T00:00:00Z" }) }),
  build({ request: { id: "pr_run", status: "EXECUTING" }, transfer: transfer(input(), { status: "EXECUTING", creditedAtUtc: null }), children: [] }),
  build({ request: { id: "pr_fee" }, executed: worse })];
let sum = A.summarize(recs, "30d", NOW, "USD");
assert.equal(sum.completed.count, 2);
const vol = Number(recs[0].actual!.sourceDebit.split(" ")[0]) + Number(recs[3].actual!.sourceDebit.split(" ")[0]);
assert.equal(Number(sum.completed.volume.split(" ")[0]).toFixed(2), vol.toFixed(2));
assert.equal(sum.fees.amount, "35.00 USD"); assert.equal(sum.flagged.count, 1); assert.equal(sum.awaitingReview.count, 2);
assert.equal(sum.variance.amount, recs[3].variance.metrics[0].diff); assert.equal(sum.variance.comparable, 2);
assert.equal(A.summarize(recs, "all", NOW, "USD").completed.count, 3);
pass("aggregates count settled payments in the period only, with fees, variance, flags and review queue");

// 9. CSV: validated entries only, amounts and references match the record
const csv = A.toCsv([build({ review: { carryingAmount: "36500.00" } }), build({ request: { id: "pr_x" } })]).split("\n");
assert.equal(csv[0], A.CSV_HEAD.join(",")); assert.equal(csv.length, 1 + one.journal.lines.length);
assert.ok(csv.every((l, i) => i === 0 || /^"je_pr_1","draft"/.test(l)));
const cash = csv.find((l) => l.includes('"1010"'))!;
assert.ok(cash.includes(',"","36805.68","USD","2026-10-24","2026-10-24"')); assert.ok(cash.includes('"pr_1","tr_1","po_tr_1_c1","AP-CA-Maple","linked bill","Maple Freight"'));
pass("CSV holds balanced entries only, with amounts, currency, dates and source references");
console.log(`\n${n} accounting checks passed`);
