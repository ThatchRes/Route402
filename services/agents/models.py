"""Typed uAgent messages (blueprint section 7, Prompt 9).
Every message carries tenantId + correlationId so one instruction can be traced across agents."""
from typing import List, Optional
from uagents import Model


# ---------- Intent parsing (sec 7 "LLM use with evidence", guide B1) ----------
class ParseBody(Model):
    tenantId: str
    message: str                     # untrusted operator text
    accounts: List[dict]             # [{id, alias, country, currency}] supplied by A (only these may be used)
    nowUtc: str
    timezone: str
    correlationId: str
    serviceToken: str


class ParseResult(Model):
    status: str                      # "proposed" | "clarification_required" | "error"
    intent: Optional[dict]           # {sourceId, destinationId, amount, amountCurrency, amountType, deadlineUtc, objective}
    clarification: Optional[str]
    source: str                      # "llm" | "deterministic_fallback"
    authorizationEffect: str = "none"  # parser output never authorizes anything
    correlationId: str


# ---------- Routing (Prompt 4 single payment + splits, both economic modes) ----------
class RouteRequest(Model):
    jobId: str
    tenantId: str
    intentId: str
    correlationId: str
    checkFunding: bool = True        # routing asks LiquidityAgent before answering


class RouteResult(Model):
    jobId: str
    tenantId: str
    correlationId: str
    status: str                      # "ok" | "no_route" | "hold" | "error"
    mode: Optional[str]              # SOURCE_FIXED | RECIPIENT_FIXED (from A, never guessed)
    rankedQuoteIds: List[str]
    allocations: List[dict]          # split children [{quoteId, sourceAmount, destAmount}] from A's solver
    excluded: List[dict]             # [{quoteId, reason}]
    baseline: Optional[dict]         # best unsplit route / existing policy, from A
    funding: Optional[dict]          # LiquidityAgent's funding check for the winning plan
    explanation: str
    explanationSource: str           # "llm" | "deterministic_fallback"
    evidenceRefs: List[str]          # quote IDs, decision record ID, snapshot ID cited


# ---------- Liquidity (Prompt 5 queue + single-payment funding + treasury) ----------
class FundingCheckRequest(Model):
    tenantId: str
    intentId: str
    quoteIds: List[str]
    correlationId: str


class FundingCheckResult(Model):
    tenantId: str
    correlationId: str
    feasible: bool
    confirmedAvailable: dict
    reserved: dict
    forecastAdvisory: dict           # shown, never counted as spendable
    blockedPools: List[str]          # pools the plan may NOT draw from
    snapshotId: Optional[str]
    notes: List[str]


class LiquidityRequest(Model):
    jobId: str
    tenantId: str
    queueId: str
    correlationId: str
    kind: str = "queue"              # "queue" | "treasury_rebalance"


class LiquidityResult(Model):
    jobId: str
    tenantId: str
    correlationId: str
    status: str                      # "ok" | "hold" | "error"
    proposalId: Optional[str]
    confirmed: dict
    reserved: dict
    pendingIncoming: dict
    forecast: dict                   # advisory only
    metrics: dict                    # peak prefunding, balance-days, on-time vs baseline (from A)
    blockedPools: List[str]
    advisoryOnly: bool
    summary: str
    evidenceRefs: List[str]


# ---------- Execution coordinator (Prompt 8) ----------
class ExecuteStepRequest(Model):
    jobId: str
    tenantId: str
    transferId: str
    planVersion: int
    termsHash: str
    stepId: str
    idempotencyKey: str              # fixed per step: retries reuse it, never multiply payments
    correlationId: str


class ExecuteStepResult(Model):
    jobId: str
    tenantId: str
    correlationId: str
    accepted: bool
    backendStatus: str               # A's answer: ENQUEUED | REJECTED | ALREADY_EXISTS | ...
    stepStatus: Optional[str]        # tracked: NOT_STARTED|REQUESTED|PENDING|CONFIRMED|REJECTED|UNKNOWN
    nextAction: str                  # "wait" | "reconcile_first" | "none" | "operator_review"
    detail: str


# ---------- Reconciliation (Prompt 10) ----------
class ReconcileRequest(Model):
    jobId: str
    tenantId: str
    transferId: str
    correlationId: str


class ReconcileResult(Model):
    jobId: str
    tenantId: str
    correlationId: str
    outcome: str                     # MATCHED | MISSING_DEBIT_POSTING | PROCEEDS_MISMATCH | PAYOUT_REJECTED
                                     # | CHAIN_CONFIRMATION_PENDING | LATE_SUCCESS | PAYOUT_PENDING
    legs: List[dict]                 # per-leg {leg, expected, observed, status, evidenceRef}
    outstandingObligation: Optional[str]
    allowedNextActions: List[str]    # suggestions only; refunds/resends need operator approval in A
    summary: str
    evidenceRefs: List[str]


