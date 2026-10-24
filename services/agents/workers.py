"""Five operational agents in one Bureau (one process, port 8101).
Routing -> Liquidity is a real agent-to-agent hop; ExecutionCoordinator -> Reconciliation on UNKNOWN."""
import os
import asyncio
asyncio.set_event_loop(asyncio.new_event_loop())   # Python 3.14: uAgents needs a loop to exist

import functools
import json
import time
from uagents import Agent, Bureau, Context

import backend
import reasoning
from addressbook import RESOLVER, WORKERS_PORT, GATEWAY, ROUTING, EXECUTOR, LIQUIDITY, RECONCILIATION, COMPLIANCE, COMPLIANCE_SEED
from guard import redact, USAGE, safe_id, RateLimiter
from local_network import configure_local_network
configure_local_network()
from models import (RouteRequest, RouteResult, FundingCheckRequest, FundingCheckResult,
                    LiquidityRequest, LiquidityResult, ExecuteStepRequest, ExecuteStepResult,
                    ReconcileRequest, ReconcileResult, InvestigateRequest, InvestigateResult,
                    ProcureRequest, ProcureResult, ScreenRequest, ScreenResult)

# Routing and compliance handle several payments at once (each one waits on paid calls)
routing = Agent(name="routing", seed=os.environ["ROUTING_SEED"], resolve=RESOLVER, handle_messages_concurrently=True)
compliance = Agent(name="compliance", seed=COMPLIANCE_SEED, resolve=RESOLVER, handle_messages_concurrently=True)
investigation = Agent(name="investigation", seed=os.environ["INVESTIGATION_SEED"], resolve=RESOLVER)
liquidity = Agent(name="liquidity", seed=os.environ["LIQUIDITY_SEED"], resolve=RESOLVER)
executor = Agent(name="execution_coordinator", seed=os.environ["EXECUTOR_SEED"], resolve=RESOLVER)
reconciler = Agent(name="reconciliation", seed=os.environ["RECONCILIATION_SEED"], resolve=RESOLVER)


def log(ctx, corr, text):
    ctx.logger.info(redact(f"[{corr}] {text}"))


_SENDERS = {"on_route": {GATEWAY}, "on_funding_check": {ROUTING}, "on_liquidity": {GATEWAY},
            "on_execute": {GATEWAY}, "on_reconcile": {GATEWAY, EXECUTOR}, "on_investigate": {GATEWAY},
            "on_screen": {ROUTING}, "on_procure": {GATEWAY}}
_TENANTS = {v.strip() for v in os.getenv("ALLOWED_TENANTS", "demo-tenant").split(",") if v.strip()}
_MESSAGES = RateLimiter(120)


def guarded(handler):
    """Invalid IDs or tool failures produce a logged rejection, never a crash or a guessed answer."""
    @functools.wraps(handler)
    async def wrapper(ctx, sender, msg):
        try:
            if sender not in _SENDERS.get(handler.__name__, set()):
                raise ValueError("unauthorized agent sender")
            if getattr(msg, "tenantId", None) not in _TENANTS:
                raise ValueError("tenant not allowed")
            safe_id(msg.correlationId, "correlationId")
            if not _MESSAGES.allow(f"{sender}:{handler.__name__}"):
                raise ValueError("agent message rate limit")
            if isinstance(msg, ProcureRequest) and len(msg.payments) > 25:
                raise ValueError("at most 25 payments per review")
            await handler(ctx, sender, msg)
        except Exception as e:  # noqa: BLE001
            USAGE.rejected[type(e).__name__] += 1
            ctx.logger.warning(redact(f"[{getattr(msg, 'correlationId', '?')}] rejected: {e}"))
    return wrapper


@routing.on_interval(period=10.0)
async def write_metrics(ctx: Context):
    with open(os.getenv("AGENT_METRICS_FILE", os.path.join(os.path.dirname(__file__), "metrics.json")), "w") as f:
        json.dump(USAGE.snapshot(), f)


