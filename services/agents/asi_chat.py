"""Stateful Agent Chat Protocol adapter; the router alone resolves user authority.

ACKs are receipts. Only an explicit acceptance of one current reviewed proposal
calls the company's existing approval gate. No LLM output is an authorization.
"""
import asyncio
import hashlib
import json
import re
from uuid import uuid4

import asi_cards
from chat_format import _date, _money, _plain

# Exact phrases only: a quoted, conditional or edited "yes" is a new request, never consent. Never routed through an LLM.
_YES = {"yes", "y", "yes please", "yep", "yeah", "confirm", "confirm payment", "confirmed", "approve", "approve it",
        "send it", "yes send it", "yes, send it", "go ahead", "yes go ahead", "yes, go ahead", "proceed", "do it",
        "pay it", "yes pay it", "accept", "i accept", "ok send it", "okay send it"}
_CANCEL = {"cancel", "no", "no thanks", "cancel payment", "cancel this", "never mind", "nevermind"}
_STATUS = {"status", "payment status", "check status", "check payment status"}
_CONTINUE = {"continue", "connected", "i connected", "i've connected", "done"}
# Read-only: every stored payment request for the company, newest first.
_HISTORY = {"payments", "my payments", "show my payments", "show payments", "list payments", "list my payments", "all payments",
            "payment history", "history", "past payments", "previous payments", "what have i paid", "what did i pay", "recent payments"}
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
    requests = [r for r in value.get("requests", [])[:25] if isinstance(r, dict)]
    total = asi_cards.saved_total(requests)
    if total:
        blocks.append(f"**Saved vs your bank wire: {total}**" + (" on completed payments" if len(requests) > 1 else ""))
    for request in requests:
        line = "**" + _plain(request.get("supplier") or "Payment", 140) + ": " + states.get(request.get("status"), "Check in Route402") + "**"
        amount = _money(request.get("amount"))
        when = _date(request.get("at"))
        saved = asi_cards.saved_label(request)
        if amount or when or saved:
            line += "\n\n" + " · ".join(x for x in (amount, saved, f"submitted {when}" if when else None, "via ASI:One" if request.get("viaChat") else None) if x)
        if request.get("note"):
            line += "\n\n" + _plain(request["note"], 450)
        if request.get("id"):
            line += "\n\nPayment request " + _plain(request["id"], 80)
        # No app links: ASI:One users are never sent to sign in elsewhere; status is answered in this chat.
        blocks.append(line)
    for note in value.get("notes", [])[:4]:
        blocks.append(_plain(note, 300))
    return "\n\n".join(blocks)


