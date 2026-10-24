"""Conversation transport through the real Fetch.ai concierge function; tools are mocked and never paid."""
import asyncio
import importlib
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


class ConciergeContextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cwd = os.getcwd()
        cls.directory = tempfile.TemporaryDirectory(prefix="route402-agent-context-")
        os.chdir(cls.directory.name)
        for key in ("GATEWAY", "ROUTING", "INVESTIGATION", "LIQUIDITY", "EXECUTOR", "RECONCILIATION"):
            os.environ[key + "_SEED"] = "local-context-test-" + key
        os.environ["ENABLE_CHAT"] = "0"
        os.environ["ANTHROPIC_API_KEY"] = ""
        cls.gateway = importlib.import_module("gateway")

    @classmethod
    def tearDownClass(cls):
        os.chdir(cls.cwd)
        cls.directory.cleanup()

    def test_models_keep_conversation_fields(self):
        from models import AskBody
        request = AskBody(tenantId="demo-tenant", correlationId="context-test", serviceToken="test", text="make it 500",
                          conversationId="conversation-test", conversationRevision=3)
        self.assertEqual(request.conversationId, "conversation-test")
        self.assertEqual(request.conversationRevision, 3)

    def test_listing_forwards_context_and_does_not_dispatch_paid_tools(self):
        preview = {"template": "list_suppliers", "suppliers": [], "company": {},
                   "conversationId": "conversation-test", "conversationRevision": 4}
        ctx = MagicMock()
        with patch.object(self.gateway.backend, "assistant_ask", AsyncMock(return_value=preview)) as ask:
            result = asyncio.run(self.gateway.concierge_ask(ctx, "demo-tenant", "test-list", "which companies use MXN", None, "conversation-test", 3))
        self.assertEqual(ask.call_args.args[-2:], ("conversation-test", 3))
        self.assertEqual(result.conversationRevision, 4)
        self.assertEqual(result.paidCalls, [])
        ctx.send_and_receive.assert_not_called()

    def test_clarification_preserves_the_server_context(self):
        preview = {"template": "send_to", "clarification": "How much?", "conversationId": "conversation-test", "conversationRevision": 5}
        with patch.object(self.gateway.backend, "assistant_ask", AsyncMock(return_value=preview)):
            result = asyncio.run(self.gateway.concierge_ask(MagicMock(), "demo-tenant", "test-clarify", "pay them"))
        self.assertEqual(result.status, "clarification")
        self.assertEqual(result.conversationRevision, 5)
        self.assertEqual(result.preview, preview)

    def test_unrelated_request_never_buys_quotes(self):
        preview = {"template": "out_of_scope", "message": "Business payments only", "company": {}, "conversationId": "conversation-test", "conversationRevision": 6}
        ctx = MagicMock()
        with patch.object(self.gateway.backend, "assistant_ask", AsyncMock(return_value=preview)):
            result = asyncio.run(self.gateway.concierge_ask(ctx, "demo-tenant", "test-scope", "write a poem"))
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.template, "out_of_scope")
        self.assertEqual(result.paidCalls, [])
        ctx.send_and_receive.assert_not_called()

    def test_payment_reference_and_review_are_linked_back_to_the_conversation(self):
        preview = {"template": "send_to", "beneficiary": {"name": "Example supplier"}, "paymentRef": "chat_operation_test",
                   "intent": {"destCcy": "MXN", "amount": "500.00"}, "company": {}, "conversationId": "conversation-test", "conversationRevision": 7}
        decisions = [{"payable": "chat_operation_test", "decision": "hold", "reasons": ["deadline unavailable"]}]
        with patch.object(self.gateway.backend, "assistant_ask", AsyncMock(return_value=preview)), \
             patch.object(self.gateway, "run_review", AsyncMock(return_value=(decisions, [], []))) as review, \
             patch.object(self.gateway.backend, "record_assistant_review", AsyncMock(return_value={"recorded": True})) as record:
            result = asyncio.run(self.gateway.concierge_ask(MagicMock(), "demo-tenant", "test-review", "make it 500"))
        self.assertEqual(review.call_args.args[5][0]["reference"], "chat_operation_test")
        self.assertEqual(record.call_args.args[-3:], ("conversation-test", 7, decisions))
        self.assertEqual(result.conversationRevision, 7)


if __name__ == "__main__":
    unittest.main()
