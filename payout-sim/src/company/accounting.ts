// Payment-to-ledger records and quote-versus-actual cost accounting for supplier payments.
// Everything here is computed deterministically from recorded data: the approved terms (re-quoted with the payout service's
// own quoteFor, so quoted and executed figures follow the same rounding conventions), and the payout service's ledger
// postings for each leg (SOURCE_DEBIT, FUNDING_FEE, ONRAMP_CONVERSION/PROVIDER_FX, PAYOUT_FEE, ROUNDING_SURPLUS,
// BENEFICIARY_CREDIT). Nothing is posted to a company's general ledger: records are accounting-ready and exportable.
// Amounts are integer minor units (bigint); rates are display values only and never used to move money.
import { decimals, fmt, toMinor } from "../money.js";
import { quoteFor, type QuoteInput } from "../scenarios.js";

export interface AccountRef { code: string; name: string }
export interface VarianceThresholds {
  feeToleranceUsd: number;          // flag when actual fees exceed the quoted fees by more than this (functional currency)
  fxDeviationBps: number;           // flag when the executed rate differs from the quoted rate by more than this (basis points)
  beneficiaryTolerancePct: number;  // flag when the supplier received a different amount by more than this percent
  unexplainedToleranceUsd: number;  // differences up to this are treated as rounding; above it, unexplained
  settlementGraceHours: number;     // flag a payment with no recorded credit this long after its estimated arrival
}
export interface AccountingPolicy {
  chart: { cash: AccountRef; ap: AccountRef; bankFees: AccountRef; fxGainLoss: AccountRef };
  configured: boolean; configuredBy?: string; configuredAt?: string;   // false = the codes below are illustrative
  // carrying_value: the AP being settled is measured at its booked amount (entered per payment from the company's ledger);
  //   the difference to the settlement value is a realized FX gain or loss. settlement_value: the bill is recognized at
  //   payment (no earlier booking), so no realized FX gain or loss arises. Same-currency payments need neither.
  apMeasurement: "carrying_value" | "settlement_value";
  variance: VarianceThresholds;
}
// Illustrative defaults only: every company maps its own chart of accounts in Policy & people before approving entries.
export const DEFAULT_ACCOUNTING: AccountingPolicy = {
  chart: { cash: { code: "1010", name: "Operating cash" }, ap: { code: "2010", name: "Accounts payable" },
    bankFees: { code: "6150", name: "Bank and transfer fees" }, fxGainLoss: { code: "7910", name: "Realized FX gain/loss" } },
  configured: false, apMeasurement: "carrying_value",
  variance: { feeToleranceUsd: 0, fxDeviationBps: 10, beneficiaryTolerancePct: 0.1, unexplainedToleranceUsd: 0.05, settlementGraceHours: 24 },
};
const num = (v: any, d: number, min = 0, max = 1e9) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const acct = (v: any, d: AccountRef): AccountRef => ({ code: String(v?.code ?? d.code).trim().slice(0, 20) || d.code, name: String(v?.name ?? d.name).trim().slice(0, 80) || d.name });
export function cleanAccounting(x: any, prev: AccountingPolicy = DEFAULT_ACCOUNTING): AccountingPolicy {
  const D = DEFAULT_ACCOUNTING, c = x?.chart ?? {}, v = x?.variance ?? {};
  return { chart: { cash: acct(c.cash, prev.chart.cash), ap: acct(c.ap, prev.chart.ap), bankFees: acct(c.bankFees, prev.chart.bankFees), fxGainLoss: acct(c.fxGainLoss, prev.chart.fxGainLoss) },
    configured: prev.configured, configuredBy: prev.configuredBy, configuredAt: prev.configuredAt,
    apMeasurement: x?.apMeasurement === "settlement_value" ? "settlement_value" : x?.apMeasurement === "carrying_value" ? "carrying_value" : prev.apMeasurement,
    variance: { feeToleranceUsd: num(v.feeToleranceUsd, prev.variance.feeToleranceUsd ?? D.variance.feeToleranceUsd),
      fxDeviationBps: num(v.fxDeviationBps, prev.variance.fxDeviationBps ?? D.variance.fxDeviationBps, 0, 10_000),
      beneficiaryTolerancePct: num(v.beneficiaryTolerancePct, prev.variance.beneficiaryTolerancePct ?? D.variance.beneficiaryTolerancePct, 0, 100),
      unexplainedToleranceUsd: num(v.unexplainedToleranceUsd, prev.variance.unexplainedToleranceUsd ?? D.variance.unexplainedToleranceUsd),
      settlementGraceHours: num(v.settlementGraceHours, prev.variance.settlementGraceHours ?? D.variance.settlementGraceHours, 0, 24 * 90) } };
}

// ------------------------------------------------------------------ inputs
export interface LedgerLine { asset: string; account: string; amountMinor: string }
export interface LedgerEntry { entryId: string; transferId: string; kind: string; lines: LedgerLine[]; refs?: Record<string, string>; provenance?: string; at: string }
export interface ChildReceipt { transferId: string; payoutId?: string; status?: string; quote?: any; ledger?: LedgerEntry[];
  reconciliation?: { outstanding?: { fundedButUnpaid?: boolean }; creditedAtUtc?: string }; funding?: { mode?: string; provenance?: string } }
