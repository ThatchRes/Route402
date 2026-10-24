// Offline checks: exact money for any currency, balanced ledger, quote math in both modes. No network.
import assert from "node:assert/strict";
import { toMinor, fmt, convert, requiredInput, listCurrencies, decimals } from "./money.js";
import { assertBalanced, line } from "./ledger.js";
import { SCENARIOS, quoteFor, validateInput } from "./scenarios.js";
const t = (n: string, f: () => void) => { f(); console.log("PASS", n); };
const q = (id: string) => quoteFor(SCENARIOS[id].input, id);

t("every ISO currency resolves a precision", () => { const all = listCurrencies(); assert.ok(all.length > 150); all.forEach((c) => decimals(c.code)); });
t("JPY 0, KWD/BHD 3, CLF 4 decimals", () => { assert.equal(decimals("JPY"), 0); assert.equal(decimals("KWD"), 3); assert.equal(decimals("BHD"), 3); assert.equal(decimals("CLF"), 4); });
t("rejects too many decimals", () => assert.throws(() => toMinor("1.234", "USD")));
t("rejects unknown currency", () => assert.throws(() => toMinor("1", "XYZ")));
t("FX rounds down, residual reported", () => { const r = convert(toMinor("50125.00", "USD"), "USD", "EUR", "0.9215");
  assert.equal(fmt(r.minor, "EUR"), "46190.18 EUR"); assert.match(r.residual, /rounded down/); });
t("requiredInput is minimal and sufficient", () => { const x = requiredInput(toMinor("68523.00", "CAD"), "USDC", "CAD", "1.3650");
  assert.ok(convert(x, "USDC", "CAD", "1.3650").minor >= toMinor("68523.00", "CAD")); assert.ok(convert(x - 1n, "USDC", "CAD", "1.3650").minor < toMinor("68523.00", "CAD")); });
t("unbalanced entry refused", () => assert.throws(() => assertBalanced([line("USD", "a", -100n), line("USD", "b", 99n)])));
t("cross-asset entry must balance per asset", () => assert.throws(() => assertBalanced([line("USD", "a", -100n), line("CAD", "b", 100n)])));
t("USD->CAD stablecoin quote", () => { const x = q("usd_cad_stablecoin"); assert.equal(x.funding.display, "50200.000000 USDC");
  assert.equal(x.converted.display, "68523.00 CAD"); assert.equal(x.recipientNet.display, "68500.00 CAD"); assert.equal(x.funding.viaX402, true); });
t("recipient-fixed delivers the exact amount", () => { const x = q("usd_cad_recipient_fixed"); assert.equal(x.recipientNet.display, "68500.00 CAD");
  assert.equal(BigInt(x.converted.minor) - BigInt(x.payoutFee.minor) - BigInt(x.roundingSurplus.minor), BigInt(x.recipientNet.minor)); });
t("USD->JPY zero-decimal", () => assert.equal(q("usd_jpy_stablecoin").recipientNet.display, "7648674 JPY"));
t("USD->KWD three-decimal", () => assert.equal(q("usd_kwd_stablecoin").recipientNet.display, "15416.170 KWD"));
t("USD->BRL", () => assert.equal(q("usd_brl_stablecoin").recipientNet.display, "272679.42 BRL"));
t("EUR->MXN via EURC", () => assert.equal(q("eur_mxn_eurc").funding.ccy, "EURC"));
t("bank route has no token and no x402", () => { const x = q("usd_eur_bank"); assert.equal(x.funding.ccy, "USD"); assert.equal(x.funding.viaX402, false); });
t("CAD->USD reverse", () => assert.equal(q("cad_usd_reverse").recipientNet.display, "50042.53 USD"));
t("custom pair needs explicit rate", () => assert.ok(validateInput({ route: "bank", srcCcy: "GBP", destCcy: "INR", amountType: "SOURCE_FIXED",
  amount: "1000.00", fxRate: "", fundingFee: "1.00", payoutFee: "10.00" }).some((e) => e.includes("fxRate"))));
t("custom GBP->INR works with inputs", () => assert.equal(quoteFor({ route: "bank", srcCcy: "GBP", destCcy: "INR", amountType: "SOURCE_FIXED",
  amount: "1000.00", fxRate: "106.25", fundingFee: "1.00", payoutFee: "10.00" }).recipientNet.display, "106133.75 INR"));
t("custom recipient-fixed KRW via USDC", () => assert.equal(quoteFor({ route: "stablecoin", srcCcy: "USD", destCcy: "KRW", amountType: "RECIPIENT_FIXED",
  amount: "1000000", fundingAsset: "USDC", onrampRate: "1.000000", fxRate: "1385.5", fundingFee: "2.00", payoutFee: "1000" }).recipientNet.display, "1000000 KRW"));
console.log("all checks passed");
