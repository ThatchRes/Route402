"""Gateway agent: the ONLY entry point for Person A's API (port 8100).
Auth + tenant check + rate limit + jobId de-dup, then a typed message to the right agent.
/coordinate returns a synchronous multi-agent trace for one instruction.
Optional: ENABLE_CHAT=1 adds the Fetch.ai chat protocol + mailbox for Agentverse/ASI:One."""
import os
import asyncio
asyncio.set_event_loop(asyncio.new_event_loop())   # Python 3.14: uAgents needs a loop to exist

import json
import time
from uagents import Agent, Context

import backend
import llm
import reasoning
from addressbook import RESOLVER, ROUTING, INVESTIGATION, LIQUIDITY, EXECUTOR, RECONCILIATION, GATEWAY_PORT
from guard import RateLimiter, JobDedupe, USAGE, safe_id, redact
from models import (ParseBody, ParseResult, RouteJobBody, InvestigateBody, LiquidityBody, ExecuteBody,
                    ReconcileBody, Accepted, TraceResult, Health, Metrics, RouteRequest, RouteResult,
                    InvestigateRequest, InvestigateResult, LiquidityRequest, LiquidityResult,
                    ExecuteStepRequest, ExecuteStepResult, ReconcileRequest, ReconcileResult)

TOKEN = os.getenv("AGENT_SERVICE_TOKEN", "dev-only-token")
ALLOWED_TENANTS = {t.strip() for t in os.getenv("ALLOWED_TENANTS", "demo-tenant").split(",") if t.strip()}
CHAT = os.getenv("ENABLE_CHAT", "0") == "1"

kwargs = dict(name="gateway", seed=os.environ["GATEWAY_SEED"], port=GATEWAY_PORT, resolve=RESOLVER)
if CHAT:
    kwargs.update(mailbox=True, publish_agent_details=True)
else:
    kwargs.update(endpoint=[f"http://127.0.0.1:{GATEWAY_PORT}/submit"])
gateway = Agent(**kwargs)

limiter = RateLimiter(int(os.getenv("RATE_LIMIT_PER_MIN", "120")))
dedupe = JobDedupe()


def check(req, route: str):
    """Returns an error string, or None if the request may proceed."""
    if req.serviceToken != TOKEN:
        USAGE.rejected["unauthorized"] += 1
        return "unauthorized"
    if req.tenantId not in ALLOWED_TENANTS:
        USAGE.rejected["tenant"] += 1
        return "tenant_not_allowed"
    try:
        safe_id(req.correlationId, "correlationId")
        for f in ("jobId", "intentId", "transferId", "queueId", "stepId", "idempotencyKey"):
            if hasattr(req, f):
                safe_id(getattr(req, f), f)
    except ValueError as e:
        USAGE.rejected["invalid_id"] += 1
        return str(e)
    if not limiter.allow(f"{req.tenantId}:{route}"):
        USAGE.rejected["rate_limited"] += 1
        return "rate_limited"
    return None


async def dispatch(ctx, req, route, dest, msg):
    err = check(req, route)
    if err:
        return Accepted(accepted=False, jobId=req.jobId, error=err)
    if not dedupe.first_time(f"{req.tenantId}:{req.jobId}"):
        return Accepted(accepted=True, jobId=req.jobId, duplicate=True)   # acknowledged, NOT re-dispatched
    await ctx.send(dest, msg)
    return Accepted(accepted=True, jobId=req.jobId)


# ------------------------------------------------------------------ REST
@gateway.on_rest_get("/health", Health)
async def health(ctx: Context) -> Health:
    return Health(status="ok", mockApi=backend.MOCK, llmEnabled=llm.ENABLED,
                  agents={"gateway": gateway.address, "routing": ROUTING, "liquidity": LIQUIDITY,
                          "executionCoordinator": EXECUTOR, "reconciliation": RECONCILIATION,
                          "investigation": INVESTIGATION})