export interface ReviewInputs { invoiceRef?: string; carryingAmount?: string; carryingSource?: string; by?: string; at?: string }
export interface BuildInput {
  request: { id: string; payable: string; supplier: string; ccy: string; amount: string; reference?: string; status: string; transferId?: string;
    preparedAt: string; route: string; platformFee?: string };
  transfer?: { transferId: string; status: string; terms: any; executionPlan?: any; creditedAtUtc?: string | null; confirmedAtUtc?: string;
    dispatchedAtUtc?: string; history?: { at: string; status: string }[]; value?: { platformFee?: string } } | null;
  children?: ChildReceipt[] | null;      // per-leg receipts from the payout service (null when they could not be read)
  bill?: { id: string; ccy: string; amount: string; dueUtc?: string } | null;
  functionalCcy: string; policy: AccountingPolicy; review?: ReviewInputs | null; now?: number;
}

// ------------------------------------------------------------------ money helpers
const M = (minor: bigint, ccy: string) => ({ minor: minor.toString(), ccy, display: fmt(minor, ccy) });
type Amt = ReturnType<typeof M>;
const big = (s: string | undefined) => BigInt(s ?? "0");
/** a / b rounded half away from zero (b > 0). */
const divRound = (a: bigint, b: bigint) => (b <= 0n ? 0n : a >= 0n ? (2n * a + b) / (2n * b) : -((-2n * a + b) / (2n * b)));
/** dest units per one source unit, from two minor amounts (display precision, 8 decimals). */
export function rateOf(destMinor: bigint, destCcy: string, srcMinor: bigint, srcCcy: string): number | null {
  if (srcMinor <= 0n || destMinor <= 0n) return null;
  const scaled = (destMinor * 10n ** BigInt(decimals(srcCcy)) * 100_000_000n) / (srcMinor * 10n ** BigInt(decimals(destCcy)));
  return Number(scaled) / 1e8;
}
const pct = (diff: bigint, base: bigint) => (base === 0n ? null : Number((diff * 1_000_000n) / base) / 10_000);
const parseAmount = (s: string | undefined, ccy: string): bigint | null => {
  if (!s || !/^-?\d+(\.\d+)?$/.test(String(s).trim())) return null;
  const v = String(s).trim(), d = decimals(ccy), frac = v.split(".")[1] ?? "";
  if (frac.length > d) return null;
  try { return v.startsWith("-") ? -toMinor(v.slice(1), ccy) : toMinor(v, ccy); } catch { return null; }
};

// ------------------------------------------------------------------ quoted and actual breakdowns (summed across legs)
export interface Side { srcCcy: string; destCcy: string; sourceDebit: bigint; fundingFee: bigint; converted: bigint; payoutFee: bigint; rounding: bigint;
  recipient: bigint; legs: { routeId: string; label?: string; fxRate: number | null; onrampRate: number | null; sourceDebit: bigint; recipient: bigint }[] }
const zero = (src: string, dest: string): Side => ({ srcCcy: src, destCcy: dest, sourceDebit: 0n, fundingFee: 0n, converted: 0n, payoutFee: 0n, rounding: 0n, recipient: 0n, legs: [] });

export function quotedSide(terms: any): Side | null {
  const allocs = terms?.allocations ?? []; if (!allocs.length) return null;
  const first = allocs[0].input as QuoteInput, s = zero(first.srcCcy, first.destCcy);
  for (const a of allocs) {
    const q = quoteFor(a.input as QuoteInput, `acct_${a.routeId}`);
    s.sourceDebit += big(q.sourceDebit.minor); s.fundingFee += big(q.fundingFee.minor); s.converted += big(q.converted.minor);
    s.payoutFee += big(q.payoutFee.minor); s.rounding += big(q.roundingSurplus.minor); s.recipient += big(q.recipientNet.minor);
    s.legs.push({ routeId: a.routeId, label: a.label, fxRate: Number(a.input.fxRate), onrampRate: a.input.onrampRate ? Number(a.input.onrampRate) : null,
      sourceDebit: big(q.sourceDebit.minor), recipient: big(q.recipientNet.minor) });
  }
  return s;
}
const sumLines = (entries: LedgerEntry[], kind: string, account: string, positive = true) =>
  entries.filter((e) => e.kind === kind).flatMap((e) => e.lines).filter((l) => l.account === account && (big(l.amountMinor) > 0n) === positive)
    .reduce((a, l) => a + big(l.amountMinor), 0n);