# ------------------------------------------------------------------ RoutingAgent
@routing.on_message(model=RouteRequest, replies=RouteResult)
@guarded
async def on_route(ctx: Context, sender: str, msg: RouteRequest):
    log(ctx, msg.correlationId, f"routing job {msg.jobId} intent {msg.intentId}")
    try:
        quotes = await backend.collect_quotes(msg.tenantId, msg.intentId, msg.correlationId)
        rank = await backend.rank_quotes(msg.tenantId, msg.intentId, [q["id"] for q in quotes], msg.correlationId)
        funding = None
        if msg.checkFunding and rank.get("ranked"):
            t0 = time.time()
            reply, status = await ctx.send_and_receive(
                LIQUIDITY, FundingCheckRequest(tenantId=msg.tenantId, intentId=msg.intentId,
                                               quoteIds=rank["ranked"][:1], correlationId=msg.correlationId),
                response_type=FundingCheckResult, timeout=15)
            if isinstance(reply, FundingCheckResult):
                funding = {**reply.dict(), "hop": {"from": "routing", "to": "liquidity",
                                                   "ms": round((time.time() - t0) * 1000)}}
            else:
                funding = {"feasible": False, "notes": [f"liquidity agent unavailable: {status}"]}
        text, source = await reasoning.explain_routes(rank, quotes, funding)
        status_ = "ok" if rank.get("ranked") else "no_route"
        if funding is not None and not funding.get("feasible"):
            status_ = "hold"
        refs = [q["id"] for q in quotes] + [x for x in (rank.get("decisionRecordId"),
                                                        (funding or {}).get("snapshotId")) if x]
        result = RouteResult(jobId=msg.jobId, tenantId=msg.tenantId, correlationId=msg.correlationId,
                             status=status_, mode=rank.get("mode"), rankedQuoteIds=rank.get("ranked", []),
                             allocations=rank.get("allocations", []), excluded=rank.get("excluded", []),
                             baseline=rank.get("baseline"), funding=funding, explanation=text,
                             explanationSource=source, evidenceRefs=refs)
    except Exception as e:  # noqa: BLE001  timeouts / missing data -> explicit error, never a guess
        result = RouteResult(jobId=msg.jobId, tenantId=msg.tenantId, correlationId=msg.correlationId,
                             status="error", mode=None, rankedQuoteIds=[], allocations=[], excluded=[],
                             baseline=None, funding=None, explanation=redact(f"Quote coverage incomplete: {e}"),
                             explanationSource="deterministic_fallback", evidenceRefs=[])
    await backend.post_job_result(msg.tenantId, msg.jobId, msg.correlationId, result.dict())
    await backend.post_observation(msg.tenantId, msg.jobId, msg.correlationId, "routing-agent",
                                   result.explanation, result.evidenceRefs)
    await ctx.send(sender, result)


# ------------------------------------------------------------------ LiquidityAgent
@liquidity.on_message(model=FundingCheckRequest, replies=FundingCheckResult)
@guarded
async def on_funding_check(ctx: Context, sender: str, msg: FundingCheckRequest):
    log(ctx, msg.correlationId, f"funding check for {msg.quoteIds}")
    f = await backend.funding_check(msg.tenantId, msg.intentId, msg.quoteIds, msg.correlationId)
    fc = await backend.get_forecast(msg.tenantId, msg.intentId, msg.correlationId)
    await ctx.send(sender, FundingCheckResult(
        tenantId=msg.tenantId, correlationId=msg.correlationId, feasible=bool(f.get("feasible")),
        confirmedAvailable=f.get("confirmedAvailable", {}), reserved=f.get("reserved", {}),
        forecastAdvisory=fc, blockedPools=f.get("blockedPools", []), snapshotId=f.get("snapshotId"),
        notes=f.get("notes", []) + ["Forecast is advisory and not counted as available funds"]))