@gateway.on_rest_get("/metrics", Metrics)
async def metrics(ctx: Context) -> Metrics:
    """Gateway counters merged with the workers' snapshot (workers write metrics.json every 10s)."""
    snap = USAGE.snapshot()
    try:
        with open(os.path.join(os.path.dirname(__file__), "metrics.json")) as f:
            w = json.load(f)
        snap["toolCalls"] = w.get("toolCalls", {})
        snap["avgToolLatencyMs"] = w.get("avgToolLatencyMs", 0.0)
        snap["llmCalls"] += w.get("llmCalls", 0)
        snap["llmInputTokens"] += w.get("llmInputTokens", 0)
        snap["llmOutputTokens"] += w.get("llmOutputTokens", 0)
    except (OSError, ValueError):
        pass
    return Metrics(**snap)


@gateway.on_rest_post("/parse", ParseBody, ParseResult)
async def parse(ctx: Context, req: ParseBody) -> ParseResult:
    err = check(req, "parse")
    if err:
        return ParseResult(status="error", intent=None, clarification=err, source="none",
                           correlationId=req.correlationId)
    status, intent, q, source = await reasoning.parse_intent(req.message, req.accounts, req.nowUtc, req.timezone)
    return ParseResult(status=status, intent=intent, clarification=q, source=source,
                       correlationId=req.correlationId)


@gateway.on_rest_post("/route-jobs", RouteJobBody, Accepted)
async def route_job(ctx: Context, req: RouteJobBody) -> Accepted:
    return await dispatch(ctx, req, "route", ROUTING, RouteRequest(
        jobId=req.jobId, tenantId=req.tenantId, intentId=req.intentId, correlationId=req.correlationId))


@gateway.on_rest_post("/coordinate", RouteJobBody, TraceResult)
async def coordinate(ctx: Context, req: RouteJobBody) -> TraceResult:
    """One instruction, several agents, one correlationId: gateway -> routing -> liquidity -> routing -> gateway."""
    err = check(req, "coordinate")
    if err:
        return TraceResult(correlationId=req.correlationId, hops=[], route=None, error=err)
    t0 = time.time()
    reply, status = await ctx.send_and_receive(
        ROUTING, RouteRequest(jobId=req.jobId, tenantId=req.tenantId, intentId=req.intentId,
                              correlationId=req.correlationId), response_type=RouteResult, timeout=30)
    if not isinstance(reply, RouteResult):
        return TraceResult(correlationId=req.correlationId, hops=[], route=None,
                           error=f"routing agent did not reply: {status}")
    hops = [{"from": "gateway", "to": "routing", "message": "RouteRequest", "status": "delivered"}]
    if reply.funding and reply.funding.get("hop"):
        h = reply.funding["hop"]
        hops += [{"from": h["from"], "to": h["to"], "message": "FundingCheckRequest", "status": "delivered"},
                 {"from": h["to"], "to": h["from"], "message": "FundingCheckResult", "status": "delivered",
                  "ms": h["ms"]}]
    hops.append({"from": "routing", "to": "gateway", "message": "RouteResult", "status": reply.status,
                 "ms": round((time.time() - t0) * 1000)})
    return TraceResult(correlationId=req.correlationId, hops=hops, route=reply.dict())


@gateway.on_rest_post("/investigate", InvestigateBody, Accepted)
async def investigate(ctx: Context, req: InvestigateBody) -> Accepted:
    return await dispatch(ctx, req, "investigate", INVESTIGATION, InvestigateRequest(
        jobId=req.jobId, tenantId=req.tenantId, transferId=req.transferId, correlationId=req.correlationId))


@gateway.on_rest_post("/liquidity-jobs", LiquidityBody, Accepted)
async def liquidity_job(ctx: Context, req: LiquidityBody) -> Accepted:
    if req.kind not in ("queue", "treasury_rebalance"):
        return Accepted(accepted=False, jobId=req.jobId, error="unsupported kind")
    return await dispatch(ctx, req, "liquidity", LIQUIDITY, LiquidityRequest(
        jobId=req.jobId, tenantId=req.tenantId, queueId=req.queueId, correlationId=req.correlationId,
        kind=req.kind))


@gateway.on_rest_post("/execute-requests", ExecuteBody, Accepted)
async def execute_req(ctx: Context, req: ExecuteBody) -> Accepted:
    return await dispatch(ctx, req, "execute", EXECUTOR, ExecuteStepRequest(
        jobId=req.jobId, tenantId=req.tenantId, transferId=req.transferId, planVersion=req.planVersion,
        termsHash=req.termsHash, stepId=req.stepId, idempotencyKey=req.idempotencyKey,
        correlationId=req.correlationId))