/** What the provider ledger recorded for each leg. `missing` lists the postings that are absent. */
export function actualSide(children: ChildReceipt[], srcCcy: string, destCcy: string): { side: Side; missing: string[] } {
  const s = zero(srcCcy, destCcy), missing: string[] = [];
  for (const c of children) {
    const L = c.ledger ?? [], has = (k: string) => L.some((e) => e.kind === k);
    if (!has("SOURCE_DEBIT")) missing.push(`${c.transferId}: source debit posting`);
    if (!has("PROVIDER_FX")) missing.push(`${c.transferId}: conversion posting`);
    if (!has("BENEFICIARY_CREDIT")) missing.push(`${c.transferId}: beneficiary credit posting`);
    const S = sumLines(L, "SOURCE_DEBIT", "clearing:funding"), fee = sumLines(L, "FUNDING_FEE", "fees:funding");
    const fx = L.filter((e) => e.kind === "PROVIDER_FX").flatMap((e) => e.lines);
    const assetIn = fx.filter((l) => l.account === "counterparty:fx" && big(l.amountMinor) > 0n);
    const C = fx.filter((l) => l.account === "payout:clearing" && big(l.amountMinor) > 0n).reduce((a, l) => a + big(l.amountMinor), 0n);
    const on = L.filter((e) => e.kind === "ONRAMP_CONVERSION").flatMap((e) => e.lines);
    const onSrc = -on.filter((l) => l.account === "clearing:funding").reduce((a, l) => a + big(l.amountMinor), 0n);
    const onAsset = on.filter((l) => l.account === "provider:clearing").reduce((a, l) => a + big(l.amountMinor), 0n);
    const cred = sumLines(L, "BENEFICIARY_CREDIT", "beneficiary:recipient");
    s.sourceDebit += S; s.fundingFee += fee; s.converted += C; s.payoutFee += sumLines(L, "PAYOUT_FEE", "fees:payout");
    s.rounding += sumLines(L, "ROUNDING_SURPLUS", "provider:rounding"); s.recipient += cred;
    const a0 = assetIn[0];
    s.legs.push({ routeId: c.quote?.route ?? c.transferId, label: c.quote?.input ? `${c.quote.route} ${c.quote.input.srcCcy}->${c.quote.input.destCcy}` : undefined,
      fxRate: a0 ? rateOf(C, destCcy, big(a0.amountMinor), a0.asset) : null, onrampRate: on.length && onAsset > 0n ? rateOf(onAsset, c.quote?.funding?.ccy ?? "USDC", onSrc, srcCcy) : null,
      sourceDebit: S, recipient: cred });
  }
  return { side: s, missing };
}
/** Destination currency per source unit actually converted (after the funding fee), across all legs. */
export const effectiveRate = (s: Side) => rateOf(s.converted, s.destCcy, s.sourceDebit - s.fundingFee, s.srcCcy);
/** Source-currency value of a destination amount at the side's own effective rate (rounded half up). */
const srcValue = (s: Side, destMinor: bigint) => divRound(destMinor * (s.sourceDebit - s.fundingFee), s.converted);

// ------------------------------------------------------------------ lifecycle
export type Lifecycle = "quoted" | "approved" | "initiated" | "settled" | "needs_reconciliation" | "paused" | "failed" | "rejected" | "refunded";
export function lifecycleOf(i: BuildInput): Lifecycle {
  const t = i.transfer, r = i.request;
  if (r.status === "REJECTED") return "rejected";
  if (r.status === "REFUNDED") return "refunded";
  if (!t) return ["AWAITING_APPROVAL", "NEEDS_CALLBACK"].includes(r.status) ? "quoted" : r.status === "FAILED" ? "failed" : "approved";
  if (t.status === "COMPLETED") return "settled";
  if (t.status === "NEEDS_RECONCILIATION") return "needs_reconciliation";
  if (t.status === "PAUSED") return "paused";
  if (["SCHEDULED", "EXECUTING"].includes(t.status)) return "initiated";
  return t.status === "AWAITING_APPROVAL" ? "quoted" : "approved";
}
export const LIFECYCLE_LABEL: Record<Lifecycle, string> = { quoted: "Quoted, not approved", approved: "Approved, not initiated", initiated: "Initiated, not settled",
  settled: "Settled (beneficiary credit recorded and reconciled)", needs_reconciliation: "Needs reconciliation", paused: "Paused", failed: "Failed", rejected: "Rejected", refunded: "Refunded" };

// ------------------------------------------------------------------ variance
export interface Metric { key: string; label: string; basis: string; ccy: string | null; quoted: string | null; actual: string | null; diff: string | null; pct: number | null; unit?: "bps" }
export interface Effect { key: string; label: string; amount: Amt; explanation: string }
export interface Flag { key: string; severity: "review" | "info"; reason: string; values: string; next: string }
export interface Variance { comparable: boolean; unavailable?: string; metrics: Metric[]; effects: Effect[]; residual: Amt | null; explanation: string[]; repriced: boolean }

