"""Optional LLM helper (LLM use with evidence).
The LLM may: draft an intent from operator text, rephrase solver explanations, summarise investigations.
It may NOT: produce rates, amounts it wasn't given, account IDs it wasn't given, or authorise anything.
Every output is validated; on any failure the caller uses a labeled deterministic fallback."""
import json
import os
import httpx
from guard import USAGE, redact

KEY = os.getenv("ANTHROPIC_API_KEY", "")
MODEL = os.getenv("LLM_MODEL", "")          # set to a current model id from docs.claude.com
ENABLED = bool(KEY and MODEL)


async def complete_json(system: str, user: str, max_tokens: int = 600):
    """Returns a dict or None. One bounded repair attempt for malformed JSON."""
    if not ENABLED:
        return None
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.post("https://api.anthropic.com/v1/messages",
                                 headers={"x-api-key": KEY, "anthropic-version": "2023-06-01",
                                          "content-type": "application/json"},
                                 json={"model": MODEL, "max_tokens": max_tokens, "system": system,
                                       "messages": [{"role": "user", "content": user}]})
            r.raise_for_status()
            data = r.json()
            u = data.get("usage", {})
            USAGE.llm(u.get("input_tokens", 0), u.get("output_tokens", 0))
            text = "".join(b.get("text", "") for b in data.get("content", []))
            start, end = text.find("{"), text.rfind("}")
            return json.loads(text[start:end + 1])
        except Exception as e:  # noqa: BLE001
            print(redact(f"[llm] attempt {attempt + 1} failed: {e}"))
            user = user + "\n\nReturn ONLY one valid JSON object."
    return None
