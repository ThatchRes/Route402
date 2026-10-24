"""Offline agent policy checks. No agents, wallet, providers or network calls are started."""
import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch

import backend
import reasoning


def quote(provider, cost=100, arrival="2026-10-26T18:00:00Z"):
    return {"status": "OK", "providerLabel": provider, "intentId": "intent_" + provider,
            "plan": {"arrivalUtc": arrival, "allocations": [{"routeId": provider + ":test", "x402Executable": False}]},
            "costVsMidBps": {"plan": cost, "bank": 120}, "risk": {"score": 1},
            "timing": {"deadlineUtc": "2026-10-27T20:00:00Z", "latestStartUtc": "2026-10-27T16:00:00Z"}}


class DeadlinePolicyTests(unittest.TestCase):
    def choose(self, quotes, screen="PASS", policy="cheapest"):
        return reasoning.choose_route(quotes, {"status": screen}, policy, {"maxCostBps": 150}, deadline_utc="2026-10-27T20:00:00Z")

    def test_late_cheap_route_cannot_beat_timely_route(self):
        result = self.choose({"bank": quote("bank", 20, "2026-10-28T17:00:00Z"), "stablecoin": quote("stablecoin", 120)})
        self.assertEqual(result["chosen"], "stablecoin")
        self.assertFalse(result["options"][0]["eligible"])

    def test_over_budget_timely_route_requires_cost_review(self):
        result = self.choose({"bank": quote("bank", 151)})
        self.assertEqual(result["decision"], "review")
        self.assertEqual(result["intentId"], "intent_bank")
        self.assertIn("cost", result["needs"][0])
        self.assertFalse(result["detailsChanged"])

    def test_late_over_budget_quote_is_not_reviewable(self):
        result = self.choose({"bank": quote("bank", 151, "2026-10-28T17:00:00Z")})
        self.assertEqual(result["decision"], "hold")
        self.assertIsNone(result["intentId"])

    def test_fastest_can_cost_more_than_a_slower_bank_within_cap(self):
        result = self.choose({"bank": quote("bank", 90), "stablecoin": quote("stablecoin", 140, "2026-10-25T18:00:00Z")}, policy="fastest")
        self.assertEqual(result["chosen"], "stablecoin")

    def test_failed_screen_stays_blocked_even_when_route_is_timely(self):
        self.assertEqual(self.choose({"bank": quote("bank")}, screen="BLOCK")["decision"], "hold")

    def test_bank_detail_review_still_requires_callback(self):
        result = self.choose({"bank": quote("bank")}, screen="REVIEW")
        self.assertEqual(result["decision"], "review")
        self.assertTrue(result["detailsChanged"])
        self.assertIn("call-back", result["needs"][0])

    def test_no_quote_reports_specific_reason(self):
        result = self.choose({"bank": {"status": "NO_QUOTE", "reason": "arrives after deadline"}})
        self.assertEqual(result["decision"], "hold")
        self.assertIn("after deadline", " ".join(result["reasons"]))

    def test_local_tools_call_router_and_return_zero_payment_evidence(self):
        tool = AsyncMock(return_value=quote("bank"))
        with patch.dict(os.environ, {"LOCAL_ROUTING": "1"}), patch.object(backend, "_call", tool):
            result = asyncio.run(backend.paid_call("quote:bank", {"amount": "100"}, "test-local", "routing-agent"))
        self.assertEqual(tool.call_args.args[2], "/v1/provider-quote")
        self.assertEqual(result["data"]["intentId"], "intent_bank")
        self.assertEqual(result["payment"]["priceUsdc"], "0")
        self.assertNotIn("transaction", result["payment"])


if __name__ == "__main__":
    unittest.main()