export function computeVariance(q: Side | null, a: Side | null, opts: { functionalCcy: string; amountType?: string; platformFee?: string; repriced: boolean; missing: string[] }): Variance {
  const out: Variance = { comparable: false, metrics: [], effects: [], residual: null, explanation: [], repriced: opts.repriced };
  if (!q) { out.unavailable = "No approved quote is recorded for this payment."; return out; }
  const m = (key: string, label: string, basis: string, ccy: string, qa: bigint, aa: bigint | null): Metric =>
    ({ key, label, basis, ccy, quoted: fmt(qa, ccy), actual: aa == null ? null : fmt(aa, ccy), diff: aa == null ? null : fmt(aa - qa, ccy), pct: aa == null ? null : pct(aa - qa, qa) });
  const ok = !!a && opts.missing.length === 0;
  const qr = effectiveRate(q), ar = ok ? effectiveRate(a!) : null;
  out.metrics = [
    m("source", "Total funding cost (source debit, fees included)", "Approved terms vs the provider ledger's source debit", q.srcCcy, q.sourceDebit, ok ? a!.sourceDebit : null),
    m("funding_fee", "Transfer fee", "Approved terms vs the provider ledger's funding-fee posting", q.srcCcy, q.fundingFee, ok ? a!.fundingFee : null),
    m("payout_fee", "Payout fee", "Approved terms vs the provider ledger's payout-fee posting (deducted after conversion)", q.destCcy, q.payoutFee, ok ? a!.payoutFee : null),
    { key: "rate", label: `Exchange rate (${q.destCcy} per ${q.srcCcy} converted)`, basis: "Converted amount divided by the source debit less the transfer fee, so the fee is not counted twice",
      ccy: null, quoted: qr?.toFixed(6) ?? null, actual: ar?.toFixed(6) ?? null, diff: qr && ar ? (ar - qr).toFixed(6) : null,
      pct: qr && ar ? Math.round(((ar - qr) / qr) * 1_000_000) / 10_000 : null, unit: "bps" },   // percent; shown as bps
    m("beneficiary", "Supplier receives", "Approved terms vs the provider ledger's beneficiary credit", q.destCcy, q.recipient, ok ? a!.recipient : null),
  ];
  out.metrics.push({ key: "platform_fee", label: "Route402 fee (billed separately)", basis: "Approved terms; Route402 records no separate charge for it, so there is no actual to compare",
    ccy: q.srcCcy, quoted: opts.platformFee ?? null, actual: null, diff: null, pct: null });
  if (!ok) { out.unavailable = !a ? "No execution data is recorded yet, so no comparison is made." : `Execution data is incomplete: missing ${opts.missing.join("; ")}.`; return out; }
  if (q.srcCcy !== a!.srcCcy || q.destCcy !== a!.destCcy) { out.unavailable = "The quote and the execution use different currencies; no direct comparison."; return out; }
  if (q.srcCcy !== opts.functionalCcy) { out.unavailable = `Costs are in ${q.srcCcy}, not the functional currency ${opts.functionalCcy}; no conversion basis is recorded.`; return out; }
  out.comparable = true;
  // Decompose the source-debit difference with the identity S = fee + (credited + payout fee + rounding) / r, where r is
  // the effective rate. Destination-side changes are valued at the executed rate; the rate effect uses the quoted amounts.
  const A = a!, src = q.srcCcy, dest = q.destCcy, dS = A.sourceDebit - q.sourceDebit;
  const qDest = q.recipient + q.payoutFee + q.rounding, viaA = (x: bigint) => srcValue(A, x);
  const effects: [string, string, bigint, string][] = [
    ["funding_fee", "Transfer fee change", A.fundingFee - q.fundingFee, `${fmt(A.fundingFee, src)} charged vs ${fmt(q.fundingFee, src)} quoted`],
    ["rate", "Exchange-rate change", viaA(qDest) - (q.sourceDebit - q.fundingFee),
      `${fmt(qDest, dest)} costs ${fmt(viaA(qDest), src)} at the executed rate ${ar!.toFixed(6)} vs ${fmt(q.sourceDebit - q.fundingFee, src)} at the quoted rate ${qr!.toFixed(6)}`],
    ["payout_fee", "Payout fee change", viaA(A.payoutFee) - viaA(q.payoutFee), `${fmt(A.payoutFee, dest)} charged vs ${fmt(q.payoutFee, dest)} quoted, valued at the executed rate`],
    ["beneficiary", "Supplier amount change", viaA(A.recipient) - viaA(q.recipient), `${fmt(A.recipient, dest)} credited vs ${fmt(q.recipient, dest)} quoted, valued at the executed rate`],
    ["rounding", "Rounding kept by the provider", viaA(A.rounding) - viaA(q.rounding), `${fmt(A.rounding, dest)} vs ${fmt(q.rounding, dest)} quoted`],
  ];
  out.effects = effects.filter(([, , v]) => v !== 0n).map(([key, label, v, explanation]) => ({ key, label, amount: M(v, src), explanation }));
  const explained = effects.reduce((s, e) => s + e[2], 0n), residual = dS - explained;
  out.residual = M(residual, src);
  const bps = qr && ar ? Math.round(((ar - qr) / qr) * 10_000 * 100) / 100 : 0;
  if (dS === 0n && A.recipient === q.recipient) out.explanation.push(`Settled exactly as quoted: ${fmt(A.sourceDebit, src)} debited, ${fmt(A.recipient, dest)} credited.`);
  else out.explanation.push(`${fmt(A.sourceDebit, src)} debited vs ${fmt(q.sourceDebit, src)} quoted (${dS > 0n ? "+" : ""}${fmt(dS, src)}); supplier credited ${fmt(A.recipient, dest)} vs ${fmt(q.recipient, dest)}.`);
  if (A.fundingFee !== q.fundingFee) out.explanation.push(`The transfer fee was ${fmt(A.fundingFee, src)} against ${fmt(q.fundingFee, src)} quoted.`);
  if (bps !== 0) out.explanation.push(`The executed rate was ${Math.abs(bps)} bps ${bps < 0 ? "worse" : "better"} than quoted (${ar!.toFixed(6)} vs ${qr!.toFixed(6)} ${dest} per ${src}).`);
  if (A.payoutFee !== q.payoutFee) out.explanation.push(`The payout fee was ${fmt(A.payoutFee, dest)} against ${fmt(q.payoutFee, dest)} quoted.`);
  if (A.recipient !== q.recipient) out.explanation.push(`The supplier was credited ${fmt(A.recipient - q.recipient, dest)} ${A.recipient > q.recipient ? "more" : "less"} than quoted${opts.amountType === "SOURCE_FIXED" ? " (the source amount was fixed, so rate and fee changes land on the supplier's amount)" : ""}.`);
  if (residual !== 0n) out.explanation.push(`${fmt(residual, src)} of the difference is not explained by fee, rate or amount changes in the recorded data.`);
  if (opts.repriced) out.explanation.push("The payment was re-priced at release within the approved debit cap; the comparison is against the approved terms.");
  return out;
}