@liquidity.on_message(model=LiquidityRequest, replies=LiquidityResult)
@guarded
async def on_liquidity(ctx: Context, sender: str, msg: LiquidityRequest):
    log(ctx, msg.correlationId, f"{msg.kind} proposal for {msg.queueId}")
    inv = await backend.get_inventory(msg.tenantId, msg.queueId, msg.correlationId)
    prop = await backend.request_queue_proposal(msg.tenantId, msg.queueId, msg.kind, msg.correlationId)
    fc = await backend.get_forecast(msg.tenantId, msg.queueId, msg.correlationId)
    m = prop.get("metrics", {})
    summary = (f"{msg.kind} proposal {prop.get('proposalId')} vs {prop.get('baseline')}: "
               f"peak prefunding {m.get('peakPrefunding', {}).get('plan')} vs {m.get('peakPrefunding', {}).get('baseline')}, "
               f"on-time {m.get('onTime', {}).get('plan')} vs {m.get('onTime', {}).get('baseline')}, "
               f"net cost change {m.get('netCostDelta')}. Advisory only; forecast inflows are not spendable.")
    if prop.get("status") == "hold":
        summary = f"No feasible {msg.kind} plan: HOLD. " + "; ".join(prop.get("assumptions", []))
    res = LiquidityResult(jobId=msg.jobId, tenantId=msg.tenantId, correlationId=msg.correlationId,
                          status=prop.get("status", "ok"), proposalId=prop.get("proposalId"),
                          confirmed=inv.get("confirmed", {}), reserved=inv.get("reserved", {}),
                          pendingIncoming=inv.get("pendingIncoming", {}), forecast=fc, metrics=m,
                          blockedPools=prop.get("blockedPools", []), advisoryOnly=True, summary=summary,
                          evidenceRefs=[x for x in (prop.get("proposalId"), inv.get("snapshotId")) if x])
    await backend.post_observation(msg.tenantId, msg.queueId, msg.correlationId, "liquidity-agent",
                                   summary, res.evidenceRefs)
    await ctx.send(sender, res)


# ------------------------------------------------------------------ ExecutionCoordinatorAgent
@executor.on_message(model=ExecuteStepRequest, replies=ExecuteStepResult)
@guarded
async def on_execute(ctx: Context, sender: str, msg: ExecuteStepRequest):
    # Holds no keys. Only asks A's gate, with ONE fixed idempotency key per step.
    log(ctx, msg.correlationId, f"execute request {msg.transferId} v{msg.planVersion} step {msg.stepId}")
    if not msg.termsHash or msg.planVersion < 1:
        res = ExecuteStepResult(jobId=msg.jobId, tenantId=msg.tenantId, correlationId=msg.correlationId,
                                accepted=False, backendStatus="NOT_SENT", stepStatus=None,
                                nextAction="operator_review", detail="missing approved plan version/termsHash")
        await ctx.send(sender, res)
        return
    out = await backend.request_execute_step(msg.tenantId, msg.transferId, msg.planVersion, msg.termsHash,
                                             msg.stepId, msg.idempotencyKey, msg.correlationId)
    step = None
    next_action = "wait"
    if out["status"] == "UNKNOWN":
        step, next_action = "UNKNOWN", "reconcile_first"
        await ctx.send(RECONCILIATION, ReconcileRequest(jobId=f"{msg.jobId}-rec", tenantId=msg.tenantId,
                                                        transferId=msg.transferId, correlationId=msg.correlationId))
    elif out["status"] == "REJECTED":
        next_action = "operator_review"
    else:
        step = (await backend.get_step_status(msg.tenantId, msg.transferId, msg.stepId, msg.correlationId)
                ).get("stepStatus")
        next_action = "reconcile_first" if step == "UNKNOWN" else ("none" if step == "CONFIRMED" else "wait")
    res = ExecuteStepResult(jobId=msg.jobId, tenantId=msg.tenantId, correlationId=msg.correlationId,
                            accepted=out["status"] == "ENQUEUED", backendStatus=out["status"],
                            stepStatus=step, nextAction=next_action, detail=redact(out["detail"]))
    await backend.post_observation(msg.tenantId, msg.transferId, msg.correlationId, "execution-coordinator",
                                   f"Requested {msg.stepId} v{msg.planVersion}: gate={out['status']}, "
                                   f"step={step}, next={next_action}", [msg.idempotencyKey])
    await ctx.send(sender, res)


