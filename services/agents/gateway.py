"""Concierge (gateway) agent: the front door for people and for Person A's API (port 8100).
Auth + tenant check + rate limit + jobId de-dup, then a typed message to the right agent.
/ask     everyday prompt -> calculator preview -> routing agent buys quotes + compliance agent buys screens (x402)
         -> approve/hold per payment, with the on-chain evidence of every paid call
/review  same review for an explicit payment run (used by `npm run import -- nessie run`)
/coordinate returns a synchronous multi-agent trace for one instruction.
ENABLE_CHAT=1 (default for the demo) adds the Fetch.ai chat protocol + Agentverse mailbox, so ASI:One can reach it."""
import os
import asyncio
asyncio.set_event_loop(asyncio.new_event_loop())   # Python 3.14: uAgents needs a loop to exist

import json
import re
import time
from decimal import Decimal
from uagents import Agent, Context

import backend
import llm
import context_llm
import reasoning
from local_network import configure_local_network
configure_local_network()
from addressbook import RESOLVER, ROUTING, INVESTIGATION, LIQUIDITY, EXECUTOR, RECONCILIATION, COMPLIANCE, GATEWAY_PORT
from guard import RateLimiter, JobDedupe, USAGE, safe_id, redact
from models import (ParseBody, ParseResult, RouteJobBody, InvestigateBody, LiquidityBody, ExecuteBody,
                    ReconcileBody, Accepted, TraceResult, Health, Metrics, RouteRequest, RouteResult,
                    InvestigateRequest, InvestigateResult, LiquidityRequest, LiquidityResult,
                    ExecuteStepRequest, ExecuteStepResult, ReconcileRequest, ReconcileResult,
                    AskBody, ReviewBody, AskResult, ProcureRequest, ProcureResult)

TOKEN = os.getenv("AGENT_SERVICE_TOKEN", "dev-only-token")
ALLOWED_TENANTS = {t.strip() for t in os.getenv("ALLOWED_TENANTS", "demo-tenant").split(",") if t.strip()}
CHAT = os.getenv("ENABLE_CHAT", "1") == "1"
README = os.path.join(os.path.dirname(__file__), "AGENT_README.md")

kwargs = dict(name=os.getenv("AGENT_NAME", "Cross-Border AP Concierge"), seed=os.environ["GATEWAY_SEED"], port=GATEWAY_PORT,
              resolve=RESOLVER, handle_messages_concurrently=True,
              description="Plans a company's international supplier payments: buys route quotes and supplier screens "
                          "with x402 (Base Sepolia test USDC). Linked users can review and accept demo payments in ASI:One; company approval controls still apply.",
              readme_path=README if os.path.exists(README) else None)
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
# ------------------------------------------------------------------ concierge: prompts and payment-run reviews
def payments_from_preview(r: dict) -> list:
    """Payments that need conversion, from the calculator's preview (bills paid from wallets need no quote)."""
    if r.get("template") == "pay_bills":
        run = r.get("preview") or {}
        home = run.get("homeCcy", "USD")
        return [{"payable": l["payable"], "destCcy": l["ccy"], "amount": l["convertedAmount"], "deadlineUtc": l.get("deadlineUtc"),
                 "beneficiary": l.get("beneficiary") or {"name": l["payable"], "country": "??"}, "reference": l.get("reference") or l["payable"]}
                for l in run.get("lines", []) if l.get("convertedAmount") and float(l["convertedAmount"]) > 0
                and l.get("crossBorder", l.get("ccy") != home)]
    if r.get("template") == "send_to" and r.get("intent") and r.get("beneficiary"):
        it = r["intent"]
        # "transfer 50000" with no currency fixes the home-currency debit (SOURCE_FIXED); a named supplier currency fixes what they receive
        return [{"payable": r.get("paymentRef") or f"send:{r['beneficiary'].get('name', 'beneficiary')}", "destCcy": it["destCcy"], "amount": it["amount"],
                 "amountType": it.get("amountType", "RECIPIENT_FIXED"), "deadlineUtc": it.get("deadlineUtc"), "beneficiary": r["beneficiary"],
                 "reference": r.get("paymentRef")}]
    return []


async def run_review(ctx, tenant, corr, home, bank, payments, policy="balanced"):
    if not payments:
        return [], [], []
    reply, status = await ctx.send_and_receive(
        ROUTING, ProcureRequest(tenantId=tenant, correlationId=corr, srcCcy=home, currentBank=bank, payments=payments, policy=policy),
        response_type=ProcureResult, timeout=200)
    if not isinstance(reply, ProcureResult):
        return [{"payable": p["payable"], "decision": "hold", "routeIds": [], "intentId": None, "paidCalls": [],
                 "reasons": [f"routing agent did not reply ({status}): not sending"]} for p in payments], [], []
    paid = [c for r in reply.results for c in r.get("paidCalls", [])]
    return reply.results, paid, reply.hops


def spent(paid):
    return str(sum((Decimal(str(c.get("priceUsdc", "0"))) for c in paid if not c.get("mock")), Decimal("0")))


