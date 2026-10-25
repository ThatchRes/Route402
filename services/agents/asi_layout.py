"""The website's payment-review layout, as plain data for ASI:One (text reply and Interactive Card).

Mirrors the site's sections (Review & approve, How we got here, How your agents handled this) in a
reduced form. Every figure comes from the routing agent's decision, the router's stored quote
(via /internal/asi/offer) or the agents' own hops and paid calls; nothing here is estimated.
Values are plain strings: renderers escape them for Markdown, and cards show them as text.
"""
import re
from decimal import Decimal

from chat_format import _arrival, _date, _money, _number, _route, _supplier_name

RAIL = {"stablecoin": "Our stablecoin rail", "bank": "Your bank wire", "tokenized_deposit": "Tokenized deposit"}
_RAIL_SHORT = {"stablecoin": "stablecoin rail", "bank": "bank wire", "tokenized_deposit": "tokenized deposit"}
_RULE = {"fastest": "Fastest arrival that meets the deadline", "cheapest": "Lowest total cost that meets the deadline"}
_PREF = {"cheapest": "lowest total cost", "fastest": "fastest arrival", "balanced": "a balance of cost and speed", "lowest_risk": "lowest risk"}


def _pct(bps):
    value = _number(bps)
    return f"{value / 100:.2f}%" if value is not None else None


def _amount(display):
    """Fiat via _money; token amounts such as '412770.47 USDC' get the same thousands separators."""
    money = _money(display)
    if money:
        return money
    parts = str(display or "").split()
    value = _number(parts[0]) if len(parts) == 2 else None
    return f"{value:,.2f} {parts[1]}" if value is not None else str(display or "")


def _sum(displays):
    """'45.00 USD' + '0.01 USD' -> '45.01 USD' (per currency); zero amounts are dropped."""
    totals = {}
    for display in displays:
        parts = str(display or "").split()
        amount = _number(parts[0]) if parts else None
        if amount is not None and len(parts) == 2 and amount > 0:
            totals[parts[1]] = totals.get(parts[1], Decimal(0)) + amount
    return [_money(f"{amount} {ccy}") for ccy, amount in totals.items()]


