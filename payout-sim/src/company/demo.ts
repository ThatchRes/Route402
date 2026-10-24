import type { HedgeInput } from "./hedge.js";
import type { DiscountInput } from "./discounts.js";
import type { Beneficiary } from "./validate.js";

export const DEMO_HEDGE: HedgeInput = { homeCcy: "USD", nowUtc: "2026-10-26T14:00:00Z", holdSurplus: false,
  receivables: [
    { id: "AR-EU-1", ccy: "EUR", amount: "420000.00", dateUtc: "2026-10-27T10:00:00Z", status: "confirmed" },
    { id: "AR-EU-2", ccy: "EUR", amount: "310000.00", dateUtc: "2026-11-03T10:00:00Z", status: "confirmed" },
    { id: "AR-EU-3", ccy: "EUR", amount: "150000.00", dateUtc: "2026-11-05T10:00:00Z", status: "expected" },
    { id: "AR-CA-1", ccy: "CAD", amount: "600000.00", dateUtc: "2026-10-28T10:00:00Z", status: "confirmed" },
    { id: "AR-MX-1", ccy: "MXN", amount: "2500000.00", dateUtc: "2026-10-29T10:00:00Z", status: "confirmed" }],
  payables: [
    { id: "AP-EU-1", ccy: "EUR", amount: "380000.00", dateUtc: "2026-10-30T10:00:00Z" },
    { id: "AP-EU-2", ccy: "EUR", amount: "290000.00", dateUtc: "2026-11-06T10:00:00Z" },
    { id: "AP-CA-1", ccy: "CAD", amount: "450000.00", dateUtc: "2026-10-27T12:00:00Z" },
    { id: "AP-CA-2", ccy: "CAD", amount: "200000.00", dateUtc: "2026-11-02T12:00:00Z" },
    { id: "AP-MX-1", ccy: "MXN", amount: "3800000.00", dateUtc: "2026-11-04T12:00:00Z" },
    { id: "AP-SG-1", ccy: "SGD", amount: "120000.00", dateUtc: "2026-11-01T12:00:00Z" }] };

export const DEMO_DISCOUNTS: DiscountInput = { costOfCashPct: 6.0, nowUtc: "2026-10-26T14:00:00Z", payables: [
  { id: "INV-A (2/10 net 30)", ccy: "USD", amount: "250000.00", invoiceUtc: "2026-10-24T00:00:00Z", discountPct: 2, discountByUtc: "2026-11-03T00:00:00Z", dueUtc: "2026-11-23T00:00:00Z" },
  { id: "INV-B (1/10 net 30)", ccy: "USD", amount: "400000.00", invoiceUtc: "2026-10-25T00:00:00Z", discountPct: 1, discountByUtc: "2026-11-04T00:00:00Z", dueUtc: "2026-11-24T00:00:00Z" },
  { id: "INV-C (0.25/10 net 30)", ccy: "USD", amount: "300000.00", invoiceUtc: "2026-10-25T00:00:00Z", discountPct: 0.25, discountByUtc: "2026-11-04T00:00:00Z", dueUtc: "2026-11-24T00:00:00Z" },
  { id: "INV-D (net 45)", ccy: "USD", amount: "180000.00", invoiceUtc: "2026-10-20T00:00:00Z", dueUtc: "2026-12-04T00:00:00Z" }] };

export const DEMO_BENEFICIARIES: Beneficiary[] = [
  { id: "DE supplier", name: "Muller Teile GmbH", country: "DE", currency: "EUR", iban: "DE89 3704 0044 0532 0130 00", swift: "COBADEFFXXX" },
  { id: "DE supplier (typo)", name: "Muller Teile GmbH", country: "DE", currency: "EUR", iban: "DE89 3704 0044 0532 0130 01", swift: "COBADEFFXXX" },
  { id: "GB vendor", name: "Northwind Ltd", country: "GB", currency: "GBP", iban: "GB82 WEST 1234 5698 7654 32", swift: "NWBKGB2L" },
  { id: "MX supplier paid in EUR", name: "Proveedora SA", country: "MX", currency: "EUR", swift: "BNMXMXMM", accountNumber: "012180012345678909" },
  { id: "US contractor", name: "J. Rivera", country: "US", currency: "USD", accountNumber: "123456789", routing: "011000015" },
  { id: "US contractor (bad routing)", name: "A. Chen", country: "US", currency: "USD", accountNumber: "987654321", routing: "011000016" }];

