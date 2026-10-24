"""Offline ASI:One contract, prompt-boundary and shared-gateway tests."""
import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx
import context_llm as llm


class ContextLlmTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.context = {"eligible": True, "snapshotToken": "PRIVATE-SNAPSHOT", "message": "Keep as much cash as possible",
                        "history": [{"user": "pay 5000 to Example", "responseType": "send_to", "reply": "Payment preview"}],
                        "state": {"taskKind": "send", "hasAmount": True},
                        "candidates": [{"id": "prefer_cheapest", "description": "Lowest cost"}, {"id": "status", "description": "Status"}]}
        llm._calls.clear(); llm._retry_after = 0; llm._slots = asyncio.Semaphore(4)
        self.enabled = patch.object(llm, "ENABLED", True); self.enabled.start(); self.addCleanup(self.enabled.stop)
        self.key = patch.object(llm, "KEY", "test-key-not-real"); self.key.start(); self.addCleanup(self.key.stop)
        self.model = patch.object(llm, "MODEL", "asi1-mini"); self.model.start(); self.addCleanup(self.model.stop)
        self.requests = []

    async def call(self, content='{"choice":"prefer_cheapest"}', status=200, **message_fields):
        def handler(request):
            self.requests.append(request)
            return httpx.Response(status, json={"choices": [{"finish_reason": "stop", "message": {"content": content, **message_fields}}],
                                               "usage": {"prompt_tokens": 30, "completion_tokens": 6}})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch.object(llm.httpx, "AsyncClient", return_value=client):
            return await llm.choose(self.context)

    async def test_official_api_contract_has_no_tools_or_identity(self):
        self.context.update(serviceToken="DO-NOT-SEND", bank={"accountNumber": "DO-NOT-SEND"})
        self.assertEqual(await self.call(), "prefer_cheapest")
        req = self.requests[0]; body = json.loads(req.content)
        self.assertEqual(str(req.url), "https://api.asi1.ai/v1/chat/completions")
        self.assertFalse(body["planner_mode"]); self.assertNotIn("tools", body); self.assertNotIn("web_search_options", body)
        self.assertEqual(body["messages"][0]["role"], "system")
        self.assertNotIn("DO-NOT-SEND", req.content.decode()); self.assertNotIn("PRIVATE-SNAPSHOT", req.content.decode())
        self.assertTrue(body["response_format"]["json_schema"]["strict"])

    async def test_unknown_fields_values_and_prose_rejected(self):
        for content in ['{"choice":"execute"}', '{"choice":"prefer_cheapest","amount":9000}', '```json\n{}\n```', 'yes', 'null', '["prefer_cheapest"]']:
            llm._retry_after = 0
            with self.subTest(content=content): self.assertIsNone(await self.call(content))

    async def test_tool_calls_never_executed(self):
        self.assertIsNone(await self.call(tool_calls=[{"function": {"name": "execute", "arguments": "{}"}}]))

    async def test_unsafe_context_does_not_call_api(self):
        self.context["eligible"] = False
        self.assertIsNone(await self.call()); self.assertEqual(self.requests, [])

    async def test_disabled_and_oversized_requests_do_not_call_api(self):
        with patch.object(llm, "ENABLED", False): self.assertIsNone(await self.call())
        self.context["message"] = "a" * 15000
        self.assertIsNone(await self.call()); self.assertEqual(self.requests, [])

    async def test_api_errors_cool_down_and_fall_back(self):
        self.assertIsNone(await self.call(status=429))
        self.assertIsNone(await self.call()); self.assertEqual(len(self.requests), 1)

    async def test_timeouts_fall_back(self):
        def handler(request): raise httpx.ReadTimeout("private upstream error")
        with patch.object(llm.httpx, "AsyncClient", return_value=httpx.AsyncClient(transport=httpx.MockTransport(handler))):
            self.assertIsNone(await llm.choose(self.context))

    async def test_malformed_envelopes_and_truncated_answers_fall_back(self):
        for response in [[], {"choices": None}, {"choices": [None]},
                         {"choices": [{"finish_reason": "length", "message": {"content": '{"choice":"status"}'}}]},
                         {"choices": [{"finish_reason": "stop", "message": "not an object"}]}]:
            llm._retry_after = 0
            with patch.object(llm.httpx, "AsyncClient", return_value=httpx.AsyncClient(
                transport=httpx.MockTransport(lambda request: httpx.Response(200, json=response)))):
                self.assertIsNone(await llm.choose(self.context))

    async def test_global_rate_limit(self):
        for _ in range(20): await self.call()
        self.assertIsNone(await self.call()); self.assertEqual(len(self.requests), 20)

    async def test_recognized_turn_never_calls_model_or_adapter(self):
        backend = AsyncMock(); original = {"template": "send_to", "intent": {"amount": "5000"}}
        with patch.object(llm, "choose", AsyncMock()) as choose:
            self.assertIs(await llm.understand(backend, "tenant", "corr", original), original)
            choose.assert_not_called(); backend.assistant_understanding.assert_not_called()

    async def test_context_and_choice_are_bound_to_original_revision(self):
        backend = AsyncMock(); updated = {"template": "routing_preference", "policy": "cheapest"}
        backend.assistant_understanding.side_effect = [self.context, updated]
        original = {"template": "out_of_scope", "conversationId": "conversation-123", "conversationRevision": 3}
        with patch.object(llm, "choose", AsyncMock(return_value="prefer_cheapest")):
            self.assertIs(await llm.understand(backend, "tenant", "corr", original), updated)
        backend.assistant_understanding.assert_awaited_with("tenant", "corr", "conversation-123", 3,
                                                           choice="prefer_cheapest", snapshot_token="PRIVATE-SNAPSHOT")

    async def test_ambiguity_clarifies_without_applying_or_paying(self):
        backend = AsyncMock(); backend.assistant_understanding.return_value = self.context
        original = {"template": "out_of_scope", "conversationId": "conversation-123", "conversationRevision": 3}
        with patch.object(llm, "choose", AsyncMock(return_value="clarify")):
            result = await llm.understand(backend, "tenant", "corr", original)
        self.assertIn("clarification", result); self.assertEqual(backend.assistant_understanding.await_count, 1)


if __name__ == "__main__": unittest.main()