def payment(decision, detail, preview, index, count):
    """One payment's review, in the site's order. Returns a dict of display strings and (label, value) rows."""
    detail = detail if isinstance(detail, dict) else {}
    supplier = str(detail.get("supplier") or _supplier_name(preview, decision.get("payable"), index, count))
    state = {"approve": ("Ready to send", "success"), "review": ("Additional review needed", "warning")}.get(decision.get("decision"), ("On hold", "warning"))
    fixed_source = detail.get("amountType") == "SOURCE_FIXED"
    chosen = decision.get("chosen")
    out = {"supplier": supplier, "state": state,
           "meta": " · ".join(x for x in (str(detail.get("country") or ""), state[0].lower()) if x),
           "flow": [], "account": None, "route": None, "routeWhy": None, "sections": [], "notes": []}
    pay, get = _money(detail.get("youPay")), _money(detail.get("recipientGets"))
    if pay:
        out["flow"].append(("You pay · fees included", pay))
    if get:
        out["flow"].append(("They receive · estimate" if fixed_source else "They receive", get))
    headline = _number(str(detail.get("netSavings") or "").split(" ")[0])
    if headline is not None and headline > Decimal("0.005"):
        out["flow"].append(("You save vs your bank wire", _money(detail["netSavings"])))
    if detail.get("maskedAccount"):
        ccy = (str(detail.get("recipientGets") or "").split() + [""])[1:2][0]
        out["account"] = f"Saved {ccy} details {detail['maskedAccount']}".replace("  ", " ")
    selected = next((o for o in decision.get("options", []) if isinstance(o, dict) and o.get("intentId") == decision.get("intentId") and o.get("intentId")), {})
    out["route"] = _route(detail.get("routeLabel") or selected.get("label")) or RAIL.get(chosen)
    reasons = [r for r in decision.get("reasons", []) if isinstance(r, str) and not r.startswith("compared:")]
    if decision.get("decision") == "approve" and reasons:
        out["routeWhy"] = reasons[0]
    elif decision.get("decision") != "approve":
        out["notes"] = reasons[:3]
        needs = [x for x in decision.get("needs", []) if isinstance(x, str)]
        if needs:
            out["notes"].insert(0, "Before release: " + "; ".join(needs[:4]))

    # Compared with your bank wire
    rows, baseline = [], detail.get("baseline") if isinstance(detail.get("baseline"), dict) else {}
    saving, fee = _number(str(detail.get("netSavings") or "").split(" ")[0]), _money(detail.get("platformFee"))
    if chosen == "bank" and (saving is None or saving <= Decimal("0.005")):
        rows.append(("Result", "Your bank is the best route here"))
    elif saving is not None:
        rows.append(("You save vs your bank", f"{_money(detail['netSavings'])}" + (f" after Route402's {fee} fee" if fee else ", after our fee")))
    if baseline and fixed_source and get and _money(baseline.get("recipientNet")):
        rows.append(("Supplier receives", f"{get} here vs {_money(baseline['recipientNet'])} through your bank"))
    elif baseline and pay and _money(baseline.get("sourceDebit")):
        rows.append(("You pay", f"{pay} here vs {_money(baseline['sourceDebit'])} through your bank"))
    arrival = _arrival(detail) or _date(selected.get("arrivalUtc") or (decision.get("timing") or {}).get("arrivalUtc"))
    if arrival:
        rows.append(("Arrives", arrival))
    cost = detail.get("costVsMidBps") if isinstance(detail.get("costVsMidBps"), dict) else {}
    ours, bank = _pct(cost.get("withPlatformFee", cost.get("plan"))), _pct(cost.get("bank"))
    if ours is None:
        ours = _pct(selected.get("costBps"))
    if ours:
        rows.append(("Cost above the market rate", ours + " this route" + (f" · {bank} your bank" if bank else "")))
    if rows:
        out["sections"].append(("Compared with your bank wire", rows))

    # What this costs
    legs = [leg for leg in detail.get("legs") or [] if isinstance(leg, dict)]
    rows = []
    transfer, payout = _sum(leg.get("fundingFee") for leg in legs), _sum(leg.get("payoutFee") for leg in legs)
    if transfer or payout:
        rows.append(("Fees (already included)", " + ".join([f"{x} transfer" for x in transfer] + [f"{x} payout" for x in payout])))
    if fee and fee.split()[0] not in ("0.00", "0"):
        rows.append(("Route402 fee", f"{fee} (included in what you pay)"))
    exchange = [f"{_amount(leg.get('funded'))} × {leg.get('fxRate')}" for leg in legs
                if leg.get("fxRate") and _number(leg["fxRate"]) not in (None, Decimal(1))]
    if exchange:
        rows.append(("Exchange", " · ".join(exchange)))
    expiry = _date(detail.get("expiresAt"))
    if expiry:
        rows.append(("Quote valid until", expiry))
    if rows:
        out["sections"].append(("What this costs", rows))

    # Other routes the routing agent bought quotes for
    rows = []
    for o in decision.get("options", []):
        if not isinstance(o, dict) or o.get("provider") == chosen or (o.get("intentId") and o.get("intentId") == decision.get("intentId")):
            continue
        label = RAIL.get(o.get("provider")) or str(o.get("label") or o.get("provider") or "Route")
        if not o.get("eligible"):
            rows.append((label, str(o.get("why") or "not eligible for this payment")[:240]))
        else:
            bits = [x for x in (f"{_pct(o.get('costBps'))} above market" if _pct(o.get("costBps")) else None,
                                f"arrives {_date(o.get('arrivalUtc'))}" if _date(o.get("arrivalUtc")) else None,
                                f"risk {o['risk']}/5" if o.get("risk") is not None else None) if x]
            rows.append((label, " · ".join(bits) or "eligible"))
    if rows:
        out["sections"].append(("Other routes", rows))

    # How we got here
    searched = detail.get("searched") if isinstance(detail.get("searched"), dict) else {}
    rows = []
    if searched.get("routes"):
        rows.append(("Routes compared", f"{searched['routes']} compared · {searched.get('eligible', 0)} qualified"))
        nets = [str(n) for n in searched.get("networks") or []]
        where = ", ".join(str(r) for r in searched.get("rails") or [])
        if nets:
            where += f" · {len(nets)} blockchain network{'s' if len(nets) != 1 else ''} ({', '.join(nets)})"
        if where:
            rows.append(("Where we searched", where))
        excluded = searched.get("excluded") if isinstance(searched.get("excluded"), dict) else {}
        if excluded:
            rows.append(("Ruled out", " · ".join(f"{n} {k}" for k, n in excluded.items())))
    objective = detail.get("objective") or decision.get("objective")
    rows.append(("Decision rule", _RULE.get(objective, "Lowest total cost plus the cost of money in transit") + ", after the compliance and safety checks"))
    market = detail.get("market") if isinstance(detail.get("market"), dict) else {}
    if market.get("srcCcy") == "USD" and market.get("rate") not in (None, "?"):
        rows.append(("Market rate", f"1 USD = {market['rate']} {market.get('destCcy', '')} · {market.get('source', '')}".rstrip(" ·")))
    out["sections"].append(("How we got here", rows))
    return out


