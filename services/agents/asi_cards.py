"""ASI:One Interactive Cards (card_protocol_version "1"), for the ASI:One chat only.

Cards are presentation: every reply still carries the full text, which ASI:One shows if
a card fails validation. A click comes back as an ordinary chat message (a JSON selection
string, or planner-written prose naming the selection ids) and is turned into the same
fixed command a user could type, so it passes through the same checks as typed text.
Only the "confirm" selection can lead to a payment, and only for the proposal this chat
displayed. Spec: https://innovationlab.fetch.ai/resources/docs/interactive-cards/asi-interactive-cards
"""
import json
import re

from asi_layout import agent_trail, payment
from chat_format import _date, _money, _number, _CHECKS, _POLICIES

MAX_BYTES, MAX_DEPTH = 64 * 1024, 8
_STATES = {"READY": ("Ready for release", "info"), "AWAITING_APPROVAL": ("Awaiting approval", "warning"),
           "AWAITING_DELIVERY": ("Awaiting release evidence", "warning"), "NEEDS_CALLBACK": ("Supplier call-back required", "warning"),
           "SCHEDULED": ("Scheduled", "info"), "EXECUTING": ("Processing", "info"), "COMPLETED": ("Completed", "success"),
           "PAUSED": ("Paused", "warning"), "FAILED": ("Needs attention", "warning"), "PARTIAL": ("Partially completed", "warning"),
           "NEEDS_RECONCILIATION": ("Needs reconciliation", "warning"), "UNKNOWN": ("Outcome needs checking", "warning")}
# Quick actions map to fixed prompts; a selection can never supply free text for these.
PROMPTS = {"suppliers": "list my suppliers", "owe": "what do we owe", "details": "check my suppliers' bank details",
           "savings": "how much will my savings be", "status": "status", "history": "payment history"}
_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_NAME = re.compile(r"^[\w .,&'()/-]{1,120}$")
_NEGATION = re.compile(r"\b(?:not|never|don't|do not|no|unless|if|cancel|reject|decline)\b", re.I)


def _text(value, style=None):
    node = {"type": "text", "value": str(value)[:500]}
    if style:
        node["style"] = style
    return node


def _row(label, value):
    return {"type": "group", "direction": "row", "gap": 8, "children": [_text(label, "muted"), _text(value, "emphasis")]}


def _button(label, selection, primary=False):
    suffix = selection.get("policy") and f"_{selection['policy']}" or selection.get("prompt") and f"_{selection['prompt']}" or ""
    selection = {**selection, "cta": f"r402_{'ask' if selection['action'] == 'ask' else selection['action']}{suffix}"}
    node = {"type": "button", "label": label, "action": {"selection": selection}}
    if primary:
        node["primary"] = True
    return node


def _depth(node, level=1):
    kids = list(node.get("children", [])) if isinstance(node, dict) else []
    for item in (node.get("items", []) if isinstance(node, dict) else []):
        kids.extend(item.get("children", []))
    return max([level] + [_depth(k, level + 1) for k in kids])


def metadata(kind, payload, *, terminal=False, width=560):
    """MetadataContent.metadata for one card, or None (the text reply is then sent alone)."""
    if kind not in ("carousel", "detail", "form", "review", "custom"):
        return None
    if kind == "custom" and (not isinstance(payload.get("root"), dict) or _depth(payload["root"]) > MAX_DEPTH):
        return None
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(body.encode()) > MAX_BYTES:
        return None
    meta = {"card_protocol_version": "1", "requires_card_interaction": "true",
            "card_kind": kind, "card_payload": body, "preferred_drawer_width_px": str(width)}
    if terminal:
        meta["is_terminal"] = "true"
    return meta


def _policy_buttons(current):
    return [_button(label, {"action": "prefer", "policy": policy}) for policy, label in
            (("cheapest", "Cheapest"), ("fastest", "Fastest"), ("balanced", "Balanced")) if policy != current]


