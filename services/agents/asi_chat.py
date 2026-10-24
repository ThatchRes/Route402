"""Stateful Agent Chat Protocol adapter; the router alone resolves user authority.

ACKs are receipts. Only an explicit acceptance of one current reviewed proposal
calls the company's existing approval gate. No LLM output is an authorization.
"""
import asyncio
import hashlib
import json
import re
from uuid import uuid4

from chat_format import _plain, _safe_url

_YES = {"yes", "yes please", "confirm", "confirm payment", "approve", "send it", "yes send it"}
_CANCEL = {"cancel", "no", "no thanks", "cancel payment", "cancel this", "never mind", "nevermind"}
_STATUS = {"status", "payment status", "check status", "check payment status"}
_CONTINUE = {"continue", "connected", "i connected", "i've connected", "done"}
_END = {"end chat", "end session", "goodbye"}


def _normalized(text):
    return re.sub(r"\s+", " ", text.strip().lower()).rstrip(".!?")


def is_end_session(text):
    return _normalized(text) in _END


def _dict(value):
    if isinstance(value, dict):
        return value
    return value.model_dump() if hasattr(value, "model_dump") else value.dict()


def _result(value):
    blocks = [_plain(value.get("message") or "Check your payment status in Route402.", 1000)]
    states = {"READY": "Ready for release", "AWAITING_APPROVAL": "Awaiting an authorized approver",
              "AWAITING_DELIVERY": "Awaiting release evidence", "NEEDS_CALLBACK": "Supplier call-back required",
              "SCHEDULED": "Scheduled", "EXECUTING": "Processing", "COMPLETED": "Completed",
              "PAUSED": "Paused", "FAILED": "Needs attention", "PARTIAL": "Partially completed",
              "NEEDS_RECONCILIATION": "Needs reconciliation", "UNKNOWN": "Outcome needs checking"}
    for request in value.get("requests", [])[:25]:
        line = "**" + _plain(request.get("supplier") or "Payment", 140) + ": " + states.get(request.get("status"), "Check in Route402") + "**"
        if request.get("note"):
            line += "\n\n" + _plain(request["note"], 450)
        url = _safe_url(request.get("url"))
        if url:
            line += f"\n\n[View payment]({url})"
        blocks.append(line)
    for note in value.get("notes", [])[:4]:
        blocks.append(_plain(note, 300))
    return "\n\n".join(blocks)


class AsiChatAdapter:
    def __init__(self, backend, concierge_callable, format_answer, tenant, app_url=None, paid_limiter=None):
        self.backend, self.concierge = backend, concierge_callable
        self.format_answer, self.tenant, self.app_url = format_answer, tenant, app_url
        self.paid_limiter = paid_limiter
        self._locks = {}

    async def handle(self, ctx, sender, session, msg_id, text):
        if not isinstance(text, str) or len(text) > 500:
            return "Use a message of at most 500 characters. No payment action was taken."
        scope = hashlib.sha256(json.dumps([sender, session], separators=(",", ":")).encode()).hexdigest()
        # The signed transport supplies sender and ctx.session; neither comes from the user's text.
        lock = self._locks.setdefault(scope, asyncio.Lock())
        async with lock:
            key = "asi-chat-" + scope
            state = ctx.storage.get(key) or {"seen": {}, "original": None, "offered": None}
            seen = state.setdefault("seen", {})
            message_id = str(msg_id)
            if message_id in seen:
                return seen[message_id] or "This message was already received. Ask for status; it will not be submitted again."
            if len(seen) >= 512:
                return "This chat has reached its message limit. Start a new ASI:One conversation and connect it to continue."
            # Write before any effect, so an interrupted delivery never replays an acceptance.
            seen[message_id] = None
            ctx.storage.set(key, state)
            try:
                reply = await self._handle(ctx, sender, str(session), text.strip(), state)
            except Exception:
                # Do not echo credentials, remote errors or untrusted provider text.
                reply = "I couldn't verify the result. Ask for status or open Route402 before trying another payment. An uncertain confirmation will not be retried automatically."
            seen[message_id] = reply
            ctx.storage.set(key, state)
            return reply

    async def _handle(self, ctx, sender, session, text, state):
        corr = "chat-" + uuid4().hex[:16]
        args = (self.tenant, corr, sender, session)
        normalized = _normalized(text)
        context = await self.backend.asi_context(*args)
        if normalized in _END or normalized == "disconnect":
            if context.get("linked"):
                await self.backend.asi_disconnect(*args)
            state["original"], state["offered"] = None, None
            return "This chat is disconnected. Any previously submitted payments keep their existing status in Route402."
        if not context.get("linked"):
            if normalized not in _YES | _CONTINUE | _CANCEL | _STATUS and text:
                state["original"] = text
            state["offered"] = None
            link = await self.backend.asi_link(*args)
            url = _safe_url(link.get("linkUrl"))
            if not url:
                return "The Route402 connection URL is unavailable. Check ASI_APP_URL on the router."
            return ("**Connect your Route402 account**\n\n"
                    f"[Connect this ASI:One conversation]({url})\n\n"
                    "Sign in on the existing site, authorize this conversation, then return here and say continue. "
                    "I will show the payment review before asking you to say yes. No supplier payment has been submitted.")
        if normalized in _STATUS or normalized.startswith("status "):
            return _result(await self.backend.asi_status(*args))
        if normalized in _CANCEL:
            result = await self.backend.asi_cancel(*args)
            state["offered"], state["original"] = None, None
            return _result(result)
        if normalized in _YES | _CONTINUE and state.get("original") and not state.get("offered"):
            text, state["original"] = state["original"], None
            normalized = _normalized(text)
        elif normalized in _YES:
            pending = context.get("pending") or {}
            confirmation_id = pending.get("confirmationId") or pending.get("id")
            # The proposal must have been shown by this adapter, not just created on another channel.
            if not confirmation_id or confirmation_id != state.get("offered"):
                return "There is no payment review awaiting your yes in this chat. Tell me the supplier and amount to review first."
            if pending.get("state") == "cancelled":
                return "That proposal was cancelled. Ask for a new payment review before accepting."
            return _result(await self.backend.asi_confirm(*args, confirmation_id))
        elif normalized in _CONTINUE:
            return "Your account is connected. Tell me the supplier and amount, or ask to see your suppliers."
        if not text:
            return "Tell me a supplier and amount, or ask which suppliers use EUR."
        # Every new turn invalidates the last unaccepted plan before even a clarification or failed replan.
        await self.backend.asi_cancel(*args)
        state["offered"] = None
        if self.paid_limiter and not self.paid_limiter.allow(sender + ":" + session):
            return "The planning limit has been reached; quotes can spend test USDC. Try again in a minute. Status and confirmation remain available."
        answer = _dict(await self.concierge(ctx, self.tenant, corr, text,
                                            conversation_id=context["conversationId"]))
        offer, confirmation = {}, None
        if answer.get("status") == "ok" and answer.get("decisions"):
            try:
                offer = await self.backend.asi_offer(*args, answer)
                state["offered"] = offer.get("confirmationId")
                confirmation = offer.get("confirmation")
            except Exception:
                confirmation = "This plan cannot currently be accepted in chat. Ask for a fresh review or use Route402 to resolve any hold, permission or expired quote. No payment was submitted."
        details = {row["intentId"]: row for row in offer.get("details", []) if isinstance(row, dict) and row.get("intentId")}
        return self.format_answer(answer, confirmation=confirmation, app_url=self.app_url, quote_details=details)
