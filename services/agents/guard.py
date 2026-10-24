"""Safety boundary for the agents (blueprint sec 7 'Tool and prompt boundaries').
- IDs are validated before they go into a URL path (agents cannot choose arbitrary URLs).
- Provider text, memos and documents are untrusted DATA, never instructions.
- Secrets and personal data are redacted from logs.
- Rate limits and job de-duplication stop agent retries from multiplying instructions.
- Usage metrics: tool calls, latency, LLM tokens."""
import re
import time
from collections import defaultdict, deque

_ID = re.compile(r"^[A-Za-z0-9_\-:.]{1,80}$")


def safe_id(value: str, field: str) -> str:
    if not isinstance(value, str) or not _ID.match(value):
        raise ValueError(f"invalid {field}")
    return value


# Phrases that indicate an embedded instruction inside provider/beneficiary text.
_INJECTION = re.compile(
    r"(ignore (all|previous|prior) instructions|you are now|system prompt|approve (this|the) (payment|transfer)"
    r"|mark (as )?(delivered|paid)|send (the )?(funds|money|payment)|refund|override|execute now)",
    re.IGNORECASE,
)


def untrusted(text, limit: int = 500) -> dict:
    """Wrap external text as data. Never pass the raw string to a tool as a command."""
    s = str(text or "")[:limit]
    return {"untrustedText": s, "suspectedInjection": bool(_INJECTION.search(s))}


_SECRET = re.compile(r"(sk-[A-Za-z0-9_\-]{8,}|0x[a-fA-F0-9]{64}|\b\d{12,19}\b|Bearer\s+\S+)")


def redact(text: str) -> str:
    return _SECRET.sub("[REDACTED]", str(text))


class RateLimiter:
    def __init__(self, per_minute: int = 60):
        self.per_minute = per_minute
        self.hits = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.time()
        q = self.hits[key]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= self.per_minute:
            return False
        q.append(now)
        return True


class JobDedupe:
    """Same jobId twice -> acknowledged once, dispatched once."""
    def __init__(self, max_items: int = 5000):
        self.seen, self.order, self.max = set(), deque(), max_items

    def first_time(self, job_id: str) -> bool:
        if job_id in self.seen:
            return False
        self.seen.add(job_id)
        self.order.append(job_id)
        if len(self.order) > self.max:
            self.seen.discard(self.order.popleft())
        return True


class Usage:
    def __init__(self):
        self.tool_calls = defaultdict(int)
        self.tool_ms = 0.0
        self.tool_n = 0
        self.llm_calls = 0
        self.llm_in = 0
        self.llm_out = 0
        self.rejected = defaultdict(int)

    def tool(self, name: str, ms: float):
        self.tool_calls[name] += 1
        self.tool_ms += ms
        self.tool_n += 1

    def llm(self, tin: int, tout: int):
        self.llm_calls += 1
        self.llm_in += tin
        self.llm_out += tout

    def snapshot(self) -> dict:
        return {"toolCalls": dict(self.tool_calls), "llmCalls": self.llm_calls,
                "llmInputTokens": self.llm_in, "llmOutputTokens": self.llm_out,
                "rejectedRequests": dict(self.rejected),
                "avgToolLatencyMs": round(self.tool_ms / self.tool_n, 1) if self.tool_n else 0.0}


USAGE = Usage()