def review_card(answer, details, confirmation_id):
    """Payment review: the same server-verified figures as the text, plus Send / re-plan / Cancel."""
    decisions = [d for d in answer.get("decisions") or [] if isinstance(d, dict)][:10]
    if not decisions:
        return None
    blocks, saved, expires, names = [], 0, None, []
    preview = answer.get("preview") if isinstance(answer.get("preview"), dict) else {}
    for index, d in enumerate(decisions, 1):
        detail = details.get(d.get("intentId")) or {}
        # Same sections and order as the website's Review & approve page (asi_layout).
        p = payment(d, detail, preview, index, len(decisions))
        names.append(p["supplier"])
        head = [{"type": "group", "direction": "row", "gap": 8, "children": [
            {"type": "heading", "value": p["supplier"][:140], "level": 2}, {"type": "badge", "label": p["state"][0], "variant": p["state"][1]}]}]
        if detail.get("country"):
            head.append(_text(str(detail["country"])[:60], "muted"))
        if p["flow"]:
            head.append({"type": "group", "direction": "row", "gap": 24, "children": [
                {"type": "group", "direction": "column", "gap": 2, "children": [_text(k, "muted"), {"type": "heading", "value": v, "level": 3}]}
                for k, v in p["flow"]]})
        if p["account"]:
            head.append(_text(p["account"], "muted"))
        if p["route"]:
            head.append({"type": "group", "direction": "row", "gap": 8, "children": [_text(p["route"][:240], "emphasis")]
                         + ([{"type": "badge", "label": "Recommended", "variant": "success"}] if d.get("decision") == "approve" else [])})
        if p["routeWhy"]:
            head.append(_text(p["routeWhy"][:400], "muted"))
        head.extend(_text(note[:350], "muted") for note in p["notes"])
        blocks.append({"type": "group", "direction": "column", "gap": 8, "children": head})
        for title, rows in p["sections"]:
            blocks.append({"type": "group", "direction": "column", "gap": 4, "children":
                           [{"type": "heading", "value": title, "level": 3}] + [_row(k, v[:300]) for k, v in rows]})
        saving = _number(str(detail.get("netSavings") or "").split(" ")[0])
        saved += saving if saving and saving > 0 else 0
        expires = expires or _date(detail.get("expiresAt"))
        blocks.append({"type": "divider"})
    trail = agent_trail(answer)
    if trail:
        summary, steps = trail
        blocks.append({"type": "group", "direction": "column", "gap": 6, "children": [
            {"type": "group", "direction": "row", "gap": 8, "children": [{"type": "heading", "value": "How your agents handled this", "level": 3}]
             + ([_text(summary, "muted")] if summary else [])},
            {"type": "list", "items": [{"children": [_text(who + (f" · {t}" if t else ""), "emphasis"), _text(what[:400], "body")]} for who, what, t in steps]}]})
        blocks.append({"type": "divider"})
    badges = []
    if _POLICIES.get(answer.get("policy")):
        badges.append({"type": "badge", "label": _POLICIES[answer["policy"]], "variant": "info"})
    if saved:
        badges.append({"type": "badge", "label": f"Saves {saved:,.2f} USD", "variant": "success"})
    badges.append({"type": "badge", "label": "Simulated payout", "variant": "info"})
    buttons = []
    if confirmation_id and _ID.match(str(confirmation_id)):
        buttons.append(_button("Send payment", {"action": "confirm", "confirmation_id": confirmation_id}, primary=True))
    buttons += _policy_buttons(answer.get("policy"))
    buttons.append(_button("Cancel", {"action": "cancel"}))
    held = not (confirmation_id and _ID.match(str(confirmation_id)))
    title = "Payment review" if len(decisions) > 1 else f"Pay {names[0]}"
    subtitle = ("Can't be sent yet — nothing was submitted. Try a different preference or ask again shortly." if held
                else (f"Quote valid until {expires}" if expires else "Review before sending") + " · nothing is sent until you confirm")
    root = {"type": "section", "title": (("On hold: " if held else "") + title)[:160], "subtitle": subtitle,
            "children": [{"type": "group", "direction": "row", "gap": 6, "children": badges}, *blocks,
                         {"type": "group", "direction": "row", "gap": 8, "children": buttons}]}
    return metadata("custom", {"root": root})


