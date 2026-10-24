// A company customer: its home currency, cost of cash, what its CURRENT bank charges (the savings baseline),
// and how we price. Savings are always measured against the company's own bank, never a generic number.
export interface CompanyProfile {
  companyId: string; name: string; homeCcy: string; costOfCashPct: number;
  currentBank: { label: string; fxMarkupBps: number; wireFeeUsd: number; businessDays: number; returnFeeUsd: number };
  entities?: { id: string; functionalCcy: string }[];          // >1 entity unlocks netting + pooling
  pricing: { savingsSharePct: number };                         // our fee: share of measured savings
}

export const DEMO_COMPANY: CompanyProfile = {
  companyId: "acme-imports", name: "Acme Imports Inc.", homeCcy: "USD", costOfCashPct: 6.0,
  // Taken from the company's own bank statements in a real onboarding (here: a typical mid-market bank deal)
  currentBank: { label: "First National", fxMarkupBps: 120, wireFeeUsd: 35, businessDays: 2, returnFeeUsd: 50 },
  pricing: { savingsSharePct: 20 },
};
