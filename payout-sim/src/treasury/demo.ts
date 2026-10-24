// Demo data for a multinational group (synthetic).
import type { NettingInput } from "./netting.js";
import type { SweepInput } from "./sweeps.js";
import type { Rule, State } from "./rules.js";

export const DEMO_NETTING: NettingInput = { centreCcy: "USD", nowUtc: "2026-10-26T14:00:00Z",
  entities: [{ id: "US-HQ", functionalCcy: "USD" }, { id: "CA-Sub", functionalCcy: "CAD" }, { id: "DE-GmbH", functionalCcy: "EUR" },
             { id: "UK-Ltd", functionalCcy: "GBP" }, { id: "MX-SA", functionalCcy: "MXN" }, { id: "SG-Pte", functionalCcy: "SGD" }],
  invoices: [
    { id: "IC-001", from: "CA-Sub", to: "US-HQ", ccy: "USD", amount: "1200000.00" }, { id: "IC-002", from: "US-HQ", to: "CA-Sub", ccy: "CAD", amount: "1500000.00" },
    { id: "IC-003", from: "DE-GmbH", to: "US-HQ", ccy: "USD", amount: "900000.00" }, { id: "IC-004", from: "US-HQ", to: "DE-GmbH", ccy: "EUR", amount: "700000.00" },
    { id: "IC-005", from: "UK-Ltd", to: "DE-GmbH", ccy: "EUR", amount: "400000.00" }, { id: "IC-006", from: "DE-GmbH", to: "UK-Ltd", ccy: "GBP", amount: "300000.00" },
    { id: "IC-007", from: "MX-SA", to: "US-HQ", ccy: "USD", amount: "650000.00" }, { id: "IC-008", from: "US-HQ", to: "MX-SA", ccy: "MXN", amount: "9000000.00" },
    { id: "IC-009", from: "SG-Pte", to: "UK-Ltd", ccy: "GBP", amount: "250000.00" }, { id: "IC-010", from: "UK-Ltd", to: "SG-Pte", ccy: "SGD", amount: "500000.00" },
    { id: "IC-011", from: "CA-Sub", to: "MX-SA", ccy: "MXN", amount: "4000000.00" }, { id: "IC-012", from: "MX-SA", to: "CA-Sub", ccy: "CAD", amount: "300000.00" }] };

export const DEMO_SWEEPS: SweepInput = { days: 365, sweepFeeMinorPerTransfer: { USD: "0.50", EUR: "0.40", CAD: "0.50" },
  accounts: [
    { id: "US-HQ-header", entity: "US-HQ", bank: "Bank A", ccy: "USD", balance: "4200000.00", target: "0", creditRatePct: 3.8, debitRatePct: 8.5, isHeader: true, pool: "group-usd" },
    { id: "US-Ops", entity: "US-HQ", bank: "Bank B", ccy: "USD", balance: "1800000.00", target: "250000.00", creditRatePct: 0.5, debitRatePct: 9.0, pool: "group-usd" },
    { id: "US-Payroll", entity: "US-HQ", bank: "Bank C", ccy: "USD", balance: "-600000.00", target: "100000.00", creditRatePct: 0.25, debitRatePct: 11.0, pool: "group-usd" },
    { id: "DE-header", entity: "DE-GmbH", bank: "Bank D", ccy: "EUR", balance: "900000.00", target: "0", creditRatePct: 2.0, debitRatePct: 6.0, isHeader: true, pool: "group-eur" },
    { id: "DE-Sales", entity: "DE-GmbH", bank: "Bank E", ccy: "EUR", balance: "1300000.00", target: "150000.00", creditRatePct: 0.0, debitRatePct: 7.0, pool: "group-eur" },
    { id: "DE-Plant", entity: "DE-GmbH", bank: "Bank E", ccy: "EUR", balance: "-450000.00", target: "50000.00", creditRatePct: 0.0, debitRatePct: 7.5, pool: "group-eur" }] };

export const DEMO_RULES: Rule[] = [
  { id: "R1-sweep-ops", description: "Sweep US-Ops above 250k to the header every evening", trigger: { kind: "balance_above", account: "US-Ops", threshold: "300000.00" },
    action: { kind: "sweep_excess", to: "US-HQ-header", keep: "250000.00" }, limits: { mandateMax: "5000000.00", ccy: "USD", dailyLimit: "10000000.00" } },
  { id: "R2-fund-payroll", description: "Top up payroll to 100k when it goes below 50k", trigger: { kind: "balance_below", account: "US-Payroll", threshold: "50000.00" },
    action: { kind: "top_up", from: "US-HQ-header", upTo: "100000.00" }, limits: { mandateMax: "1000000.00", ccy: "USD" } },
  { id: "R3-pay-due-invoices", description: "Pay approved supplier invoices due within 2 days via the optimizer", trigger: { kind: "invoice_approved", dueWithinDays: 2 },
    action: { kind: "pay_invoice", objective: "balanced" }, limits: { mandateMax: "250000.00", ccy: "USD", dailyLimit: "1000000.00" } },
  { id: "R4-eur-window", description: "Convert 2M USD to EUR this week at best quote, floor 1,845,000 EUR, must execute by Friday", trigger: { kind: "conversion_window", src: "USD", dest: "EUR",
      amount: "2000000.00", notBeforeUtc: "2026-10-26T00:00:00Z", mustExecuteByUtc: "2026-10-30T20:00:00Z", minRecipient: "1845000.00" },
    action: { kind: "convert" }, limits: { mandateMax: "2500000.00", ccy: "USD" } },
  { id: "R5-pay-on-delivery", description: "Release escrowed supplier payment only when goods delivered AND invoice matches PO", trigger: { kind: "conditional_release",
      invoiceId: "INV-9001", requires: ["delivery_confirmed", "invoice_matched"], expiresUtc: "2026-11-15T00:00:00Z" },
    action: { kind: "release_escrow" }, limits: { mandateMax: "500000.00", ccy: "USD" } },
  { id: "R6-pay-on-delivery-2", description: "Same for INV-9002", trigger: { kind: "conditional_release",
      invoiceId: "INV-9002", requires: ["delivery_confirmed", "invoice_matched"], expiresUtc: "2026-11-15T00:00:00Z" },
    action: { kind: "release_escrow" }, limits: { mandateMax: "500000.00", ccy: "USD" } },
];

export const DEMO_STATE: State = { nowUtc: "2026-10-26T14:00:00Z",
  balances: { "US-Ops": { ccy: "USD", amount: "1800000.00" }, "US-Payroll": { ccy: "USD", amount: "-600000.00" } },
  invoices: [
    { id: "INV-7001", payeeCcy: "CAD", payerCcy: "USD", amount: "180000.00", dueUtc: "2026-10-27T20:00:00Z", approved: true },
    { id: "INV-7002", payeeCcy: "MXN", payerCcy: "USD", amount: "6500000.00", dueUtc: "2026-10-28T20:00:00Z", approved: true },
    { id: "INV-7003", payeeCcy: "EUR", payerCcy: "USD", amount: "90000.00", dueUtc: "2026-11-20T20:00:00Z", approved: true },
    { id: "INV-9001", payeeCcy: "USD", payerCcy: "USD", amount: "320000.00", dueUtc: "2026-11-10T20:00:00Z", approved: true },
    { id: "INV-9002", payeeCcy: "USD", payerCcy: "USD", amount: "210000.00", dueUtc: "2026-11-10T20:00:00Z", approved: true }],
  events: { "INV-9001": ["delivery_confirmed", "invoice_matched"], "INV-9002": ["delivery_confirmed"] }, executedToday: {} };