export function flagsFor(v: Variance, life: Lifecycle, th: VarianceThresholds, ctx: { arrivalUtc?: string; now: number; missing: string[]; functionalCcy: string }): Flag[] {
  const out: Flag[] = [], metric = (k: string) => v.metrics.find((x) => x.key === k);
  if (life === "needs_reconciliation" || life === "failed") out.push({ key: "settlement", severity: "review", reason: "Settlement could not be confirmed", values: LIFECYCLE_LABEL[life],
    next: "Check the transfer's reconciliation legs and the provider reference before any retry." });
  if (life === "initiated" && ctx.arrivalUtc && ctx.now > Date.parse(ctx.arrivalUtc) + th.settlementGraceHours * 3600e3)
    out.push({ key: "settlement_overdue", severity: "review", reason: `No beneficiary credit recorded ${th.settlementGraceHours} h after the estimated arrival`, values: `estimated ${ctx.arrivalUtc}`,
      next: "Ask the payout provider for the payment's status and any return or rejection notice." });
  if (life === "settled" && ctx.missing.length) out.push({ key: "missing_execution", severity: "review", reason: "Execution data is incomplete", values: ctx.missing.join("; "),
    next: "Obtain the missing provider postings; no cost comparison is made until they exist." });
  if (!v.comparable) return out;
  const fee = v.effects.filter((e) => e.key === "funding_fee" || e.key === "payout_fee").reduce((s, e) => s + Number(e.amount.minor), 0) / 10 ** decimals(ctx.functionalCcy);
  if (fee > th.feeToleranceUsd) out.push({ key: "fee_over_quote", severity: "review", reason: `Fees exceeded the quote by more than ${th.feeToleranceUsd} ${ctx.functionalCcy}`,
    values: [metric("funding_fee"), metric("payout_fee")].filter((x) => x && x.diff && !/^-?0(\.0+)? /.test(x.diff)).map((x) => `${x!.label}: ${x!.actual} vs ${x!.quoted}`).join("; "),
    next: "Compare the provider's fee statement with the quote and request a refund of any fee not in the agreed schedule." });
  const r = metric("rate");
  if (r?.pct != null && Math.abs(r.pct * 100) > th.fxDeviationBps) out.push({ key: "fx_deviation", severity: "review",
    reason: `Executed rate differs from the quote by ${Math.abs(Math.round(r.pct * 10000) / 100)} bps (threshold ${th.fxDeviationBps} bps)`, values: `${r.actual} vs ${r.quoted} quoted`,
    next: "Check the provider's execution timestamp and rate source against the quote's validity window." });
  const b = metric("beneficiary");
  if (b?.pct != null && Math.abs(b.pct) > th.beneficiaryTolerancePct) out.push({ key: "beneficiary_difference", severity: "review",
    reason: `Supplier received ${Math.abs(b.pct)}% ${Number(b.diff!.split(" ")[0]) < 0 ? "less" : "more"} than quoted (threshold ${th.beneficiaryTolerancePct}%)`, values: `${b.actual} vs ${b.quoted}`,
    next: "Confirm the amount with the supplier and decide whether the invoice is fully settled." });
  if (v.residual && Math.abs(Number(v.residual.minor)) / 10 ** decimals(v.residual.ccy) > th.unexplainedToleranceUsd)
    out.push({ key: "unexplained", severity: "review", reason: "Part of the cost difference is unexplained by the recorded data", values: v.residual.display,
      next: "Request the provider's itemized execution report (rate, fees, intermediary deductions)." });
  return out;
}

// ------------------------------------------------------------------ journal entry
export interface JournalLine { line: number; side: "debit" | "credit"; account: AccountRef; amount: Amt | null; description: string; calculation: string }
export type JournalStatus = "not_ready" | "needs_review" | "draft" | "approved";
export interface Journal { status: JournalStatus; currency: string; transactionDate: string | null; accountingDate: string | null; lines: JournalLine[];
  totals: { debit: Amt; credit: Amt } | null; balanced: boolean; missing: string[]; errors: string[]; notes: string[]; mappingIllustrative: boolean }