class AsiChatAdapter:
    def __init__(self, backend, concierge_callable, format_answer, tenant, paid_limiter=None, converse=None):
        self.backend, self.concierge = backend, concierge_callable
        self.format_answer, self.tenant = format_answer, tenant
        self.paid_limiter = paid_limiter
        # Optional read-only small-talk reply for turns the payment planner does not handle (ASI:One only).
        self.converse = converse
        self._locks = {}

    async def handle(self, ctx, sender, session, msg_id, text):
        """Text reply only (the card is dropped)."""
        return (await self.respond(ctx, sender, session, msg_id, text))[0]

    async def respond(self, ctx, sender, session, msg_id, text):
        """(text, card metadata or None). The text is always complete on its own."""
        reply = await self._respond(ctx, sender, session, msg_id, text)
        return (reply[0], reply[1]) if isinstance(reply, (list, tuple)) else (reply, None)

    async def _respond(self, ctx, sender, session, msg_id, text):
        if not isinstance(text, str) or len(text) > 2000 or (len(text) > 500 and not asi_cards.looks_like_selection(text)):
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
                reply = "I couldn't verify the result. Ask for status before trying another payment. An uncertain confirmation will not be retried automatically."
            seen[message_id] = list(reply) if isinstance(reply, tuple) else reply
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
            # The router decides who a chat acts as. No sign-in link is ever sent to ASI:One.
            state["offered"] = None
            return ("**Payments are not enabled for this chat**\n\n"
                    "This deployment has not configured a company account for ASI:One conversations, "
                    "so I can't plan or submit payments here. No supplier payment has been submitted.")
        # A card click becomes the same fixed command a user could type; nothing else in it is interpreted.
        picked = asi_cards.selection(text, state.get("offered"))
        if picked is not None:
            command, clicked_id = picked
            if not command:
                return "I didn't recognise that selection. No payment action was taken."
            if command == "yes" and clicked_id != state.get("offered"):
                return "That payment review is no longer current. Ask for a fresh review before sending."
            text, normalized = command, _normalized(command)
        if normalized in _HISTORY:
            result = await self.backend.asi_payments(*args)
            return _result(result), asi_cards.status_card(result, title="Payment history")
        if normalized in _STATUS or normalized.startswith("status "):
            return _with_card(await self.backend.asi_status(*args))
        if normalized in _CANCEL:
            result = await self.backend.asi_cancel(*args)
            state["offered"] = None
            return _result(result), asi_cards.actions_card("Proposal closed. What next?")
        if normalized in _YES:
            pending = context.get("pending") or {}
            confirmation_id = pending.get("confirmationId") or pending.get("id")
            # The proposal must have been shown by this adapter, not just created on another channel.
            if not confirmation_id or confirmation_id != state.get("offered"):
                return "There is no payment review awaiting your yes in this chat. Tell me the supplier and amount to review first."
            if pending.get("state") == "cancelled":
                return "That proposal was cancelled. Ask for a new payment review before accepting."
            return _with_card(await self.backend.asi_confirm(*args, confirmation_id))
        if normalized in _CONTINUE:
            return "Tell me the supplier and amount, or ask to see your suppliers.", asi_cards.actions_card()
        if not text:
            return "Tell me a supplier and amount, or ask which suppliers use EUR.", asi_cards.actions_card()
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
                confirmation = ("This payment is on hold for the reasons above, so it can't be sent. Nothing was submitted. Ask again in a moment or pick a different preference."
                                if any(d.get("decision") == "hold" for d in answer.get("decisions", []) if isinstance(d, dict))
                                else "This plan can't be accepted in chat right now (expired quote or missing permission). Ask for a fresh review. Nothing was submitted.")
        details = {row["intentId"]: row for row in offer.get("details", []) if isinstance(row, dict) and row.get("intentId")}
        if _small_talk(answer):
            chat = await self.converse(text) if self.converse else None
            if chat:
                return _plain(chat, 900) + "\n\n" + _HINT, asi_cards.actions_card()
            return self.format_answer(answer, confirmation=confirmation, quote_details=details), asi_cards.actions_card()
        reply = self.format_answer(answer, confirmation=confirmation, quote_details=details)
        preview = answer.get("preview") if isinstance(answer.get("preview"), dict) else {}
        if answer.get("decisions"):
            return reply, asi_cards.review_card(answer, details, state.get("offered"))
        if preview.get("suppliers"):
            return reply, asi_cards.suppliers_card(preview)
        return reply


_HINT = ("_Try: “which suppliers use EUR?”, “pay Muller Teile 5000 EUR by Friday” or “how much can I save?”. "
         "I show a full review first; nothing is sent until you reply yes._")


def _with_card(result):
    return _result(result), asi_cards.status_card(result)


def _small_talk(answer):
    """Only the planner's generic 'not a payment request' turn; never security refusals, plans or slot questions."""
    preview = answer.get("preview") if isinstance(answer.get("preview"), dict) else {}
    return (answer.get("status") in ("ok", "clarification") and not answer.get("decisions")
            and preview.get("template") in ("out_of_scope", "help") and not preview.get("task")
            and preview.get("title") != "Chat cannot override security controls")
