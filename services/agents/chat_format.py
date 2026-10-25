"""Deterministic ASI:One presentation. This module cannot authorize or send payments.

Only selected display fields are read. In particular, a calculator preview's money
is never attributed to a different paid quote chosen by the routing agent.
"""
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from urllib.parse import quote, urlsplit, urlunsplit

from guard import redact


_POLICIES = {"cheapest": "Lowest cash cost", "fastest": "Earliest arrival",
             "balanced": "Cost and speed", "lowest_risk": "Lowest assessed risk"}
_CHECKS = {"OK": "Details checked", "PASS": "Checks passed", "REVIEW": "Review needed",
           "BLOCK": "Blocked", "UNAVAILABLE": "Checks unavailable"}
_STATES = {"SCHEDULED": "Scheduled", "EXECUTING": "Processing", "COMPLETED": "Completed",
           "NEEDS_RECONCILIATION": "Outcome needs reconciliation", "PARTIAL": "Partially completed",
           "FAILED": "Failed", "PAUSED": "Paused", "AWAITING_APPROVAL": "Awaiting approval",
           "AWAITING_DELIVERY": "Awaiting release evidence", "READY": "Ready for release",
           "REJECTED": "Rejected", "REFUNDED": "Refunded"}
_RECEIPT_HOSTS = {"sepolia.basescan.org", "base-sepolia.blockscout.com", "sepolia.etherscan.io"}


def _mapping(value):
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    return {}


def _plain(value, limit=700):
    """External labels stay text: they cannot create links, headings or HTML."""
    if not isinstance(value, (str, int, float, Decimal)):
        return ""
    text = redact(str(value))[:limit]
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", text)
    # Stop bare URLs auto-linking, including a URL hidden in supplier/provider text.
    text = re.sub(r"\b(https?)://", lambda match: match[1] + "\u200b://", text, flags=re.I)
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return re.sub(r"([\\`*_{}\[\]()<>#!|])", r"\\\1", text)


def _number(value):
    try:
        result = Decimal(str(value).replace(",", ""))
        return result if result.is_finite() else None
    except (InvalidOperation, TypeError, ValueError):
        return None


def _money(value):
    if isinstance(value, dict):
        if value.get("display"):
            return _money(value["display"])
        currency = value.get("currency") or value.get("ccy")
        amount = _number(value.get("amount"))
        if amount is None and "minor" in value and re.fullmatch(r"[A-Z]{3}", str(currency or "")):
            places = 0 if currency in ("JPY", "KRW") else 3 if currency in ("BHD", "KWD", "OMR") else 2
            minor = _number(value["minor"])
            amount = minor / (Decimal(10) ** places) if minor is not None else None
    else:
        match = re.fullmatch(r"\s*(-?[\d,]+(?:\.\d+)?)\s+([A-Z]{3})\s*", str(value or ""))
        if not match:
            return None
        amount, currency = _number(match[1]), match[2]
    if amount is None or not re.fullmatch(r"[A-Z]{3}", str(currency or "")):
        return None
    places = 0 if currency in ("JPY", "KRW") else 3 if currency in ("BHD", "KWD", "OMR") else 2
    return f"{amount:,.{places}f} {currency}"


def _date(value):
    if not isinstance(value, str):
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            return None
        return stamp.astimezone(timezone.utc).strftime("%d %b %Y, %H:%M UTC")
    except (ValueError, OverflowError):
        return None


def _safe_url(value, *, receipt=False):
    """Only caller-supplied app links and allowlisted testnet transaction links."""
    if not isinstance(value, str) or len(value) > 1600 or re.search(r"[\x00-\x20\x7f\\]", value):
        return None
    try:
        parts = urlsplit(value)
        if parts.scheme not in ("https", "http") or not parts.hostname or parts.username or parts.password:
            return None
        if receipt and (parts.scheme != "https" or parts.hostname not in _RECEIPT_HOSTS
                        or parts.port is not None or parts.query or parts.fragment
                        or not re.fullmatch(r"/tx/0x[a-fA-F0-9]{64}/?", parts.path)):
            return None
        # Plain HTTP is allowed only for the local app, never external content.
        if parts.scheme == "http" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
            return None
        return urlunsplit((parts.scheme, parts.netloc, quote(parts.path, safe="/:%@"),
                           quote(parts.query, safe="=&%"), quote(parts.fragment, safe="/?:=&%")))
    except ValueError:
        return None