# ------------------------------------------------------------------ ReconciliationAgent
@reconciler.on_message(model=ReconcileRequest, replies=ReconcileResult)
@guarded
async def on_reconcile(ctx: Context, sender: str, msg: ReconcileRequest):
    log(ctx, msg.correlationId, f"reconcile {msg.transferId}")
    view = await backend.get_reconciliation_view(msg.tenantId, msg.transferId, msg.correlationId)
    outcome, legs, outstanding, actions, refs = reasoning.reconcile(view.get("legs", []), view.get("outstanding"))
    summary = f"Reconciliation outcome {outcome}" + (f"; outstanding {outstanding}" if outstanding else "") + "."
    res = ReconcileResult(jobId=msg.jobId, tenantId=msg.tenantId, correlationId=msg.correlationId,
                          outcome=outcome, legs=legs, outstandingObligation=outstanding,
                          allowedNextActions=actions, summary=summary, evidenceRefs=refs)
    await backend.post_observation(msg.tenantId, msg.transferId, msg.correlationId, "reconciliation-agent",
                                   summary, refs)
    await ctx.send(sender, res)


# ------------------------------------------------------------------ InvestigationAgent
@investigation.on_message(model=InvestigateRequest, replies=InvestigateResult)
@guarded
async def on_investigate(ctx: Context, sender: str, msg: InvestigateRequest):
    log(ctx, msg.correlationId, f"investigate {msg.transferId}")
    events = await backend.get_events(msg.tenantId, msg.transferId, msg.correlationId)
    exc, facts, missing, hyp, actions, source, refs = await reasoning.investigate(events)
    res = InvestigateResult(jobId=msg.jobId, tenantId=msg.tenantId, correlationId=msg.correlationId,
                            exceptionType=exc, observedFacts=facts, missingEvidence=missing, hypotheses=hyp,
                            suggestedActions=actions, summarySource=source, evidenceRefs=refs)
    await backend.post_observation(msg.tenantId, msg.transferId, msg.correlationId, "investigation-agent",
                                   f"{exc}: missing {missing}; " + "; ".join(hyp), refs)
    await ctx.send(sender, res)


# ------------------------------------------------------------------ paid procurement (x402 pay-per-call)
def _evidence(r: dict, who: str) -> dict:
    p = dict(r.get("payment") or {})
    p["buyer"] = who
    if r.get("mock"):
        p["mock"] = True
    return p


@compliance.on_message(model=ScreenRequest, replies=ScreenResult)
@guarded
async def on_screen(ctx: Context, sender: str, msg: ScreenRequest):
    """ComplianceAgent buys one supplier screen per payment with x402 and reports them. It never approves a payment."""
    log(ctx, msg.correlationId, f"screening {len(msg.items)} supplier(s): buying 1 screen call each via x402")

    async def one(item):
        r = await backend.paid_call("compliance", {"beneficiary": item["beneficiary"]}, msg.correlationId, "compliance-agent")
        d = r.get("data") or {}
        return {"payable": item["payable"], "status": d.get("status", "UNAVAILABLE") if r.get("ok") else "UNAVAILABLE",
                "errors": d.get("errors", []) if r.get("ok") else [r.get("error", "screen failed")],
                "warnings": d.get("warnings", []), "notCovered": d.get("notCovered", []),
                "payment": _evidence(r, "compliance-agent") if r.get("ok") else None}
    results = await asyncio.gather(*(one(i) for i in msg.items))
    await ctx.send(sender, ScreenResult(correlationId=msg.correlationId, results=list(results)))


PROVIDER_IDS = ("stablecoin", "bank")      # OUR stablecoin rail, or the company's OWN bank