def suppliers_card(preview):
    suppliers = [s for s in preview.get("suppliers") or [] if isinstance(s, dict)][:25]
    if not suppliers:
        return None
    items = []
    for s in suppliers:
        name = str(s.get("name") or "Supplier")[:120]
        currencies = [c for c in (s.get("currencies") or [s.get("currency")]) if isinstance(c, str) and re.fullmatch(r"[A-Z]{3}", c)]
        bills = len(s["billIds"]) if isinstance(s.get("billIds"), list) else len(s.get("bills") or [])
        check = _CHECKS.get(s.get("check"), "Check pending")
        variant = "success" if s.get("check") in ("OK", "PASS") else "warning"
        item = {"children": [{"type": "group", "direction": "row", "gap": 8, "children": [
            {"type": "heading", "value": name, "level": 3}, {"type": "badge", "label": check, "variant": variant}]},
            _text(" · ".join(x for x in (str(s.get("country") or ""), ", ".join(currencies), f"{bills} open bill{'s' if bills != 1 else ''}") if x), "muted")]}
        if s.get("check") != "BLOCK" and _NAME.match(name):
            item["action"] = {"selection": {"action": "pay_supplier", "supplier": name}}
        items.append(item)
    root = {"type": "section", "title": str(preview.get("title") or "Your suppliers")[:160],
            "subtitle": "Pick a supplier to plan a payment for its open bills",
            "children": [{"type": "list", "items": items}]}
    return metadata("custom", {"root": root})


def saved_label(request):
    """'saved 1,211.63 USD vs your bank' for a payment whose approved quote beat the bank wire, else None."""
    saved = _number(str(request.get("saved") or "").split(" ")[0])
    return f"saved {_money(request['saved'])} vs your bank" if saved is not None and saved > 0.005 and _money(request["saved"]) else None


def saved_total(requests):
    """Total saving on COMPLETED payments only (what was actually realized), per currency."""
    totals = {}
    for r in requests:
        parts = str(r.get("saved") or "").split()
        amount = _number(parts[0]) if len(parts) == 2 else None
        if r.get("status") == "COMPLETED" and amount is not None and amount > 0:
            totals[parts[1]] = totals.get(parts[1], 0) + amount
    return " + ".join(_money(f"{v} {k}") for k, v in totals.items()) or None


def status_card(result, title="Payment status"):
    requests = [r for r in result.get("requests") or [] if isinstance(r, dict)][:25]
    if not requests:
        return None
    items = []
    for r in requests:
        label, variant = _STATES.get(r.get("status"), ("Check status", "warning"))
        children = [{"type": "group", "direction": "row", "gap": 8, "children": [
            {"type": "heading", "value": str(r.get("supplier") or "Payment")[:140], "level": 3},
            {"type": "badge", "label": label, "variant": variant}]}]
        amount, saved = _money(r.get("amount")), saved_label(r)
        if amount or saved:
            row = [_text(amount, "emphasis")] if amount else []
            if saved:
                row.append({"type": "badge", "label": saved[0].upper() + saved[1:], "variant": "success"})
            children.append({"type": "group", "direction": "row", "gap": 8, "children": row})
        if r.get("note"):
            children.append(_text(str(r["note"])[:300], "muted"))
        if r.get("id"):
            children.append(_text(f"Payment request {str(r['id'])[:80]}", "muted"))
        items.append({"children": children})
    total = saved_total(requests)
    head = [{"type": "group", "direction": "column", "gap": 2, "children": [_text("Saved vs your bank wire on completed payments", "muted"),
                                                                            {"type": "heading", "value": total, "level": 2}]}] if total else []
    root = {"type": "section", "title": title, "subtitle": str(result.get("message") or "")[:200],
            "children": [*head, {"type": "list", "items": items}, _button("Refresh status", {"action": "ask", "prompt": "status"})]}
    return metadata("custom", {"root": root})