export interface AccountingRecord {
  id: string; requestId: string; transferId: string | null; lifecycle: Lifecycle; lifecycleLabel: string; provenance: string;
  source: { supplier: string; reference: string | null; invoice: { ref: string | null; origin: "linked bill" | "entered by reviewer" | null; amount: string | null; dueUtc: string | null; verified: false };
    payment: { requestedAmount: string; route: string; preparedAt: string; settledAtUtc: string | null; payoutIds: string[]; evidence: string[] } };
  quoted: SideView | null; actual: SideView | null; observedFees: Amt | null; variance: Variance; flags: Flag[]; journal: Journal; review: ReviewInputs | null;
  approval?: { by: string; at: string; hash: string };
}
export interface SideView { sourceDebit: string; fundingFee: string; converted: string; payoutFee: string; rounding: string; recipient: string; effectiveRate: number | null;
  legs: { routeId: string; label?: string; fxRate: number | null; onrampRate: number | null; sourceDebit: string; recipient: string }[] }
const view = (s: Side | null): SideView | null => s && ({ sourceDebit: fmt(s.sourceDebit, s.srcCcy), fundingFee: fmt(s.fundingFee, s.srcCcy), converted: fmt(s.converted, s.destCcy),
  payoutFee: fmt(s.payoutFee, s.destCcy), rounding: fmt(s.rounding, s.destCcy), recipient: fmt(s.recipient, s.destCcy), effectiveRate: effectiveRate(s),
  legs: s.legs.map((l) => ({ ...l, sourceDebit: fmt(l.sourceDebit, s.srcCcy), recipient: fmt(l.recipient, s.destCcy) })) });

function journalFor(i: BuildInput, life: Lifecycle, A: Side | null, missingExec: string[], invoice: AccountingRecord["source"]["invoice"], settledAt: string | null): Journal {
  const P = i.policy, F = i.functionalCcy, ch = P.chart;
  const j: Journal = { status: "not_ready", currency: F, transactionDate: null, accountingDate: null, lines: [], totals: null, balanced: false, missing: [], errors: [], notes: [], mappingIllustrative: !P.configured };
  if (life !== "settled") { j.notes.push(`No journal entry until settlement is recorded (now: ${LIFECYCLE_LABEL[life].toLowerCase()}).`); return j; }
  if (!A || missingExec.length) { j.status = "needs_review"; j.missing.push(...(missingExec.length ? missingExec : ["provider execution records"])); return j; }
  if (A.srcCcy !== F) { j.status = "needs_review"; j.errors.push(`The payment was funded in ${A.srcCcy}, not the functional currency ${F}; no conversion basis is recorded, so no entry is proposed.`); return j; }
  const day = settledAt ? settledAt.slice(0, 10) : null; j.transactionDate = day; j.accountingDate = day;
  if (!day) j.missing.push("settlement date");
  j.notes.push("Transaction and accounting date: the date the beneficiary credit was recorded (UTC).");
  const dest = A.destCcy, spent = A.sourceDebit - A.fundingFee;
  if (A.converted !== A.recipient + A.payoutFee + A.rounding) j.errors.push(`Converted ${fmt(A.converted, dest)} does not equal credited + payout fee + rounding (${fmt(A.recipient + A.payoutFee + A.rounding, dest)}); funds may remain in clearing.`);
  // Functional-currency values of the destination amounts, allocated so they sum exactly to the amount converted
  const pfee = srcValue(A, A.payoutFee), rnd = srcValue(A, A.rounding), settle = spent - pfee - rnd, rate = effectiveRate(A);
  const rateNote = dest === F ? "same currency, no conversion" : `at the executed rate ${rate?.toFixed(6)} ${dest} per ${F} (${fmt(A.converted, dest)} for ${fmt(spent, F)})`;
  // Invoice association
  if (!invoice.ref) j.missing.push("invoice reference (no linked bill; a reviewer can enter one)");
  if (invoice.amount) {
    const [invAmt, invCcy] = invoice.amount.split(" "), inv = toMinor(invAmt, invCcy);
    if (invCcy !== dest) j.errors.push(`The invoice is in ${invCcy} but the supplier was paid in ${dest}; the AP balance cannot be matched without a conversion policy.`);
    else if (A.recipient > inv) j.errors.push(`The supplier was credited ${fmt(A.recipient, dest)}, more than the invoice amount ${invoice.amount}.`);
    else if (A.recipient < inv) j.notes.push(`Partial settlement: ${fmt(A.recipient, dest)} of the ${invoice.amount} invoice; the rest stays open in AP.`);
  }
  // Accounts payable at its carrying amount, and any realized FX difference
  let ap: bigint | null = null, apCalc = "", fxLine: JournalLine | null = null;
  if (dest === F) { ap = A.recipient; apCalc = `${fmt(A.recipient, dest)} credited to the supplier; same currency, so the carrying amount equals the face amount`; }
  else if (P.apMeasurement === "settlement_value") { ap = settle; apCalc = `${fmt(A.recipient, dest)} credited, valued ${rateNote}; company policy recognizes this bill at payment, so no realized FX arises`; }
  else {
    const c = i.review?.carryingAmount ? parseAmount(i.review.carryingAmount, F) : null;
    if (c == null || c <= 0n) j.missing.push(`booked AP carrying amount in ${F} for the ${fmt(A.recipient, dest)} settled (from your ledger)`);
    else {
      ap = c; apCalc = `Booked carrying amount for ${fmt(A.recipient, dest)} entered by ${i.review?.by ?? "a reviewer"}${i.review?.carryingSource ? ` (source: ${i.review.carryingSource})` : ""}`;
      const fx = settle - c;   // paid more in functional currency than booked = loss
      if (fx !== 0n) fxLine = { line: 0, side: fx > 0n ? "debit" : "credit", account: ch.fxGainLoss, amount: M(fx > 0n ? fx : -fx, F),
        description: `Realized FX ${fx > 0n ? "loss" : "gain"} on settling ${invoice.ref ?? "the invoice"}`,
        calculation: `Settlement value ${fmt(settle, F)} (${fmt(A.recipient, dest)} ${rateNote}) minus carrying amount ${fmt(c, F)}` };
    }
  }
  const L: Omit<JournalLine, "line">[] = [
    { side: "debit", account: ch.ap, amount: ap == null ? null : M(ap, F), description: `Settle ${invoice.ref ?? "supplier balance"} · ${i.request.supplier}`, calculation: ap == null ? "Carrying amount missing" : apCalc },
    ...(fxLine ? [fxLine] : []),
    { side: "debit", account: ch.bankFees, amount: M(A.fundingFee, F), description: "Transfer fee (funding)", calculation: `Provider ledger funding-fee posting: ${fmt(A.fundingFee, F)}` },
    ...(A.payoutFee > 0n ? [{ side: "debit" as const, account: ch.bankFees, amount: M(pfee, F), description: "Payout fee (deducted after conversion)", calculation: `${fmt(A.payoutFee, dest)} ${dest === F ? "" : rateNote}`.trim() }] : []),
    ...(A.rounding > 0n ? [{ side: "debit" as const, account: ch.bankFees, amount: M(rnd, F), description: "Conversion rounding kept by the provider", calculation: `${fmt(A.rounding, dest)} ${rateNote}` }] : []),
    { side: "credit", account: ch.cash, amount: M(A.sourceDebit, F), description: `Payment ${i.transfer?.transferId ?? ""} to ${i.request.supplier}`.trim(), calculation: `Provider ledger source-debit posting: ${fmt(A.sourceDebit, F)}` },
  ];
  j.lines = L.map((l, n) => ({ ...l, line: n + 1 }));
  if (j.lines.some((l) => !l.amount)) { j.status = "needs_review"; return j; }
  const tot = (s: string) => j.lines.filter((l) => l.side === s).reduce((a, l) => a + big(l.amount!.minor), 0n);
  const dr = tot("debit"), cr = tot("credit");
  j.totals = { debit: M(dr, F), credit: M(cr, F) }; j.balanced = dr === cr;
  if (!j.balanced) j.errors.push(`Debits ${fmt(dr, F)} do not equal credits ${fmt(cr, F)}.`);
  if (!P.configured) j.missing.push("chart-of-accounts mapping (the account codes shown are illustrative; an admin confirms them in Policy & people)");
  if (i.request.platformFee && Number(i.request.platformFee.split(" ")[0]) > 0)
    j.notes.push(`Route402's fee (${i.request.platformFee}) is billed separately and is not part of this entry.`);
  j.status = j.missing.length || j.errors.length || !j.balanced ? "needs_review" : "draft";
  return j;
}

