// Deterministic company risk budgets, not issuer credit ratings or loss probabilities.
export interface AdaptiveExposurePolicy {
  enabled: boolean;
  issuerTreasuryPct: number;
  totalTreasuryPct: number;
  liquidityUsePct: number;
  baseHours: number;
}
export const DEFAULT_ADAPTIVE_EXPOSURE: AdaptiveExposurePolicy = {
  enabled: false, issuerTreasuryPct: 50, totalTreasuryPct: 75, liquidityUsePct: 80, baseHours: 24,
};
export function cleanAdaptiveExposure(value: unknown): AdaptiveExposurePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Adaptive exposure settings must be an object");
  const p = { ...DEFAULT_ADAPTIVE_EXPOSURE, ...value };
  if (typeof p.enabled !== "boolean") throw new Error("Adaptive exposure enabled must be true or false");
  for (const key of ["issuerTreasuryPct", "totalTreasuryPct", "liquidityUsePct"] as const)
    if (typeof p[key] !== "number" || !Number.isFinite(p[key]) || p[key] <= 0 || p[key] > 100) throw new Error(`${key} must be above 0 and at most 100`);
  if (p.issuerTreasuryPct > p.totalTreasuryPct) throw new Error("The issuer share cannot exceed the total stablecoin share");
  if (typeof p.baseHours !== "number" || !Number.isFinite(p.baseHours) || p.baseHours < 1 || p.baseHours > 168)
    throw new Error("The base exposure window must be between 1 and 168 hours");
  return p;
}
export interface ExposureLeg {
  issuer: string; issuers?: string[]; amountUsd: number; durationHours: number; capacityUsd?: number; liquidityKey?: string;
}
export interface ExposureContext {
  settings: AdaptiveExposurePolicy;
  treasuryUsd: number;
  hardCapsUsd: Record<string, number>;
  usedUsd: Record<string, number>;
  weightedUsedUsd: Record<string, number>;
  escrowHours?: number;
}
export const durationWeight = (hours: number, p: AdaptiveExposurePolicy) => Math.max(1, hours / p.baseHours);
export function assessExposure(context: ExposureContext, legs: ExposureLeg[]) {
  const { settings: p } = context;
  const per: Record<string, { amountUsd: number; weightedUsd: number; limitUsd: number }> = {};
  const venues: Record<string, { used: number; cap: number }> = {};
  let reason: string | undefined;
  for (const leg of legs) {
    if (![leg.amountUsd, leg.durationHours].every(Number.isFinite) || leg.amountUsd < 0 || leg.durationHours < 0) {
      reason = "Exposure could not be valued; request a fresh quote"; break;
    }
    // Conservatively budget every issuer touched by a swap, once per issuer (USDC->EURC is still just Circle).
    for (const issuer of new Set(leg.issuers ?? [leg.issuer])) {
      const limit = context.hardCapsUsd[issuer];
      if (!Number.isFinite(limit) || limit < 0) { reason = `No valid exposure ceiling for ${issuer}`; break; }
      const row = per[issuer] ??= { amountUsd: 0, weightedUsd: 0, limitUsd: p.enabled ? Math.min(limit, context.treasuryUsd * p.issuerTreasuryPct / 100) : limit };
      row.amountUsd += leg.amountUsd;
      row.weightedUsd += leg.amountUsd * (p.enabled ? durationWeight(Math.max(leg.durationHours, context.escrowHours ?? 0), p) : 1);
    }
    if (p.enabled && leg.liquidityKey && leg.capacityUsd !== undefined && Number.isFinite(leg.capacityUsd)) {
      const venue = venues[leg.liquidityKey] ??= { used: 0, cap: leg.capacityUsd * p.liquidityUsePct / 100 };
      venue.used += leg.amountUsd; venue.cap = Math.min(venue.cap, leg.capacityUsd * p.liquidityUsePct / 100);
    }
  }
  for (const [issuer, row] of Object.entries(per)) {
    if ((context.usedUsd[issuer] ?? 0) + row.amountUsd > context.hardCapsUsd[issuer] + 0.000001)
      reason ??= `${issuer} hard issuer ceiling has insufficient room`;
    if (p.enabled && (context.weightedUsedUsd[issuer] ?? 0) + row.weightedUsd > row.limitUsd + 0.000001)
      reason ??= `${issuer} adaptive exposure budget: settlement time and existing commitments exceed ${Math.floor(row.limitUsd).toLocaleString()} USD of budget`;
  }
  const weightedUsd = Object.values(per).reduce((s, x) => s + x.weightedUsd, 0);
  const totalLimitUsd = context.treasuryUsd * p.totalTreasuryPct / 100;
  if (p.enabled && Object.values(context.weightedUsedUsd).reduce((s, x) => s + x, 0) + weightedUsd > totalLimitUsd + 0.000001)
    reason ??= "Total stablecoin exposure budget is full; use another rail or wait for settlement";
  if (Object.values(venues).some((v) => v.used > v.cap + 0.000001)) reason ??= `Shared venue liquidity buffer: use at most ${p.liquidityUsePct}% of quoted depth`;
  return { ok: !reason, reason, enabled: p.enabled, perIssuer: per, weightedUsd, totalLimitUsd,
    explanation: p.enabled ? "Budget uses current treasury, committed exposure, expected settlement time and a liquidity buffer; issuer ceilings still apply." : "Fixed issuer ceilings apply." };
}