def _secs(ms):
    return "" if ms is None else f"{ms} ms" if ms < 1000 else f"{ms / 1000:.1f} s"


def agent_trail(answer):
    """'How your agents handled this', from the hops and paid calls the agents reported. Returns (summary, steps) or None."""
    hops = [h for h in answer.get("hops") or [] if isinstance(h, dict)]
    paid = [c for c in answer.get("paidCalls") or [] if isinstance(c, dict)]
    decisions = [d for d in answer.get("decisions") or [] if isinstance(d, dict)]
    if not paid and not decisions:
        return None
    quotes = [c for c in paid if "quote" in str(c.get("service", ""))]
    screens = [c for c in paid if "quote" not in str(c.get("service", ""))]
    providers = list(dict.fromkeys(_RAIL_SHORT.get(str(c.get("service")).split(":")[-1], str(c.get("service")).split(":")[-1]) for c in quotes))
    sim = paid and all(c.get("mock") for c in paid)

    def cost(calls):
        total = sum((_number(c.get("priceUsdc")) or Decimal(0)) for c in calls if not c.get("mock"))
        return " (simulated, no payment)" if sim else f" · paid {total.normalize():f} test USDC" if total > 0 else ""
    screen_hop = next((h for h in hops if h.get("to") == "compliance"), None)
    screen_done = next((h for h in hops if h.get("from") == "compliance"), None)
    quote_hop = next((h for h in hops if h.get("to") == "providers"), None)
    timed = [h for h in hops if h.get("ms") is not None]
    steps = [("Concierge agent", "Read your request and matched it to your suppliers and invoices", "")]
    if screen_hop:
        found = re.search(r"\((\d+) suppliers?\)", str(screen_hop.get("message", "")))
        n = int(found[1]) if found else len(decisions)
        steps.append(("Compliance agent", f"Checked {n} supplier{'s' if n != 1 else ''} and their bank details before any money could move{cost(screens)}",
                      _secs((screen_done or {}).get("ms"))))
    if quote_hop or quotes:
        steps.append(("Routing agent", f"Bought {len(quotes)} live quote{'s' if len(quotes) != 1 else ''}" + (f" ({', '.join(providers)})" if providers else "")
                      + f" and compared total cost and arrival time{cost(quotes)}", _secs((quote_hop or {}).get("ms"))))
    if decisions:
        ok = [d for d in decisions if d.get("decision") == "approve"]
        review = [d for d in decisions if d.get("decision") == "review"]
        held = [d for d in decisions if d.get("decision") not in ("approve", "review")]
        pref = _PREF.get(answer.get("policy"), "a balance of cost and speed")
        name = lambda d: _RAIL_SHORT.get(d.get("chosen"), str(d.get("chosen") or "a route"))
        if len(decisions) == 1:
            what = (f"Recommended your {name(ok[0])}, the best fit for {pref}" if ok
                    else f"Recommended your {name(review[0])}, but flagged a check for a person first" if review
                    else "Held this payment: " + str((held[0].get("reasons") or ["no route qualified"])[0]))
        else:
            what = ", ".join(x for x in (ok and f"{len(ok)} recommended", review and f"{len(review)} need a check first", held and f"{len(held)} held") if x)
        steps.append(("Decision", f"{what}. You still review and approve before anything is sent.", ""))
    summary = " · ".join(x for x in (f"{_secs(timed[-1]['ms'])} total" if timed else "",
                                     f"{len(paid)} paid call{'s' if len(paid) != 1 else ''}" if paid else "") if x)
    return summary, steps
