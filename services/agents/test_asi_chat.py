"""ASI transport controls using fake storage and backend, no network or payments."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from asi_chat import AsiChatAdapter, is_end_session
from chat_format import format_answer


class Storage:
    def __init__(self):
        self.rows = {}

    def get(self, key):
        return self.rows.get(key)

    def set(self, key, value):
        self.rows[key] = value


class AsiChatTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.context = {"linked": True, "conversationId": "fetch_context_one"}
        self.backend = SimpleNamespace(**{name: AsyncMock(return_value={}) for name in (
            "asi_context", "asi_link", "asi_offer", "asi_cancel", "asi_confirm", "asi_status", "asi_disconnect")})
        self.backend.asi_context.side_effect = lambda *args: self.context
        self.backend.asi_link.return_value = {"linkUrl": "http://localhost:8404/asi/link#" + "a" * 64}
        self.backend.asi_cancel.return_value = {"message": "Proposal closed"}
        self.backend.asi_offer.return_value = {"confirmationId": "offer_one", "confirmation": "Reply yes to accept.",
            "details": [{"intentId": "int_one", "youPay": "500.00 USD", "recipientGets": "450.00 EUR", "supplier": "Muller"}]}
        self.backend.asi_confirm.return_value = {"message": "Acceptance recorded", "requests": [{"id": "pr_one", "supplier": "Muller", "status": "EXECUTING"}]}
        self.backend.asi_status.return_value = {"message": "Current payment", "requests": [{"status": "COMPLETED", "supplier": "Muller"}]}
        self.concierge = AsyncMock(return_value={"status": "ok", "conversationId": "fetch_context_one", "policy": "cheapest",
            "decisions": [{"intentId": "int_one", "payable": "bill_one", "decision": "approve", "chosen": "bank"}]})
        self.ctx = SimpleNamespace(storage=Storage())
        self.adapter = AsiChatAdapter(self.backend, self.concierge, format_answer, "demo-tenant")
        self.sender, self.session = "agent1" + "a" * 40, "session-one"

    async def say(self, text, msg_id="one", session=None):
        return await self.adapter.handle(self.ctx, self.sender, session or self.session, msg_id, text)

    async def plan(self):
        reply = await self.say("pay Muller 500")
        self.context["pending"] = {"id": "offer_one", "state": "ready"}
        return reply

    async def test_unlinked_user_only_gets_pairing_not_company_data_or_quotes(self):
        self.context = {"linked": False}
        reply = await self.say("pay Muller 500")
        self.assertIn("Connect your Route402 account", reply)
        self.concierge.assert_not_called()
        self.backend.asi_offer.assert_not_called()
        self.backend.asi_confirm.assert_not_called()

    async def test_link_acceptance_resumes_original_request_but_does_not_execute_it(self):
        self.context = {"linked": False}
        await self.say("pay Muller 500")
        self.context = {"linked": True, "conversationId": "fetch_context_one"}
        reply = await self.say("yes", "two")
        self.assertIn("500.00 USD", reply)
        self.assertIn("Reply yes", reply)
        self.backend.asi_confirm.assert_not_called()
        self.assertEqual(self.concierge.call_args.args[3], "pay Muller 500")

    async def test_plan_uses_scoped_conversation_and_verified_selected_quote(self):
        reply = await self.plan()
        self.assertIn("500.00 USD", reply)
        self.assertEqual(self.concierge.call_args.kwargs["conversation_id"], "fetch_context_one")
        self.backend.asi_cancel.assert_awaited_once()
        self.backend.asi_confirm.assert_not_called()

    async def test_explicit_yes_passes_only_offered_confirmation_id(self):
        await self.plan()
        reply = await self.say("Yes please!", "two")
        self.assertIn("Acceptance recorded", reply)
        self.assertIn("Processing", reply)
        self.assertEqual(self.backend.asi_confirm.call_args.args[-1], "offer_one")

    async def test_duplicate_delivery_and_concurrent_yes_do_not_multiply_actions(self):
        await self.plan()
        replies = await asyncio.gather(self.say("yes", "same-yes"), self.say("yes", "same-yes"))
        self.assertEqual(replies[0], replies[1])
        self.backend.asi_confirm.assert_awaited_once()

    async def test_confirmation_without_a_displayed_review_cannot_execute(self):
        self.context["pending"] = {"id": "created-elsewhere", "state": "ready"}
        self.assertIn("no payment review", await self.say("yes"))
        self.backend.asi_confirm.assert_not_called()

    async def test_different_chat_session_does_not_inherit_offered_authority(self):
        await self.plan()
        self.assertIn("no payment review", await self.say("yes", "two", session="session-two"))
        self.backend.asi_confirm.assert_not_called()

    async def test_new_preference_invalidates_prior_confirmation_before_replan(self):
        await self.plan()
        self.concierge.return_value = {"status": "clarification", "clarification": "Which supplier?"}
        await self.say("I prefer cheapest", "two")
        self.assertEqual(self.backend.asi_cancel.await_count, 2)
        self.assertIn("no payment review", await self.say("yes", "three"))
        self.backend.asi_confirm.assert_not_called()

    async def test_cancel_and_status_do_not_buy_more_quotes(self):
        await self.plan()
        self.assertIn("Completed", await self.say("status", "two"))
        self.assertIn("closed", await self.say("cancel", "three"))
        self.assertEqual(self.concierge.await_count, 1)
        self.backend.asi_confirm.assert_not_called()

    async def test_offer_rejection_never_presents_acceptance_or_executes(self):
        self.backend.asi_offer.side_effect = RuntimeError("stale quote bearer secret")
        reply = await self.say("pay Muller 500")
        self.assertIn("cannot currently be accepted", reply)
        self.assertNotIn("bearer secret", reply)
        self.assertIn("no payment review", await self.say("yes", "two"))
        self.backend.asi_confirm.assert_not_called()

    async def test_unknown_confirmation_is_not_retried_on_redelivery(self):
        await self.plan()
        self.backend.asi_confirm.side_effect = TimeoutError("private transport failure")
        first = await self.say("yes", "two")
        again = await self.say("yes", "two")
        self.assertEqual(first, again)
        self.assertIn("not be retried automatically", first)
        self.backend.asi_confirm.assert_awaited_once()

    async def test_quoted_or_conditional_yes_is_not_an_authorization(self):
        await self.plan()
        self.concierge.return_value = {"status": "ok", "preview": {"message": "Tell me what you want to change."}}
        for i, text in enumerate(("what if I say yes", 'the invoice says "yes"', "yes but increase it to 1000")):
            await self.say(text, str(i + 2))
        self.backend.asi_confirm.assert_not_called()

    async def test_only_explicit_end_closes_session_and_revokes_chat(self):
        self.assertFalse(is_end_session("yes"))
        self.assertFalse(is_end_session("pay Muller 500"))
        self.assertTrue(is_end_session("end chat"))
        self.assertIn("disconnected", await self.say("end chat"))
        self.backend.asi_disconnect.assert_awaited_once()

    async def test_status_does_not_follow_arbitrary_transfer_ids(self):
        await self.say("status tr_someone_else")
        self.backend.asi_status.assert_awaited_once()
        self.assertEqual(len(self.backend.asi_status.call_args.args), 4)
        self.concierge.assert_not_called()


if __name__ == "__main__":
    unittest.main()