/** One deterministic accounting record per payment request (id je_<request id>), whatever its status. */
export function buildRecord(i: BuildInput): AccountingRecord {
  const life = lifecycleOf(i), t = i.transfer, now = i.now ?? Date.now();
  const q = t ? quotedSide(t.terms) : null;
  const kids = i.children ?? [], srcCcy = q?.srcCcy ?? i.functionalCcy, destCcy = q?.destCcy ?? i.request.ccy;
  let A: Side | null = null, missing: string[] = [];
  if (t && kids.length && t.status !== "AWAITING_APPROVAL") { const x = actualSide(kids, srcCcy, destCcy); A = x.side; missing = x.missing;
    const expected = (t.executionPlan ?? t.terms)?.allocations?.length ?? kids.length;
    if (kids.length < expected) missing.push(`${expected - kids.length} of ${expected} payout legs not recorded`); }
  if (t && life === "settled" && i.children == null) missing.push("payout receipts (the payout service could not be read)");
  const settledAt = life === "settled" ? (t?.creditedAtUtc ?? null) : null;
  const bill = i.bill, rev = i.review ?? null;
  const invoice: AccountingRecord["source"]["invoice"] = bill ? { ref: bill.id, origin: "linked bill", amount: `${bill.amount} ${bill.ccy}`, dueUtc: bill.dueUtc ?? null, verified: false }
    : rev?.invoiceRef ? { ref: rev.invoiceRef, origin: "entered by reviewer", amount: null, dueUtc: null, verified: false } : { ref: null, origin: null, amount: null, dueUtc: null, verified: false };
  const repriced = !!t?.executionPlan && JSON.stringify(t.executionPlan.allocations?.map((a: any) => a.input)) !== JSON.stringify(t.terms?.allocations?.map((a: any) => a.input));
  const variance = computeVariance(q, A, { functionalCcy: i.functionalCcy, amountType: t?.terms?.intent?.amountType, platformFee: t?.value?.platformFee ?? i.request.platformFee, repriced, missing });
  const flags = flagsFor(variance, life, i.policy.variance, { arrivalUtc: (t?.executionPlan ?? t?.terms)?.totals?.arrivalUtc, now, missing, functionalCcy: i.functionalCcy });
  const prov = [...new Set(kids.map((k) => k.funding?.mode === "x402_testnet" ? "testnet funding leg; payout simulated" : "simulated provider ledger"))];
  return { id: `je_${i.request.id}`, requestId: i.request.id, transferId: t?.transferId ?? null, lifecycle: life, lifecycleLabel: LIFECYCLE_LABEL[life],
    provenance: prov.length ? prov.join(", ") : "no execution data",
    source: { supplier: i.request.supplier, reference: i.request.reference ?? null, invoice,
      payment: { requestedAmount: `${i.request.amount} ${i.request.ccy}`, route: i.request.route, preparedAt: i.request.preparedAt, settledAtUtc: settledAt,
        payoutIds: kids.map((k) => k.payoutId).filter(Boolean) as string[], evidence: kids.flatMap((k) => (k.ledger ?? []).map((e) => `${e.entryId} ${e.kind}`)) } },
    quoted: view(q), actual: A ? view(A) : null,
    observedFees: A && !missing.length && A.srcCcy === i.functionalCcy && A.converted > 0n ? M(A.fundingFee + srcValue(A, A.payoutFee), A.srcCcy) : null, variance, flags, journal: journalFor(i, life, A, missing, invoice, settledAt), review: rev };
}