@routing.on_message(model=ProcureRequest, replies=ProcureResult)
@guarded
async def on_procure(ctx: Context, sender: str, msg: ProcureRequest):
    """RoutingAgent: for every payment, buys a quote from EACH provider (our stablecoin rail and the company's own bank;
    separate x402 sellers, separate payees),
    asks ComplianceAgent for a paid supplier screen (agent-to-agent), then chooses one provider under the company's
    policy (cheapest | fastest | lowest_risk) or holds the payment."""
    corr, pays, policy = msg.correlationId, msg.payments, msg.policy
    log(ctx, corr, f"{len(pays)} payment(s), policy '{policy}': buying {len(pays) * len(PROVIDER_IDS)} provider quotes via x402; "
                   f"asking compliance agent to screen suppliers")
    t0 = time.time()
    hops = [{"from": "concierge", "to": "routing", "message": f"ProcureRequest ({len(pays)} payments, policy {policy})"}]

    def body(p):
        ben = p.get("beneficiary") or {}
        # invoice payments fix what the supplier receives; a budget payment (amountType SOURCE_FIXED) fixes what the company sends
        amount_type = p.get("amountType") if p.get("amountType") in ("RECIPIENT_FIXED", "SOURCE_FIXED") else "RECIPIENT_FIXED"
        return {"srcCcy": msg.srcCcy, "destCcy": p["destCcy"], "amountType": amount_type, "amount": p["amount"],
                "deadlineUtc": p.get("deadlineUtc"), "objective": "fastest" if policy == "fastest" else "cheapest", "currentBank": msg.currentBank,
                "beneficiary": ben, "beneficiaryAcceptsUsdc": bool(ben.get("usdcWallet")), "reference": p.get("reference") or p["payable"]}
    jobs = [(i, pid) for i in range(len(pays)) for pid in PROVIDER_IDS]
    quotes_task = asyncio.ensure_future(asyncio.gather(*(backend.paid_call(f"quote:{pid}", body(pays[i]), corr, "routing-agent") for i, pid in jobs)))
    screen, status = await ctx.send_and_receive(
        COMPLIANCE, ScreenRequest(tenantId=msg.tenantId, correlationId=corr,
                                  items=[{"payable": p["payable"], "beneficiary": p["beneficiary"]} for p in pays]),
        response_type=ScreenResult, timeout=170)
    screens = {r["payable"]: r for r in screen.results} if isinstance(screen, ScreenResult) else {}
    hops += [{"from": "routing", "to": "compliance", "message": f"ScreenRequest ({len(pays)} suppliers)"},
             {"from": "compliance", "to": "routing", "message": "ScreenResult" if screens else f"no reply: {status}",
              "ms": round((time.time() - t0) * 1000)}]
    raw = await quotes_task
    hops.append({"from": "routing", "to": "providers", "message": f"{len(jobs)} paid quotes ({len(PROVIDER_IDS)} providers)",
                 "ms": round((time.time() - t0) * 1000)})
    results = []
    for i, p in enumerate(pays):
        quotes, paid = {}, []
        for (j, pid), q in zip(jobs, raw):
            if j != i:
                continue
            quotes[pid] = q.get("data") if q.get("ok") else {"status": "NO_QUOTE", "detail": q.get("error")}
            if q.get("ok"):
                paid.append(_evidence(q, "routing-agent"))
        scr = screens.get(p["payable"])
        if scr and scr.get("payment"):
            paid.append(scr["payment"])
        d = reasoning.choose_route(quotes, scr, policy, deadline_utc=p.get("deadlineUtc"))
        log(ctx, corr, f"{p['payable']}: {d['decision']} -> {d['chosen'] or '-'} ({d['reasons'][0]})")
        results.append({"payable": p["payable"], **d, "screen": scr, "paidCalls": paid})
    hops.append({"from": "routing", "to": "concierge", "message": "ProcureResult",
                 "status": ", ".join(f"{r['payable']}={r['decision']}:{r['chosen']}" for r in results), "ms": round((time.time() - t0) * 1000)})
    await ctx.send(sender, ProcureResult(correlationId=corr, results=results, hops=hops))


bureau = Bureau(port=WORKERS_PORT, endpoint=f"http://127.0.0.1:{WORKERS_PORT}/submit")
for a in (routing, investigation, liquidity, executor, reconciler, compliance):
    bureau.add(a)

if __name__ == "__main__":
    bureau.run()