@gateway.on_rest_post("/reconcile", ReconcileBody, Accepted)
async def reconcile(ctx: Context, req: ReconcileBody) -> Accepted:
    return await dispatch(ctx, req, "reconcile", RECONCILIATION, ReconcileRequest(
        jobId=req.jobId, tenantId=req.tenantId, transferId=req.transferId, correlationId=req.correlationId))


# ------------------------------------------------------------------ replies (visible trace)
@gateway.on_message(model=RouteResult)
async def got_route(ctx: Context, sender: str, msg: RouteResult):
    ctx.logger.info(f"[{msg.correlationId}] routing replied: {msg.status} {msg.mode} {msg.rankedQuoteIds} "
                    f"funding={'ok' if (msg.funding or {}).get('feasible') else 'n/a or hold'}")


@gateway.on_message(model=LiquidityResult)
async def got_liq(ctx: Context, sender: str, msg: LiquidityResult):
    ctx.logger.info(f"[{msg.correlationId}] liquidity replied: {msg.status} {msg.proposalId} advisory={msg.advisoryOnly}")


@gateway.on_message(model=ExecuteStepResult)
async def got_exec(ctx: Context, sender: str, msg: ExecuteStepResult):
    ctx.logger.info(f"[{msg.correlationId}] executor replied: gate={msg.backendStatus} step={msg.stepStatus} "
                    f"next={msg.nextAction}")


@gateway.on_message(model=ReconcileResult)
async def got_rec(ctx: Context, sender: str, msg: ReconcileResult):
    ctx.logger.info(f"[{msg.correlationId}] reconciliation replied: {msg.outcome} outstanding={msg.outstandingObligation}")


@gateway.on_message(model=InvestigateResult)
async def got_inv(ctx: Context, sender: str, msg: InvestigateResult):
    ctx.logger.info(f"[{msg.correlationId}] investigation replied: {msg.exceptionType} missing={msg.missingEvidence}")


# ------------------------------------------------------------------ optional chat protocol
if CHAT:
    from datetime import datetime, timezone
    from uuid import uuid4
    from uagents import Protocol
    from uagents_core.contrib.protocols.chat import (ChatAcknowledgement, ChatMessage, TextContent,
                                                     EndSessionContent, chat_protocol_spec)

    chat = Protocol(spec=chat_protocol_spec)
    CHAT_TENANT = os.getenv("CHAT_TENANT", "demo-tenant")

    @chat.on_message(ChatMessage)
    async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
        await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc),
                                                   acknowledged_msg_id=msg.msg_id))
        text = "".join(c.text for c in msg.content if isinstance(c, TextContent)).strip()
        corr = f"chat-{uuid4().hex[:12]}"
        parts = text.split()
        answer = "Commands: 'status <transferId>' or 'route <intentId>'. Read-only; I cannot move money."
        if len(parts) == 2 and parts[0].lower() in ("status", "route"):
            try:
                ref = safe_id(parts[1], "id")
                if parts[0].lower() == "status":
                    r, _ = await ctx.send_and_receive(INVESTIGATION, InvestigateRequest(
                        jobId=corr, tenantId=CHAT_TENANT, transferId=ref, correlationId=corr),
                        response_type=InvestigateResult, timeout=30)
                    answer = (f"{r.exceptionType}. Missing: {', '.join(r.missingEvidence) or 'nothing'}. "
                              + " ".join(r.hypotheses)) if r else "Investigation agent did not reply."
                else:
                    r, _ = await ctx.send_and_receive(ROUTING, RouteRequest(
                        jobId=corr, tenantId=CHAT_TENANT, intentId=ref, correlationId=corr),
                        response_type=RouteResult, timeout=30)
                    answer = r.explanation if r else "Routing agent did not reply."
            except ValueError:
                answer = "Invalid id."
        await ctx.send(sender, ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(),
                                           content=[TextContent(type="text", text=redact(answer)),
                                                    EndSessionContent(type="end-session")]))

    @chat.on_message(ChatAcknowledgement)
    async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
        pass

    gateway.include(chat, publish_manifest=True)


if __name__ == "__main__":
    gateway.run()