// ------------------------------------------------------------------ aggregates
export type Period = "30d" | "mtd" | "all";
export function periodRange(p: Period, now: number): { from: string | null; to: string; label: string } {
  const to = new Date(now).toISOString();
  if (p === "all") return { from: null, to, label: "All time" };
  if (p === "mtd") { const d = new Date(now); const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); return { from, to, label: "Month to date (UTC)" }; }
  return { from: new Date(now - 30 * 864e5).toISOString(), to, label: "Last 30 days (UTC)" };
}
export function summarize(records: AccountingRecord[], p: Period, now: number, functionalCcy: string) {
  const R = periodRange(p, now), inP = (d: string | null) => !!d && (!R.from || d >= R.from) && d <= R.to;
  const settled = records.filter((r) => r.lifecycle === "settled" && inP(r.source.payment.settledAtUtc) && r.actual);
  const usdOnly = settled.filter((r) => r.actual!.sourceDebit.endsWith(` ${functionalCcy}`));
  const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n), minor = (s: string) => toMinor(s.split(" ")[0].replace("-", ""), functionalCcy) * (s.startsWith("-") ? -1n : 1n);
  const feeOf = (r: AccountingRecord) => big(r.observedFees?.minor);
  const comparable = usdOnly.filter((r) => r.variance.comparable);
  const variance = sum(comparable.map((r) => minor(r.variance.metrics.find((m) => m.key === "source")!.diff!)));
  const activity = records.filter((r) => inP(r.source.payment.settledAtUtc ?? r.source.payment.preparedAt));
  return { period: R, currency: functionalCcy,
    completed: { count: usdOnly.length, volume: fmt(sum(usdOnly.map((r) => minor(r.actual!.sourceDebit))), functionalCcy),
      basis: `Source debits recorded in the provider ledger for payments settled in the period, in ${functionalCcy}` },
    fees: { amount: fmt(sum(usdOnly.map(feeOf)), functionalCcy), basis: "Transfer fees plus payout fees valued at each payment's executed rate, from the provider ledger" },
    variance: { amount: fmt(variance, functionalCcy), comparable: comparable.length, of: usdOnly.length,
      basis: "Actual minus approved source debit, summed over settled payments with complete execution data (positive = paid more than quoted)" },
    flagged: { count: activity.filter((r) => r.flags.some((f) => f.severity === "review")).length, basis: "Payments prepared or settled in the period with at least one review flag" },
    awaitingReview: { count: settled.filter((r) => r.journal.status !== "approved").length, basis: "Settled payments in the period whose journal entry is not approved" },
    excluded: records.length - settled.length };
}

// ------------------------------------------------------------------ CSV export
const q = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
export const CSV_HEAD = ["entry_id", "entry_status", "line", "account_code", "account_name", "debit", "credit", "currency", "transaction_date", "accounting_date",
  "description", "calculation", "payment_request", "transfer", "payout_ids", "invoice_ref", "invoice_origin", "supplier", "provenance", "mapping"];
/** Validated records only: balanced entries that are ready for approval (draft) or approved. */
export function toCsv(records: AccountingRecord[]): string {
  const rows = records.filter((r) => r.journal.balanced && ["draft", "approved"].includes(r.journal.status)).flatMap((r) => r.journal.lines.map((l) => [
    r.id, r.journal.status, l.line, l.account.code, l.account.name, l.side === "debit" ? l.amount!.display.split(" ")[0] : "", l.side === "credit" ? l.amount!.display.split(" ")[0] : "",
    r.journal.currency, r.journal.transactionDate, r.journal.accountingDate, l.description, l.calculation, r.requestId, r.transferId, r.source.payment.payoutIds.join(" "),
    r.source.invoice.ref, r.source.invoice.origin, r.source.supplier, r.provenance, r.journal.mappingIllustrative ? "illustrative" : "configured"].map(q).join(",")));
  return [CSV_HEAD.join(","), ...rows].join("\n");
}