def actions_card(title="What would you like to do?"):
    buttons = [_button(label, {"action": "ask", "prompt": key}, primary=(key == "suppliers")) for key, label in (
        ("suppliers", "Show my suppliers"), ("owe", "What do we owe?"), ("savings", "Savings vs my bank"),
        ("details", "Check bank details"), ("status", "Payment status"), ("history", "Payment history"))]
    root = {"type": "section", "title": title, "subtitle": "Or type a request, e.g. “pay Muller Teile 5000 EUR by Friday”",
            "children": [{"type": "group", "direction": "column", "gap": 8, "children": buttons}]}
    return metadata("custom", {"root": root})


def _json_object(text):
    """The selection object, even when ASI:One prefixes it with the agent mention ("@agent {...}")."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start or start > 120:
        return None
    try:
        value = json.loads(text[start:end + 1])
    except ValueError:
        return None
    if isinstance(value, dict) and not isinstance(value.get("action"), str) and isinstance(value.get("selection"), dict):
        value = {**value["selection"], **{k: v for k, v in value.items() if k != "selection"}}
    return value if isinstance(value, dict) else None


def looks_like_selection(text):
    return _json_object(text) is not None or bool(_CTA.search(text))


# Every selection also carries a "cta" id, so planner-written prose that names it can be mapped back.
_CTA = re.compile(r"\br402_(confirm|cancel|prefer_(?:cheapest|fastest|balanced)|ask_(?:suppliers|owe|details|savings|status|history))\b")


def selection(text, offered):
    """Turn a card click into a fixed command. Returns (command, confirmation_id) or None for ordinary text.

    Accepts the direct @mention form (JSON string, optionally after the mention) and the
    planner-mediated form (prose that names the selection ids). A confirmation only counts
    for the id this chat displayed."""
    value = _json_object(text)
    if isinstance(value, dict) and isinstance(value.get("action"), str):
        action = value["action"]
        if action == "confirm":
            cid = value.get("confirmation_id")
            return ("yes", cid if isinstance(cid, str) and _ID.match(cid) else "")
        if action == "cancel":
            return ("cancel", None)
        if action == "prefer" and value.get("policy") in ("cheapest", "fastest", "balanced"):
            return (f"I prefer the {value['policy']}" if value["policy"] != "balanced" else "I prefer balanced", None)
        if action == "ask" and value.get("prompt") in PROMPTS:
            return (PROMPTS[value["prompt"]], None)
        if action == "pay_supplier" and isinstance(value.get("supplier"), str) and _NAME.match(value["supplier"]):
            return (f"pay {value['supplier']}", None)
        return ("", None)   # an unknown selection is ignored, never interpreted
    # Planner prose: a confirmation must name this chat's displayed proposal id, with no negation.
    if offered and isinstance(offered, str) and offered in text and re.search(r"\b(?:confirm|send|approve)\b|r402_confirm", text, re.I) \
            and not _NEGATION.search(text.replace(offered, "").replace("r402_cancel", "")):
        return ("yes", offered)
    cta = _CTA.search(text)
    if cta and cta[1] != "confirm":
        kind = cta[1]
        if kind == "cancel":
            return ("cancel", None)
        if kind.startswith("prefer_"):
            policy = kind[7:]
            return (f"I prefer the {policy}" if policy != "balanced" else "I prefer balanced", None)
        return (PROMPTS[kind[4:]], None)
    return None