def _supplier_name(preview, payable, index, count):
    beneficiary = _mapping(preview.get("beneficiary"))
    if count == 1 and beneficiary.get("name"):
        return beneficiary["name"]
    for line in _mapping(preview.get("preview")).get("lines", []):
        if isinstance(line, dict) and line.get("payable") == payable:
            return _mapping(line.get("beneficiary")).get("name") or f"Payment {index}"
    return f"Payment {index}"


def _route(label):
    """'Your bank (US big-bank pricing, measured) (your current bank) + USDC->EURC swap on base, ...' -> readable legs."""
    legs = []
    for leg in str(label or "").split(" + ")[:6]:
        leg = leg.strip()
        if not leg:
            continue
        if leg.lower().startswith("your bank"):
            leg = "your bank wire"
        legs.append(re.sub(r"\bon base\b", "on Base", leg.replace("->", "→")))
    if not legs:
        return None
    return ("Split: " if len(legs) > 1 else "") + " + ".join(legs)


def _arrival(detail):
    arrival = _date(detail.get("arrivalUtc"))
    if not arrival:
        return None
    bank = _date(detail.get("bankArrivalUtc"))
    if not bank:
        return arrival
    hours = (datetime.fromisoformat(detail["bankArrivalUtc"].replace("Z", "+00:00"))
             - datetime.fromisoformat(detail["arrivalUtc"].replace("Z", "+00:00"))).total_seconds() / 3600
    if hours > 1:
        return f"{arrival} · {hours / 24:.1f} days sooner than a bank wire" if hours >= 24 else f"{arrival} · {hours:.0f} hours sooner than a bank wire"
    return f"{arrival} · same time as a bank wire" if hours >= -1 else f"{arrival} · later than a bank wire"


def _details(detail):
    lines = []
    received = _money(detail.get("recipientGets"))
    if received:
        lines.append(f"- **Supplier receives:** {received}")
    paid, fee = _money(detail.get("youPay")), _money(detail.get("platformFee"))
    if paid:
        lines.append(f"- **You pay:** {paid}" + (f" (includes {fee} Route402 fee)" if fee else ""))
    saving = _money(detail.get("netSavings"))
    if saving:
        lines.append(f"- **Saving vs your bank:** {saving}, after our fee")
    arrival = _arrival(detail)
    if arrival:
        lines.append(f"- **Arrives:** {arrival}")
    return lines


def _decision_blocks(answer, preview, quote_details):
    blocks = []
    decisions = answer.get("decisions") or []
    for index, decision in enumerate(decisions[:25], 1):
        if not isinstance(decision, dict):
            continue
        from asi_layout import payment   # same sections and order as the website's review page
        p = payment(decision, _mapping(quote_details.get(decision.get("intentId"))), preview, index, len(decisions))
        head = [f"**{_plain(p['supplier'], 140)}**" + (f" · {_plain(p['meta'], 120)}" if p["meta"] else "")]
        if p["flow"]:
            head.append(" → ".join(f"**{_plain(k, 60)}:** {v}" for k, v in p["flow"][:2]))
            head.extend(f"**{_plain(k, 60)}: {v}**" for k, v in p["flow"][2:])   # the saving, as its own headline
        if p["account"]:
            head.append(_plain(p["account"], 80))
        if p["route"]:
            head.append(f"**Route:** {_plain(p['route'], 240)}" + (" · Recommended" if decision.get("decision") == "approve" else ""))
        if p["routeWhy"]:
            head.append(f"_{_plain(p['routeWhy'], 400)}_")
        head.extend(f"- {_plain(note, 350)}" for note in p["notes"])
        blocks.append("\n".join(head))
        for title, rows in p["sections"]:
            blocks.append(f"**{_plain(title, 80)}**\n" + "\n".join(f"- **{_plain(k, 80)}:** {_plain(v, 400)}" for k, v in rows))
    return blocks


