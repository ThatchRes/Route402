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
    minRecipientNetMinor: toMinor(decision.totals.recipientNet.split(" ")[0], intent.destCcy).toString(),
    deadlineUtc: intent.deadlineUtc ?? null,
    // A selected split leg may be ineligible for the WHOLE payment but valid at its allocated amount.
    // Never discard those legs when enabling backups (which previously left only the bank wire).
    allowedRouteIds: allowReroute ? [...new Set([decision, ...alternatives.map((a) => a.decision)].flatMap((d) =>
      [...(d.allocations ?? []).map((a: any) => a.routeId), ...(d.candidates ?? []).filter((c: any) => c.eligible).map((c: any) => c.routeId)]))]
      : decision.allocations.map((a: any) => a.routeId) };
}

export function providerForAllocations(allocations: { routeId: string }[]): string {
  return allocations.some((a) => a.routeId.startsWith("coin:")) ? "stablecoin"
    : allocations.some((a) => a.routeId.startsWith("tokenized:")) ? "tokenized_deposit" : "bank";
}

/** Validate the actual refreshed decision, including a second refresh after an earlier feasibility check. */
export function validateDispatchDecision(terms: any, decision: any): { ok: boolean; code?: string; reason?: string; decision?: any } {
  const policy = terms.executionPolicy ?? executionPolicy(terms.intent, {
    totals: terms.totals, allocations: terms.allocations, candidates: [] });
  if (decision.status !== "OK") return { ok: false, code: "DEADLINE_UNACHIEVABLE", reason: decision.reason ?? String(decision.missing) };
  if (!decision.allocations?.length || decision.allocations.some((a: any) => !policy.allowedRouteIds.includes(a.routeId)))
    return { ok: false, code: "REAPPROVAL_REQUIRED", reason: "the refreshed plan contains a route that was not reviewed" };
  const debit = toMinor(decision.totals.sourceDebit.split(" ")[0], terms.intent.srcCcy);
  if (debit > BigInt(policy.maxSourceDebitMinor)) return { ok: false, code: "REAPPROVAL_REQUIRED", reason: `current price ${decision.totals.sourceDebit} exceeds the approved debit cap` };
  // A fixed source budget can stay unchanged while a worse FX route cuts the supplier's proceeds.
  // Backups must preserve both sides of the reviewed quote, including for existing signed policies.
  const minimum = policy.minRecipientNetMinor ?? toMinor(terms.totals.recipientNet.split(" ")[0], terms.intent.destCcy).toString();
  if (toMinor(decision.totals.recipientNet.split(" ")[0], terms.intent.destCcy) < BigInt(minimum))
    return { ok: false, code: "REAPPROVAL_REQUIRED", reason: `current route would deliver ${decision.totals.recipientNet}, less than the reviewed ${terms.totals.recipientNet}` };
  if (policy.deadlineUtc && Date.parse(decision.totals.arrivalUtc) > Date.parse(policy.deadlineUtc))
    return { ok: false, code: "DEADLINE_UNACHIEVABLE", reason: "the refreshed route misses the approved recipient deadline" };
  if (!policy.allowReroute) {
    const same = decision.allocations.length === terms.allocations.length && decision.allocations.every((a: any, i: number) =>
      a.routeId === terms.allocations[i].routeId && a.quote.input.amount === terms.allocations[i].input.amount);
    if (!same) return { ok: false, code: "REAPPROVAL_REQUIRED", reason: "the approved route or allocation is no longer available" };
  }
  return { ok: true, decision };
}

export function planForDispatch(terms: any, nowUtc: string, currentBudget: Partial<Intent> = {}) {
  const policy = terms.executionPolicy ?? executionPolicy(terms.intent, {
    totals: terms.totals, allocations: terms.allocations, candidates: [] });
  const run = (allowedRouteIds: string[], provider: any) =>
    validateDispatchDecision(terms, optimize({ ...terms.intent, ...currentBudget, provider, nowUtc, allowedRouteIds }));
  // The reviewed routes first: a backup that merely ties on the objective must never replace the approved route.
  const reviewed = run(reviewedRouteIds(terms), terms.intent.provider);
  return reviewed.ok || !policy.allowReroute ? reviewed : run(policy.allowedRouteIds, undefined);
}

export const reviewedRouteIds = (terms: any): string[] => [...new Set<string>((terms.allocations ?? []).map((a: any) => String(a.routeId)))];
