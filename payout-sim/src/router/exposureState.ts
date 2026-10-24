import { issuerCapFor, loadPolicy, loadRequests, type Policy } from "../company/controls.js";
import { load } from "./store.js";
import { MID_PER_USD } from "./registry.js";
import { STABLECOINS } from "./compliance.js";
import { quoteFor } from "../scenarios.js";
import { cleanAdaptiveExposure, DEFAULT_ADAPTIVE_EXPOSURE, durationWeight, type ExposureContext, type ExposureLeg } from "./exposure.js";

export function debitUsd(display: string): number {
  const [amount, ccy = "USD"] = String(display).split(" "), rate = ccy === "USD" ? 1 : Number(MID_PER_USD[ccy]);
  if (!Number.isFinite(Number(amount)) || Number(amount) < 0 || !Number.isFinite(rate) || rate <= 0) throw new Error("Cannot value exposure in USD");
  return Number(amount) / rate;
}
export function exposureLeg(a: any, fallbackHours = 24): ExposureLeg | null {
  const route = String(a.routeId ?? ""); if (!route.startsWith("coin:")) return null;
  const coins = route.split(":")[1].split(">"), issuers = [...new Set(coins.map((coin) => STABLECOINS[coin]?.issuer ?? coin))];
  return { ...a.exposure, issuer: issuers[0], issuers,
    amountUsd: debitUsd(a.quote?.sourceDebit?.display ?? a.sourceDebit ?? (a.input ? quoteFor(a.input, "exposure").sourceDebit.display : "NaN USD")),
    durationHours: a.exposure?.durationHours ?? fallbackHours };
}

/** Scheduled and unresolved transfers keep their budgets. A UI request and its transfer are counted once. */
export function exposureContext(p: Policy = loadPolicy(), excludeRequestId?: string, excludeTransferId?: string, escrowHours = 0): ExposureContext {
  const db = load(), requests = Object.values(loadRequests());
  const settings = cleanAdaptiveExposure(p.adaptiveExposure ?? DEFAULT_ADAPTIVE_EXPOSURE);
  const usedUsd: Record<string, number> = {}, weightedUsedUsd: Record<string, number> = {};
  const excludedRequest = requests.find((r) => r.id === excludeRequestId);
  const excludedTransfer = db.transfers[excludeTransferId ?? ""];
  const activeTransfers = Object.values(db.transfers).filter((t: any) => ["SCHEDULED", "EXECUTING", "NEEDS_RECONCILIATION", "PARTIAL"].includes(t.status));
  const add = (allocations: any[], hours: number) => {
    for (const a of allocations) {
      const leg = exposureLeg(a, hours); if (!leg) continue;
      for (const issuer of leg.issuers ?? [leg.issuer]) {
        usedUsd[issuer] = (usedUsd[issuer] ?? 0) + leg.amountUsd;
        weightedUsedUsd[issuer] = (weightedUsedUsd[issuer] ?? 0) + leg.amountUsd * durationWeight(Math.max(hours, leg.durationHours), settings);
      }
    }
  };
  for (const t of activeTransfers) {
    if (t.transferId === excludeTransferId || t.intentId === excludedRequest?.intentId) continue;
    add((t.executionPlan ?? t.terms)?.allocations ?? [], settings.baseHours);
  }
  for (const r of requests) {
    if (r.id === excludeRequestId || (r.transferId === excludeTransferId && !!excludeTransferId) || r.intentId === excludedTransfer?.intentId) continue;
    if (activeTransfers.some((t: any) => t.transferId === r.transferId || t.intentId === r.intentId)) continue;
    const locked = ["LOCKED", "LOCKING"].includes(r.escrow?.state ?? "");
    if (!locked && !["READY", "EXECUTING"].includes(r.status)) continue;
    if (!locked && r.transferId && ["COMPLETED", "PAUSED"].includes(db.transfers[r.transferId]?.status)) continue;
    const d = db.intents[r.intentId]?.decision;
    const hours = locked ? Math.max(settings.baseHours, (Date.parse(r.escrow!.deadline) - Date.parse(r.preparedAt)) / 3600e3 || p.escrowDeadlineDays * 24) : settings.baseHours;
    add(d?.allocations?.length ? d.allocations : [{ routeId: r.route, sourceDebit: `${r.debitUsd} USD` }], hours);
  }
  const treasuryUsd = Math.max(0, Number(process.env.TREASURY_USD ?? "2000000") - Number(db.spentUsdMinor ?? "0") / 100);
  if (!Number.isFinite(treasuryUsd)) throw new Error("No valid confirmed treasury balance for exposure budgeting");
  const hardCapsUsd = Object.fromEntries([...new Set(Object.values(STABLECOINS).map((x) => x.issuer))].map((iss) => [iss, issuerCapFor(p, iss)]));
  return { settings, treasuryUsd, hardCapsUsd, usedUsd, weightedUsedUsd, escrowHours };
}
