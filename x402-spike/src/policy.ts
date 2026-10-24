// Pure checks, unit-tested by `npm run selftest`. Nothing here signs or sends anything.
import { getAddress } from "viem";
import type { Attempt } from "./store.js";

export interface Expected { network: string; asset: string; amountAtomic: bigint; payTo: string; maxTimeoutSeconds: number }

/** Validate the seller's 402 requirements BEFORE signing. Returns the matching option or a list of errors. */
export function checkRequirements(accepts: any[], exp: Expected): { ok: true; option: any } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const opts = (accepts ?? []).filter((a) => a?.network === exp.network);
  if (!opts.length) return { ok: false, errors: [`no payment option on approved network ${exp.network}`] };
  for (const a of opts) {
    const e: string[] = [];
    if (a.scheme !== "exact") e.push(`scheme ${a.scheme} not approved`);
    try { if (getAddress(a.asset) !== getAddress(exp.asset)) e.push(`token ${a.asset} is not approved USDC`); }
    catch { e.push(`token ${a.asset} invalid`); }
    if (BigInt(a.amount ?? a.maxAmountRequired ?? -1) !== exp.amountAtomic) e.push(`amount ${a.amount} != approved ${exp.amountAtomic}`);
    try { if (getAddress(a.payTo) !== getAddress(exp.payTo)) e.push(`payTo ${a.payTo} is not the approved receiver`); }
    catch { e.push(`payTo ${a.payTo} invalid`); }
    if (Number(a.maxTimeoutSeconds ?? 0) > exp.maxTimeoutSeconds) e.push(`authorization lifetime ${a.maxTimeoutSeconds}s too long`);
    if (!e.length) return { ok: true, option: a };
    errors.push(...e);
  }
  return { ok: false, errors };
}

/** One funding attempt per order unless a prior attempt was reconciled as NOT settled. */
export function canStartAttempt(attempts: Attempt[], orderId: string): { ok: boolean; reason?: string } {
  const mine = attempts.filter((a) => a.orderId === orderId);
  if (mine.some((a) => a.status === "SETTLED" || a.status === "RECONCILED_SETTLED")) return { ok: false, reason: "order already funded" };
  if (mine.some((a) => a.status === "SUBMITTED" || a.status === "UNKNOWN")) return { ok: false, reason: "previous attempt outcome unknown: run `npm run reconcile` first" };
  return { ok: true };
}

/** Cumulative cap counts settled AND unknown attempts (unknown may have moved money). */
export function withinCap(attempts: Attempt[], next: bigint, cap: bigint): boolean {
  const spent = attempts
    .filter((a) => ["SUBMITTED", "SETTLED", "UNKNOWN", "RECONCILED_SETTLED"].includes(a.status))
    .reduce((s, a) => s + BigInt(a.amountAtomic), 0n);
  return spent + next <= cap;
}