import type { PaymentRunInput } from "./paymentRun.js";
import { DEMO_COMPANY } from "./profile.js";
const B = (id: string, country: string, currency: string, extra: any = {}) => ({ id, name: id, country, currency, ...extra });
export const DEMO_RUN: PaymentRunInput = { company: DEMO_COMPANY, nowUtc: "2026-10-26T14:00:00Z",
  payables: [
    { id: "AP-DE-Muller", beneficiary: B("Muller Teile GmbH", "DE", "EUR", { iban: "DE89 3704 0044 0532 0130 00" }), ccy: "EUR", amount: "380000.00", dueUtc: "2026-10-30T20:00:00Z" },
    { id: "AP-DE-Klein", beneficiary: B("Klein Logistik", "DE", "EUR", { iban: "DE89 3704 0044 0532 0130 00" }), ccy: "EUR", amount: "290000.00", dueUtc: "2026-11-24T20:00:00Z", discountPct: 2, discountByUtc: "2026-11-04T20:00:00Z" },
    { id: "AP-DE-typo", beneficiary: B("Bauer AG", "DE", "EUR", { iban: "DE89 3704 0044 0532 0130 01" }), ccy: "EUR", amount: "45000.00", dueUtc: "2026-11-02T20:00:00Z" },
    { id: "AP-CA-Maple", beneficiary: B("Maple Freight", "CA", "CAD", { accountNumber: "0031234512345678" }), ccy: "CAD", amount: "450000.00", dueUtc: "2026-10-27T20:00:00Z" },
    { id: "AP-CA-North", beneficiary: B("North Pack Co", "CA", "CAD", { accountNumber: "0040987654321" }), ccy: "CAD", amount: "200000.00", dueUtc: "2026-11-02T20:00:00Z" },
    { id: "AP-MX-Proveedora", beneficiary: B("Proveedora SA", "MX", "MXN", { accountNumber: "012180012345678909" }), ccy: "MXN", amount: "3800000.00", dueUtc: "2026-11-04T20:00:00Z", discountPct: 1, discountByUtc: "2026-10-28T20:00:00Z" },
    { id: "AP-SG-Lion", beneficiary: B("Lion Components", "SG", "SGD", { accountNumber: "1234567890", swift: "DBSSSGSG" }), ccy: "SGD", amount: "120000.00", dueUtc: "2026-11-01T20:00:00Z" },
    { id: "AP-GB-Northwind", beneficiary: B("Northwind Ltd", "GB", "GBP", { iban: "GB82 WEST 1234 5698 7654 32" }), ccy: "GBP", amount: "85000.00", dueUtc: "2026-11-03T20:00:00Z" },
    { id: "AP-US-contractor", beneficiary: B("A. Chen", "US", "USD", { routing: "011000016", accountNumber: "987654321" }), ccy: "USD", amount: "12000.00", dueUtc: "2026-10-31T20:00:00Z" },
    // USD-invoiced suppliers abroad (common in Asian trade). One accepts USDC (wallet on file), one is bank-only.
    { id: "AP-VN-Saigon", beneficiary: B("Saigon Textile Co", "VN", "USD", { accountNumber: "0071000123456", swift: "BFTVVNVX", usdcWallet: "0x8Ba1f109551bD432803012645Ac136ddd64DBA72" }), ccy: "USD", amount: "180000.00", dueUtc: "2026-10-29T20:00:00Z" },
    { id: "AP-CN-Rongda", beneficiary: B("Shenzhen Rongda Electronics", "CN", "USD", { accountNumber: "4563518800123", swift: "BKCHCNBJ" }), ccy: "USD", amount: "95000.00", dueUtc: "2026-10-30T20:00:00Z" }],
  receivables: [
    { id: "AR-EU-1", ccy: "EUR", amount: "420000.00", dateUtc: "2026-10-27T10:00:00Z", status: "confirmed" },
    { id: "AR-EU-2", ccy: "EUR", amount: "310000.00", dateUtc: "2026-11-03T10:00:00Z", status: "confirmed" },
    { id: "AR-EU-3", ccy: "EUR", amount: "150000.00", dateUtc: "2026-11-05T10:00:00Z", status: "expected" },
    { id: "AR-CA-1", ccy: "CAD", amount: "600000.00", dateUtc: "2026-10-28T10:00:00Z", status: "confirmed" },
    { id: "AR-MX-1", ccy: "MXN", amount: "2500000.00", dateUtc: "2026-10-27T10:00:00Z", status: "confirmed" }] };