async def concierge_ask(ctx, tenant, corr, text, policy=None, conversation_id=None, conversation_revision=None) -> AskResult:
    if not isinstance(text, str) or not text.strip() or len(text) > 500:
        return AskResult(correlationId=corr, status="error", error="Use a message between 1 and 500 characters")
    if conversation_id is not None and (not isinstance(conversation_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", conversation_id)):
        return AskResult(correlationId=corr, status="error", error="Invalid conversation ID")
    if conversation_revision is not None and (type(conversation_revision) is not int or conversation_revision < 0):
        return AskResult(correlationId=corr, status="error", error="Invalid conversation revision")
    if policy is not None and policy not in ("balanced", "cheapest", "fastest", "lowest_risk"):
        return AskResult(correlationId=corr, status="error", error="Invalid routing policy")
    policy = reasoning.policy_from_text(text, policy)
    try:
        r = await backend.assistant_ask(tenant, corr, text, conversation_id, conversation_revision)
        r = await context_llm.understand(backend, tenant, corr, r)
    except Exception as e:  # noqa: BLE001
        return AskResult(correlationId=corr, status="error", error=f"calculator (router) unavailable: {e}")
    if r.get("clarification"):
        return AskResult(correlationId=corr, status="clarification", template=r.get("template"), clarification=r["clarification"], preview=r,
                         conversationId=r.get("conversationId"), conversationRevision=r.get("conversationRevision"))
    if r.get("blocked"):
        return AskResult(correlationId=corr, status="blocked", template=r.get("template"), title=r.get("beneficiary"),
                         clarification="; ".join(r["blocked"]), preview=r,
                         conversationId=r.get("conversationId"), conversationRevision=r.get("conversationRevision"))
    company = r.get("company") or {}
    home = (r.get("preview") or {}).get("homeCcy") or company.get("homeCcy", "USD")
    bank = company.get("currentBank") or {}
    policy = r.get("policy") or policy
    decisions, paid, hops = await run_review(ctx, tenant, corr, home, bank, payments_from_preview(r), policy)
    if r.get("conversationId") and decisions:
        try:
            await backend.record_assistant_review(tenant, corr, r["conversationId"], r["conversationRevision"], decisions)
        except Exception as e:
            ctx.logger.warning(f"Could not store conversation review: {type(e).__name__}")
    hops = [{"from": "user", "to": "concierge", "message": "ask"}, {"from": "concierge", "to": "router", "message": "calculator preview"}] + hops
    return AskResult(correlationId=corr, status="ok", template=r.get("template"), title=r.get("title"), preview=r,
                     decisions=decisions, paidCalls=paid, spentUsdc=spent(paid), hops=hops, policy=policy,
                     next="execution needs approval in the app (npm run ask -- \"...\" --execute); only approved payments are sent",
                     conversationId=r.get("conversationId"), conversationRevision=r.get("conversationRevision"))


@gateway.on_rest_post("/ask", AskBody, AskResult)
async def ask(ctx: Context, req: AskBody) -> AskResult:
    err = check(req, "ask")
    if err:
        return AskResult(correlationId=req.correlationId, status="error", error=err)
    return await concierge_ask(ctx, req.tenantId, req.correlationId, req.text, req.policy, req.conversationId, req.conversationRevision)


@gateway.on_rest_post("/review", ReviewBody, AskResult)
async def review(ctx: Context, req: ReviewBody) -> AskResult:
    err = check(req, "review")
    if err:
        return AskResult(correlationId=req.correlationId, status="error", error=err)
    policy = reasoning.policy_from_text("", req.policy)
    decisions, paid, hops = await run_review(ctx, req.tenantId, req.correlationId, req.homeCcy, req.currentBank, req.payments[:25], policy)
    return AskResult(correlationId=req.correlationId, status="ok", template="payment_run", decisions=decisions, paidCalls=paid,
                     spentUsdc=spent(paid), policy=policy, hops=[{"from": "app", "to": "concierge", "message": "review"}] + hops)


@gateway.on_rest_get("/health", Health)
async def health(ctx: Context) -> Health:
    return Health(status="ok", mockApi=backend.MOCK, llmEnabled=llm.ENABLED or context_llm.ENABLED,
                  contextUnderstanding=context_llm.configuration(),
                  agents={"gateway": gateway.address, "routing": ROUTING, "liquidity": LIQUIDITY,
                          "executionCoordinator": EXECUTOR, "reconciliation": RECONCILIATION,
                          "investigation": INVESTIGATION, "compliance": COMPLIANCE})


@gateway.on_rest_get("/metrics", Metrics)
async def metrics(ctx: Context) -> Metrics:
    """Gateway counters merged with the workers' snapshot (workers write metrics.json every 10s)."""
    snap = USAGE.snapshot()
    try:
        with open(os.getenv("AGENT_METRICS_FILE", os.path.join(os.path.dirname(__file__), "metrics.json"))) as f:
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
    from asi_chat import AsiChatAdapter, is_end_session
    from chat_format import format_answer

    chat = Protocol(spec=chat_protocol_spec)
    CHAT_TENANT = os.getenv("CHAT_TENANT", "demo-tenant")

    chat_limiter = RateLimiter(int(os.getenv("CHAT_PAID_PER_MIN", "3")))   # each chat review spends test USDC

    chat_adapter = AsiChatAdapter(backend, concierge_ask, format_answer, CHAT_TENANT,
        app_url=(os.getenv("ASI_APP_URL", "http://localhost:8404").rstrip("/") + "/app/#/payments"),
        paid_limiter=chat_limiter)

    @chat.on_message(ChatMessage)
    async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
        await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc),
                                                   acknowledged_msg_id=msg.msg_id))
        text = "\n".join(c.text for c in msg.content if isinstance(c, TextContent)).strip()
        if not text and any(isinstance(c, EndSessionContent) for c in msg.content):
            text = "end session"
        if not text:
            return  # Session-control-only messages are acknowledged, never interpreted as payment instructions.
        answer = await chat_adapter.handle(ctx, sender, str(ctx.session), str(msg.msg_id), text)
        content = [TextContent(type="text", text=answer)]
        if is_end_session(text):
            content.append(EndSessionContent(type="end-session"))
        await ctx.send(sender, ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(),
                                           content=content))

    @chat.on_message(ChatAcknowledgement)
    async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
        pass

    gateway.include(chat, publish_manifest=True)


if __name__ == "__main__":
    gateway.run()