# ---------- Investigation (sec 7 investigation assistant) ----------
class InvestigateRequest(Model):
    jobId: str
    tenantId: str
    transferId: str
    correlationId: str


class InvestigateResult(Model):
    jobId: str
    tenantId: str
    correlationId: str
    exceptionType: str               # classified supported exception, or "UNCLASSIFIED"
    observedFacts: List[str]         # each cites an evidence ref
    missingEvidence: List[str]
    hypotheses: List[str]            # always labeled, never presented as fact
    suggestedActions: List[str]      # permitted next actions only
    summarySource: str               # "llm" | "deterministic_fallback"
    evidenceRefs: List[str]


# ---------- REST bodies (what Person A's API sends to the gateway) ----------
class RouteJobBody(Model):
    jobId: str
    tenantId: str
    intentId: str
    correlationId: str
    serviceToken: str


class InvestigateBody(Model):
    jobId: str
    tenantId: str
    transferId: str
    correlationId: str
    serviceToken: str


class LiquidityBody(Model):
    jobId: str
    tenantId: str
    queueId: str
    correlationId: str
    serviceToken: str
    kind: str = "queue"


class ExecuteBody(Model):
    jobId: str
    tenantId: str
    transferId: str
    planVersion: int
    termsHash: str
    stepId: str
    idempotencyKey: str
    correlationId: str
    serviceToken: str


class ReconcileBody(Model):
    jobId: str
    tenantId: str
    transferId: str
    correlationId: str
    serviceToken: str


class Accepted(Model):
    accepted: bool
    jobId: str
    duplicate: bool = False
    error: Optional[str] = None


class TraceResult(Model):
    """Synchronous multi-agent result for one instruction (Prompt 9 acceptance trace)."""
    correlationId: str
    hops: List[dict]                 # [{from, to, message, status, ms}]
    route: Optional[dict]
    error: Optional[str] = None


class Health(Model):
    status: str
    agents: dict
    mockApi: bool
    llmEnabled: bool
    contextUnderstanding: dict = {}


class Metrics(Model):
    toolCalls: dict
    llmCalls: int
    llmInputTokens: int
    llmOutputTokens: int
    rejectedRequests: dict
    avgToolLatencyMs: float


# ---------- Paid procurement: the routing agent buys quotes, the compliance agent buys screens (x402 per call) ----------
# Batched: one message per payment run, because replies are matched per (sender, receiver, session).
class ProcureRequest(Model):
    tenantId: str
    correlationId: str
    srcCcy: str
    currentBank: dict                # the company's baseline bank terms
    payments: List[dict]             # [{payable, destCcy, amount, deadlineUtc, beneficiary}]
    policy: str = "balanced"         # balanced | cheapest | fastest | lowest_risk


class ProcureResult(Model):
    correlationId: str
    results: List[dict]              # per payment: {payable, decision, intentId, routeIds, reasons, quote, screen, paidCalls}
    hops: List[dict]


class ScreenRequest(Model):
    tenantId: str
    correlationId: str
    items: List[dict]                # [{payable, beneficiary}]


class ScreenResult(Model):
    correlationId: str
    results: List[dict]              # [{payable, status PASS|REVIEW|BLOCK|UNAVAILABLE, errors, warnings, notCovered, payment}]


# ---------- Concierge (front door): everyday prompts and payment-run reviews ----------
class AskBody(Model):
    tenantId: str
    correlationId: str
    serviceToken: str
    text: str
    policy: Optional[str] = None     # overrides the policy read from the text
    conversationId: Optional[str] = None
    conversationRevision: Optional[int] = None


class ReviewBody(Model):
    tenantId: str
    correlationId: str
    serviceToken: str
    homeCcy: str
    currentBank: dict
    payments: List[dict]             # [{payable, ccy, amount, deadlineUtc, beneficiary}]
    policy: Optional[str] = None


class AskResult(Model):
    correlationId: str
    status: str                      # ok | clarification | blocked | error
    template: Optional[str] = None
    title: Optional[str] = None
    clarification: Optional[str] = None
    preview: Optional[dict] = None   # the calculator's plan (router), for display
    decisions: List[dict] = []       # one ProcureResult per payment that needs conversion
    paidCalls: List[dict] = []
    spentUsdc: str = "0"
    policy: Optional[str] = None
    hops: List[dict] = []
    next: Optional[str] = None
    error: Optional[str] = None
    conversationId: Optional[str] = None
    conversationRevision: Optional[int] = None