def _agent_blocks(answer):
    from asi_layout import agent_trail
    trail = agent_trail(answer)
    if not trail:
        return []
    summary, steps = trail
    lines = [f"**How your agents handled this**" + (f" · {_plain(summary, 80)}" if summary else "")]
    lines += [f"{i}. **{_plain(who, 40)}:** {_plain(what, 400)}" + (f" ({_plain(t, 20)})" if t else "")
              for i, (who, what, t) in enumerate(steps, 1)]
    return ["\n".join(lines)]


def _read_only_blocks(preview):
    blocks = []
    if preview.get("message"):
        blocks.append(_plain(preview["message"], 2200))
    suppliers = preview.get("suppliers")
    if isinstance(suppliers, list):
        rows = []
        for supplier in suppliers[:25]:
            if not isinstance(supplier, dict):
                continue
            currencies = supplier.get("currencies") or [supplier.get("currency")]
            currencies = [c for c in currencies if isinstance(c, str) and re.fullmatch(r"[A-Z]{3}", c)]
            checks = _CHECKS.get(supplier.get("check"), "Check pending")
            bill_count = len(supplier["billIds"]) if isinstance(supplier.get("billIds"), list) else len(supplier.get("bills") or [])
            metadata = [_plain(supplier.get("country"), 50), ", ".join(currencies),
                        f"{bill_count} linked bill{'s' if bill_count != 1 else ''}", checks]
            rows.append(f"- **{_plain(supplier.get('name') or 'Supplier', 140)}** — " + " · ".join(x for x in metadata if x))
        blocks.append("\n".join(rows) if rows else "No saved suppliers match this search.")
        if len(suppliers) > 25:
            blocks.append("Showing the first 25 suppliers. Filter by country, currency or name.")
    company = _mapping(preview.get("companyInfo"))
    if company:
        values = [f"**Company:** {_plain(company['name'], 140)}"] if company.get("name") else []
        if re.fullmatch(r"[A-Z]{3}", str(company.get("homeCurrency") or "")):
            values.append(f"**Home currency:** {company['homeCurrency']}")
        if type(company.get("supplierCount")) is int:
            values.append(f"**Saved suppliers:** {company['supplierCount']}")
        blocks.append("\n\n".join(values))
    for row in (preview.get("results") or [])[:25]:
        if isinstance(row, dict):
            label = _CHECKS.get(row.get("status"), "Check pending")
            issues = [x for x in row.get("issues", []) if isinstance(x, str)]
            blocks.append(f"- **{_plain(row.get('supplier') or 'Supplier', 140)}:** {label}"
                          + (". " + "; ".join(_plain(x, 200) for x in issues[:2]) if issues else ""))
    for currency, values in _mapping(preview.get("byCurrency")).items():
        if re.fullmatch(r"[A-Z]{3}", str(currency)) and isinstance(values, dict):
            rows = []
            for field, label in (("owe", "Owed"), ("incoming", "Confirmed incoming"), ("expected", "Forecast incoming")):
                amount = _money({"amount": values.get(field), "currency": currency})
                if amount:
                    rows.append(f"{label}: {amount}")
            blocks.append(f"**{currency}**\n\n" + "\n".join(f"- {x}" for x in rows))
    for transfer in (preview.get("transfers") or [])[:25]:
        if isinstance(transfer, dict):
            state = _STATES.get(transfer.get("status"), "Status unavailable")
            name = _plain(transfer.get("supplier") or "Payment", 140)
            amount = _money(transfer.get("amount"))
            blocks.append(f"**{name}: {state}**" + (f"\n\n{amount}" if amount else ""))
    # These are explicitly estimates; payment-run totals can include more than routing savings.
    run = _mapping(preview.get("preview"))
    retained = _money(preview.get("companyKeeps") or run.get("companyKeeps"))
    if retained:
        blocks.append(f"**Projected benefit on the selected open bills, after our fee: {retained}**\n\n"
                      "This estimate can include routing savings, treasury suggestions and avoided-payment costs. It is not realized profit.")
    return [block for block in blocks if block]


