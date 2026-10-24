"""Exercise the actual protocol handler without starting agents or a mailbox."""
import importlib.util
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4


class ChatProtocolTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="route402-chat-protocol-")
        cls.cwd = os.getcwd()
        os.chdir(cls.directory.name)
        env = {key + "_SEED": "offline-chat-protocol-" + key for key in (
            "GATEWAY", "ROUTING", "INVESTIGATION", "LIQUIDITY", "EXECUTOR", "RECONCILIATION")}
        env.update(ENABLE_CHAT="1", ANTHROPIC_API_KEY="", AGENTVERSE_API_KEY="")
        from uagents import Agent
        original_include = Agent.include
        def offline_include(agent, protocol, **kwargs):
            # Keep handler registration, but never schedule Almanac publication from a test import.
            return original_include(agent, protocol, **{**kwargs, "publish_manifest": False})
        with patch.dict(os.environ, env), patch.object(Agent, "include", offline_include):
            file = Path(__file__).with_name("gateway.py")
            spec = importlib.util.spec_from_file_location("_chat_protocol_gateway", file)
            cls.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.module)

    @classmethod
    def tearDownClass(cls):
        loop = cls.module.gateway._loop
        if not loop.is_running() and not loop.is_closed():
            loop.close()
        os.chdir(cls.cwd)
        cls.directory.cleanup()

    async def test_actual_handler_acks_and_keeps_normal_reply_session_open(self):
        m = self.module
        ctx = SimpleNamespace(send=AsyncMock(), session=uuid4())
        msg = m.ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(), content=[m.TextContent(type="text", text="yes")])
        with patch.object(m.chat_adapter, "handle", AsyncMock(return_value="Acceptance recorded")) as handle:
            await m.on_chat(ctx, "agent1" + "a" * 55, msg)
        ack, reply = [call.args[1] for call in ctx.send.await_args_list]
        self.assertIsInstance(ack, m.ChatAcknowledgement)
        self.assertEqual(ack.acknowledged_msg_id, msg.msg_id)
        self.assertIsInstance(reply, m.ChatMessage)
        self.assertEqual(reply.content[0].text, "Acceptance recorded")
        self.assertFalse(any(isinstance(c, m.EndSessionContent) for c in reply.content))
        self.assertEqual(handle.call_args.args[2], str(ctx.session))

    async def test_only_explicit_end_adds_end_session_content(self):
        m = self.module
        ctx = SimpleNamespace(send=AsyncMock(), session=uuid4())
        msg = m.ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(), content=[m.TextContent(type="text", text="end chat")])
        with patch.object(m.chat_adapter, "handle", AsyncMock(return_value="Disconnected")):
            await m.on_chat(ctx, "agent1" + "a" * 55, msg)
        reply = ctx.send.await_args_list[-1].args[1]
        self.assertTrue(any(isinstance(c, m.EndSessionContent) for c in reply.content))

    async def test_empty_session_control_is_only_acknowledged(self):
        m = self.module
        ctx = SimpleNamespace(send=AsyncMock(), session=uuid4())
        msg = m.ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(), content=[])
        with patch.object(m.chat_adapter, "handle", AsyncMock()) as handle:
            await m.on_chat(ctx, "agent1" + "a" * 55, msg)
        self.assertEqual(ctx.send.await_count, 1)
        handle.assert_not_called()


if __name__ == "__main__":
    unittest.main()
