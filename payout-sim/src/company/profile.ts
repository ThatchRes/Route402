// A company customer: its home currency, cost of cash, what its CURRENT bank charges (the savings baseline),
// and how we price. Savings are always measured against the company's own bank, never a generic number.
export interface CompanyProfile {
  companyId: string; name: string; homeCcy: string; costOfCashPct: number;
  currentBank: { label: string; fxMarkupBps: number; wireFeeUsd: number; businessDays: number; returnFeeUsd: number; measured?: boolean };
  // measured: FX markup per corridor comes from measured bank pricing (router/market.ts); fxMarkupBps is the fallback.
  // A real customer replaces this with the rate from their own bank statements (measured: false, fxMarkupBps: <theirs>).
  entities?: { id: string; functionalCcy: string }[];          // >1 entity unlocks netting + pooling
  pricing: { feeBpsOfRailVolume: number };                      // our fee: bps of the amount sent on our stablecoin rail, capped at half the payment's saving
}

export const DEMO_COMPANY: CompanyProfile = {
  companyId: "acme-imports", name: "Acme Imports Inc.", homeCcy: "USD", costOfCashPct: 6.0,
  // FX markup: measured big-bank pricing per corridor (Wise comparison data). Wire fee: median US outgoing international
  // wire fee, $45 (NerdWallet survey of bank fee schedules). A failed payment is valued as re-sending that wire.
  // A real customer replaces these with the numbers on its own bank's fee schedule.
  currentBank: { label: "Your bank (US big-bank pricing, measured)", fxMarkupBps: 120, wireFeeUsd: 45, businessDays: 2, returnFeeUsd: 45, measured: true },
  pricing: { feeBpsOfRailVolume: 15 },                          // 0.15%, never more than half the measured saving; bank payments and treasury suggestions free
};