def _receipts(answer):
    calls = list(answer.get("paidCalls") or [])
    if not calls:
        calls = [call for d in answer.get("decisions", []) if isinstance(d, dict) for call in d.get("paidCalls", [])]
    calls = [call for call in calls if isinstance(call, dict)]
    if not calls:
        return None
    real = [call for call in calls if not call.get("mock")]
    if not real:
        return f"**Agent activity:** {len(calls)} simulated tool call{'s' if len(calls) != 1 else ''}; no x402 payment was made."
    spent = _number(answer.get("spentUsdc"))
    text = f"**Agent activity:** {len(real)} quote/screening call{'s' if len(real) != 1 else ''} bought with x402"
    if spent is not None and spent >= 0:
        text += f" ({spent:f} test USDC)"
    links, seen = [], set()
    for call in real:
        url = _safe_url(call.get("explorer"), receipt=True)
        if url and url not in seen:
            seen.add(url)
            links.append(f"[receipt {len(links) + 1}]({url})")
    return text + (" · " + " · ".join(links[:6]) if links else "")


def format_answer(answer, *, confirmation=None, app_url=None, quote_details=None):
    """Render an AskResult/dict as compact Markdown suitable for ASI:One.

    ``confirmation`` is caller-produced plain text, never parsed as authorization.
    ``app_url`` comes from trusted app configuration, never supplier/provider data.
    ``quote_details`` maps intent IDs to server-verified display fields from the
    confirmation preparation endpoint; ``youPay`` includes the platform fee.
    """
    answer = _mapping(answer)
    preview = _mapping(answer.get("preview"))
    quote_details = _mapping(quote_details)
    if answer.get("status") != "ok":
        if answer.get("status") == "error":
            # Backend exceptions can contain URLs, bearer credentials or private fields.
            return "I couldn't complete that request. Please try again or check the service status in Route402."
        return _plain(answer.get("clarification") or "This request needs more information before it can proceed.", 1800)
    decisions = answer.get("decisions") or []
    title = "Payment review" if decisions else answer.get("title") or preview.get("title")
    blocks = [f"**{_plain(title, 180)}**"] if title else []
    if decisions:
        policy = _POLICIES.get(answer.get("policy"))
        if policy:
            blocks.append(f"Optimized for: **{policy.lower()}**")
        blocks.extend(_decision_blocks(answer, preview, quote_details))
        blocks.extend(_agent_blocks(answer))
    else:
        blocks.extend(_read_only_blocks(preview))
        if not blocks:
            blocks.append("Ask about suppliers, payment costs or status, or give me an amount and supplier to plan a payment.")
    receipts = _receipts(answer)
    if receipts and decisions and "[receipt" in receipts:
        # The agent trail above already counts the calls; keep only the on-chain receipts, as the site does.
        spent = _number(answer.get("spentUsdc"))
        blocks.append("Receipts for the data the agents bought" + (f" ({spent:f} test USDC)" if spent is not None and spent > 0 else "")
                      + ": " + receipts.split(" · ", 1)[1])
    elif receipts:
        blocks.append(receipts)
    offered = any(isinstance(d, dict) and d.get("intentId") in quote_details for d in decisions)
    if confirmation and offered:
        # The router's acceptance terms, condensed; the action words are fixed text, not provider data.
        blocks.append("**Reply `yes` to send**, `cancel` to drop it, or `cheapest` / `fastest` to re-plan. "
                      "Your company's approval and release checks still apply.")
    elif confirmation:
        blocks.append(_plain(confirmation, 1500))
    elif decisions:
        blocks.append("No supplier payment has been sent by this review.")
    if decisions:
        blocks.append("_Demo: supplier payouts and currency conversion are simulated; USDC testnet settlement is a representative proof, not the invoice amount._")
    link = _safe_url(app_url)
    if link:
        blocks.append(f"[Open in Route402]({link})")
    return "\n\n".join(blocks)
