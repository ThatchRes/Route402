// A company customer: its home currency, cost of cash, what its CURRENT bank charges (the savings baseline),
// and how we price. Savings are always measured against the company's own bank, never a generic number.
export interface CompanyProfile {
  companyId: string; name: string; homeCcy: string; costOfCashPct: number;
  currentBank: { label: string; fxMarkupBps: number; wireFeeUsd: number; businessDays: number; returnFeeUsd: number; measured?: boolean };
  // measured: FX markup per corridor comes from measured bank pricing (router/market.ts); fxMarkupBps is the fallback.
  // A real customer replaces this with the rate from their own bank statements (measured: false, fxMarkupBps: <theirs>).
  entities?: { id: string; functionalCcy: string }[];          // >1 entity unlocks netting + pooling
  pricing: { flatFeeBps: number };                              // our fee: flat share of converted volume (bps)
}

export const DEMO_COMPANY: CompanyProfile = {
  companyId: "acme-imports", name: "Acme Imports Inc.", homeCcy: "USD", costOfCashPct: 6.0,
  // FX markup: measured big-bank pricing per corridor (Wise comparison data). Wire and return fees: demo fee schedule.
  currentBank: { label: "Your bank (US big-bank pricing, measured)", fxMarkupBps: 120, wireFeeUsd: 35, businessDays: 2, returnFeeUsd: 50, measured: true },
  pricing: { flatFeeBps: 15 },                                  // 0.15% of the volume we convert; treasury suggestions are free
};
