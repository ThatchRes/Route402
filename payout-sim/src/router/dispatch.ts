import { optimize, type Intent } from "./optimizer.js";
import { toMinor } from "../money.js";

// This policy is included in termsHash. Refreshing prices never edits the signed terms.
export function executionPolicy(intent: Intent, decision: any, allowReroute = false, alternatives: any[] = []) {
  for (const alternative of alternatives) {
    const other = alternative.intent;
    const same = ["srcCcy", "destCcy", "amountType", "amount", "deadlineUtc", "deadlineBufferMinutes", "reference"].every((key) => (intent as any)[key] === other?.[key])
      && JSON.stringify(intent.beneficiary ?? null) === JSON.stringify(other?.beneficiary ?? null);
    if (!same || alternative.decision?.status !== "OK") throw new Error("fallback quote must be for the same amount, supplier, currency and recipient deadline");
  }
  return { allowReroute, maxSourceDebitMinor: toMinor(decision.totals.sourceDebit.split(" ")[0], intent.srcCcy).toString(),
    deadlineUtc: intent.deadlineUtc ?? null,
    allowedRouteIds: allowReroute ? [...new Set([decision, ...alternatives.map((a) => a.decision)].flatMap((d) => d.candidates.filter((c: any) => c.eligible).map((c: any) => c.routeId)))]
      : decision.allocations.map((a: any) => a.routeId) };
}

export function planForDispatch(terms: any, nowUtc: string, currentBudget: Partial<Intent> = {}): { ok: boolean; code?: string; reason?: string; decision?: any } {
  const policy = terms.executionPolicy ?? executionPolicy(terms.intent, {
    totals: terms.totals, allocations: terms.allocations, candidates: [] });
  const decision: any = optimize({ ...terms.intent, ...currentBudget, provider: policy.allowReroute ? undefined : terms.intent.provider, nowUtc, allowedRouteIds: policy.allowedRouteIds });
  if (decision.status !== "OK") return { ok: false, code: "DEADLINE_UNACHIEVABLE", reason: decision.reason ?? String(decision.missing) };
  const debit = toMinor(decision.totals.sourceDebit.split(" ")[0], terms.intent.srcCcy);
  if (debit > BigInt(policy.maxSourceDebitMinor)) return { ok: false, code: "REAPPROVAL_REQUIRED", reason: `current price ${decision.totals.sourceDebit} exceeds the approved debit cap` };
  if (!policy.allowReroute) {
    const same = decision.allocations.length === terms.allocations.length && decision.allocations.every((a: any, i: number) =>
      a.routeId === terms.allocations[i].routeId && a.quote.input.amount === terms.allocations[i].input.amount);
    if (!same) return { ok: false, code: "REAPPROVAL_REQUIRED", reason: "the approved route or allocation is no longer available" };
  }
  return { ok: true, decision };
}
