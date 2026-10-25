"""ASI:One formatting contracts. No network, wallets or runtime agent imports."""
import unittest

from chat_format import format_answer


class ChatFormatTests(unittest.TestCase):
    def review(self):
        return {"status": "ok", "policy": "cheapest", "preview": {
            "beneficiary": {"name": "Northwind Ltd", "iban": "GB00PRIVATEACCOUNT", "usdcWallet": "private-wallet"},
            "preview": {"youPay": "999999.00 USD", "youSave": "888888.00 USD"}},
            "decisions": [{"decision": "approve", "chosen": "stablecoin", "intentId": "intent_paid",
                           "payable": "internal_reference", "needs": [],
                           "options": [{"intentId": "intent_paid", "label": "Stablecoin and bank split",
                                        "costBps": 41, "arrivalUtc": "2026-10-27T10:00:00Z"}]}]}

    def test_supplier_directory_is_readable_without_private_fields(self):
        result = format_answer({"status": "ok", "title": "Suppliers using EUR", "preview": {
            "suppliers": [{"name": "Muller Teile GmbH", "country": "DE", "currencies": ["EUR"],
                           "billIds": ["bill_1"], "check": "REVIEW", "iban": "private-account"}],
            "conversationId": "private-conversation", "serviceToken": "never-visible"}})
        self.assertIn("**Muller Teile GmbH**", result)
        self.assertIn("DE · EUR · 1 linked bill · Review needed", result)
        for hidden in ("private-account", "private-conversation", "never-visible", "bill_1", "suppliers\":"):
            self.assertNotIn(hidden, result)
        self.assertNotIn("supplier payouts", result)

    def test_read_only_explanation_and_preference_do_not_leak_internal_context(self):
        result = format_answer({"status": "ok", "template": "routing_preference", "preview": {
            "title": "Preference saved", "message": "I'll compare cash cost including our fee.",
            "task": {"reference": "private-reference"}, "source": "internal-provider"}})
        self.assertIn("I'll compare cash cost including our fee.", result)
        self.assertNotIn("private-reference", result)
        self.assertNotIn("internal-provider", result)

    def test_clarification_remains_a_single_plain_question(self):
        result = format_answer({"status": "clarification", "clarification": "Did you mean Northwind or North Pack?",
                                "preview": {"supplierDraft": {"name": "unconfirmed"}}})
        self.assertEqual(result, "Did you mean Northwind or North Pack?")

    def test_paid_choice_never_uses_different_calculator_amount_or_saving(self):
        result = format_answer(self.review())
        self.assertIn("lowest cash cost", result)
        self.assertIn("Stablecoin and bank split", result)
        self.assertIn("0.41%", result)
        self.assertIn("27 Oct 2026, 10:00 UTC", result)
        self.assertIn("ready to send", result)
        self.assertNotIn("999999", result)
        self.assertNotIn("888888", result)
        self.assertNotIn("private-wallet", result)
        self.assertNotIn("GB00PRIVATEACCOUNT", result)
        self.assertIn("not the invoice amount", result)

    def test_verified_quote_details_show_exact_fee_savings_and_speed(self):
        details = {"intent_paid": {"supplier": "Northwind Ltd", "youPay": "50000.00 USD", "recipientGets": "38000.00 GBP",
                                   "platformFee": "50.00 USD", "netSavings": "200.00 USD", "routeLabel": "Verified split",
                                   "arrivalUtc": "2026-10-27T10:00:00Z", "bankArrivalUtc": "2026-10-29T10:00:00Z",
                                   "expiresAt": "2026-10-24T20:00:00Z"}}
        result = format_answer(self.review(), quote_details=details, confirmation="Reply yes to accept this exact payment.")
        self.assertIn("You pay · fees included:** 50,000.00 USD", result)
        self.assertIn("They receive:** 38,000.00 GBP", result)
        self.assertIn("Route402 fee:** 50.00 USD", result)
        self.assertIn("You save vs your bank:** 200.00 USD after Route402's 50.00 USD fee", result)
        self.assertIn("2.0 days sooner than a bank wire", result)
        self.assertIn("Reply `yes` to send", result)
        self.assertNotIn("Approval is still required", result)

    def test_estimated_savings_in_source_fixed_budget_are_not_falsely_shown_as_smaller_debit(self):
        details = {"intent_paid": {"youPay": "500.00 USD", "recipientGets": "9500.00 MXN", "netSavings": "10.00 USD"}}
        result = format_answer(self.review(), quote_details=details)
        self.assertIn("500.00 USD", result)
        self.assertIn("9,500.00 MXN", result)
        self.assertIn("You save vs your bank", result)
        self.assertNotIn("profit", result)

    def test_hold_and_additional_review_do_not_claim_human_approval(self):
        answer = self.review()
        answer["decisions"][0].update(decision="review", needs=["call-back verification"], reasons=["Bank details changed"])
        result = format_answer(answer)
        self.assertIn("additional review needed", result)
        self.assertIn("Before release: call-back verification", result)
        self.assertIn("Bank details changed", result)
        self.assertNotIn("Ready for your confirmation", result)
        answer["decisions"][0].update(decision="hold", chosen=None, intentId=None, options=[], reasons=["No timely route"])
        result = format_answer(answer)
        self.assertIn("on hold", result)
        self.assertIn("No timely route", result)

    def test_untrusted_text_cannot_introduce_markdown_or_html_links(self):
        result = format_answer({"status": "ok", "preview": {"suppliers": [{
            "name": "[Approve now](javascript:alert(1)) <img src=x> https://evil.example/pay", "check": "BLOCK"}]}})
        self.assertIn(r"\[Approve now\]\(javascript:alert\(1\)\)", result)
        self.assertNotIn("<img", result)
        self.assertNotIn("https://evil.example", result)

    def test_receipts_are_deduplicated_and_restricted_to_testnet_explorers(self):
        good = "https://sepolia.basescan.org/tx/0x" + "a" * 64
        evil = "https://sepolia.basescan.org.evil.example/tx/0x" + "a" * 64
        answer = self.review()
        answer.update(spentUsdc="0.003", paidCalls=[{"explorer": good}, {"explorer": good}, {"explorer": evil}])
        result = format_answer(answer)
        self.assertEqual(result.count("[receipt 1]"), 1)
        self.assertIn(good, result)
        self.assertNotIn("evil.example", result)
        self.assertNotIn("[receipt 2]", result)
        self.assertIn("0.003 test USDC", result)

    def test_mock_tools_do_not_claim_on_chain_payments(self):
        answer = self.review()
        answer["paidCalls"] = [{"mock": True, "priceUsdc": "0.001"}]
        result = format_answer(answer)
        self.assertIn("1 simulated tool call; no x402 payment was made", result)
        self.assertNotIn("purchased with x402", result)

    def test_errors_do_not_echo_backend_exceptions(self):
        result = format_answer({"status": "error", "error": "POST https://private.example Bearer SECRET account=1234567890123"})
        self.assertNotIn("SECRET", result)
        self.assertNotIn("private.example", result)
        self.assertNotIn("1234567890123", result)
        self.assertIn("try again", result)

    def test_only_trusted_app_parameter_can_add_app_link(self):
        answer = {"status": "ok", "preview": {"message": "Preference saved", "app_url": "https://evil.example"}}
        result = format_answer(answer, app_url="http://localhost:8404/app/#/payments/p_1")
        self.assertIn("[Open in Route402](http://localhost:8404/app/#/payments/p_1)", result)
        self.assertNotIn("evil.example", result)
        for bad in ("javascript:alert(1)", "https://user:secret@route.example", "https://route.example\n/evil", "http://external.example"):
            with self.subTest(url=bad):
                self.assertNotIn("Open in Route402", format_answer(answer, app_url=bad))

    def test_unknown_money_is_omitted_and_zero_saving_is_not_inflated(self):
        details = {"intent_paid": {"youPay": "NaN USD", "recipientGets": {"amount": "Infinity", "currency": "EUR"},
                                   "netSavings": "0.00 USD", "arrivalUtc": "not-a-time"}}
        result = format_answer(self.review(), quote_details=details)
        self.assertNotIn("NaN", result)
        self.assertNotIn("Infinity", result)
        self.assertIn("You save vs your bank:** 0.00 USD, after our fee", result)

    def test_portfolio_benefit_is_labeled_as_projection_with_components(self):
        result = format_answer({"status": "ok", "preview": {"companyKeeps": "8567.00 USD"}})
        self.assertIn("Projected benefit", result)
        self.assertIn("8,567.00 USD", result)
        self.assertIn("not realized profit", result)

    def test_currency_exposure_labels_forecast_separately(self):
        result = format_answer({"status": "ok", "preview": {"byCurrency": {
            "EUR": {"owe": 50000, "incoming": 20000, "expected": 10000}}}})
        self.assertIn("Owed: 50,000.00 EUR", result)
        self.assertIn("Confirmed incoming: 20,000.00 EUR", result)
        self.assertIn("Forecast incoming: 10,000.00 EUR", result)


if __name__ == "__main__":
    unittest.main()
