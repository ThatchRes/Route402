# services/agents: Fetch.ai uAgents

Six real uAgents with typed messages and an ID that ties every message for one payment together. The agents **read data and ask
the router's permission gates.** They never sign, approve, write the ledger, change approved terms, refund, resend or
mark a payment delivered.

```
Router API ─REST─▶ gateway :8100 ─typed msg─▶ Bureau :8101
                      (auth, tenant, rate limit,   routing ⇄ liquidity   (agent-to-agent funding check)
                       jobId de-dup, ID checks)    execution_coordinator → reconciliation (on UNKNOWN)
                                                   investigation
```

## What each part does
| Behavior | Where |
|---|---|
| Routing: fetch validated quotes, request solver, no invented quotes | `on_route`; numbers only from the router's `/internal/quotes/rank` |
| Both modes, split allocations, baseline, exclusions | `RouteResult.mode/allocations/baseline/excluded` |
| Liquidity: confirmed vs reserved vs forecast, pools, queue + treasury, advisory only | `on_funding_check`, `on_liquidity` |
| Execution coordinator: approved steps only, fixed idempotency key, UNKNOWN → reconcile first | `on_execute` |
| Reconciliation: per-leg match, distinct outcomes, funded-but-rejected stays outstanding | `reasoning.reconcile` |
| Investigation: evidence vs hypothesis, exception classification, permitted actions | `reasoning.investigate` |
| LLM intent extraction, reviewed, no authorization effect | `POST /parse` |
| LLM explanations cite IDs, invalid output → labeled fallback | `reasoning.explain_routes`, `llm.py` |
| Multi-agent trace for one instruction, correlation IDs kept | `POST /coordinate` |
| Wrong tenant / unapproved plan / injected text cannot authorize | `gateway.check`, `on_execute`, `guard.untrusted` |
| Fixed tools, no arbitrary URLs, rate limits, no retry multiplication | `backend.py`, `guard.py`, job de-dup |
| Model/tool usage + cost instrumentation, redacted logs | `GET /metrics`, `guard.redact` |
| Agentverse / chat protocol if the sponsor requires it | `ENABLE_CHAT=1` |

## Setup (Windows PowerShell)
```powershell
python -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env      # fill the seeds + AGENT_SERVICE_TOKEN with random strings
```
Load `.env` in each window, then run `python workers.py` in one window and `python gateway.py` in another:
```powershell
Get-Content .env | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object { $k,$v = $_ -split '=',2; Set-Item "env:$($k.Trim())" $v.Trim() }
```

## Router endpoints the agents call (OpenAPI v1)
All calls send `Authorization: Bearer $AGENT_SERVICE_TOKEN`, `X-Tenant-Id` and `X-Correlation-Id`.
| Call | Used by |
|---|---|
| `POST /internal/quotes/collect {intentId}` → `[Quote]` | routing |
| `POST /internal/quotes/rank {intentId, quoteIds}` → `{mode, decisionRecordId, ranked, allocations, excluded, baseline}` | routing |
| `POST /internal/jobs/{jobId}/result` | routing |
| `POST /internal/funding/check {intentId, quoteIds}` → `{feasible, snapshotId, confirmedAvailable, reserved, forecast, blockedPools, notes}` | liquidity |
| `GET /internal/inventory?queueId=` → `{snapshotId, confirmed, reserved, pendingIncoming, forecast}` | liquidity |
| `POST /internal/queue/proposals {queueId, kind}` → `{status, proposalId, advisoryOnly, baseline, metrics, blockedPools, assumptions}` | liquidity |
| `POST /v1/transfers/{id}/execute {planVersion, termsHash, stepId}` + `Idempotency-Key` | execution coordinator |
| `GET /v1/transfers/{id}/steps/{stepId}` → `{stepStatus}` | execution coordinator |
| `GET /v1/transfers/{id}/reconciliation` → `{legs:[{leg, expected, observed, status?, evidenceRef, confirmations?, requiredConfirmations?}]}` | reconciliation |
| `GET /v1/transfers/{id}/events` → `{items:[Event]}` | investigation |
| `POST /internal/events` (agent observation, non-authoritative) | all agents |

A forecasting service can replace `backend.get_forecast` later.

## ASI:One chat and confirmation

The gateway implements the [Agent Chat Protocol](https://docs.asi1.ai/documentation/tutorials/agent-chat-protocol) with `ChatMessage`, `TextContent` and `ChatAcknowledgement`. Normal replies keep the session open; only an explicit end closes it. The existing company frontend and its REST response shapes are unchanged. An additional `/asi/link` page handles one-time account authorization.

Run the router, workers and gateway with `ENABLE_CHAT=1`, a stable gateway seed and an Agentverse mailbox connection. `register_agentverse.py` prints the gateway's ASI:One mention. The gateway must remain running and able to reach the router. Set `ASI_APP_URL` to the same reachable app origin in both services if it differs from `http://localhost:8404`; this does not change existing hosting or proxy configuration. `CHAT_TENANT` must match the router's `AGENT_TENANT` (default `demo-tenant`). The service token authenticates the gateway, never the human user.

1. Ask the agent to plan a payment. There is no sign-in link: on its first message each signed ASI:One sender + session is bound to the router's `ASI_CHAT_USER` (default `alex`, the demo owner) and audited as `asi_linked`. Set `ASI_CHAT_AUTOLINK=0` on the router to require the older browser-link flow instead.
2. Review the exact quoted amounts, fees, route, arrival and expiry in the chat.
3. Say `yes` (exact phrases such as `go ahead` or `confirm` also work; a quoted, conditional or edited yes does not). The router submits the reviewed payment through the website's existing preparation handler, then tries its existing approval handler as that user. A preparer-only account stops at awaiting approval; required supplier call-backs and release evidence still block release. Alex's owner authority can prepare and approve in one chat acceptance, with the normal owner-override audit record.
4. Ask `status` for this chat's requests; status is answered in the chat, without app links. `cancel` closes an unaccepted proposal; it does not cancel a submitted payment. `end chat`, `disconnect` or expiry revokes chat access.

Replies also carry [ASI:One Interactive Cards](https://innovationlab.fetch.ai/resources/docs/interactive-cards/asi-interactive-cards) (`asi_cards.py`, ASI:One only): a payment review with Send payment / Cheapest / Fastest / Balanced / Cancel, a pickable supplier list, payment status, and quick actions. The full text is always sent first and is what ASI:One shows if a card is rejected. A click returns as a JSON selection (or planner prose naming its ids) and becomes the same fixed command a user could type; unknown selections are ignored, and Send payment only confirms the proposal this chat displayed. Preview card JSON in the [Card Playground](https://asi1.ai/developer/card-playground) by pasting a `card_payload` from `python -c "import asi_cards; print(asi_cards.actions_card()['card_payload'])"`.

Greetings and off-topic messages that the planner does not recognize get a short reply from the ASI:One LLM (`context_llm.converse`, ASI:One only). It sees only the current message as JSON data, has no tools or company data, and its reply is discarded if it contains links, amounts, percentages, markup or any claim about a payment action. Security refusals, clarifications and payment plans are never replaced by it.

Only one current displayed proposal can be accepted per conversation. A changed draft, quote, policy, company or conversation version invalidates it. An increased debit requires fresh approval. Confirmation state and request IDs survive router restarts; duplicate message IDs are stored by the gateway and never re-dispatched. If the outcome is unknown, inspect existing requests instead of automatically retrying. Do not delete chat state to try to force a retry.

This is the existing demo execution flow: x402 quote/screening purchases can spend test USDC; supplier payments and FX conversion remain simulated and supported chain settlement is a representative proof. No real invoice payment was added. Account identity remains the app's demo sign-in, not production SSO.

Offline checks: from this folder run `python -m unittest test_chat_format test_asi_chat test_chat_protocol test_context test_deadlines`. From `payout-sim`, run `npm run asi:test` for isolated authorization-state and local HTTP integration checks. No external payments are made by these tests.

## Gateway routes
`GET /health`, `GET /metrics`, `POST /parse`, `/coordinate`, `/route-jobs`, `/liquidity-jobs` (`kind`: queue | treasury_rebalance),
`/execute-requests`, `/reconcile`, `/investigate`. Every body includes `tenantId`, `correlationId`, `serviceToken`.

## Notes
- Python 3.14 works because of the event-loop line at the top of `workers.py` and `gateway.py`.
- The "not enough funds" and "Almanac" warnings come from an optional mainnet listing. Don't send funds.
- The older `/parse` and explanation helpers use `ANTHROPIC_API_KEY` + `LLM_MODEL`. The separate conversation fallback below uses ASI:One; enabling it does not enable those helpers.

## ASI:One conversation understanding

Fetch provides a [general LLM API](https://docs.asi1.ai/documentation/build-with-asi-one/chat-completions), separate from Agentverse and the Agent Chat Protocol. Route402 uses its [structured output](https://docs.asi1.ai/documentation/build-with-asi-one/structured-data) to interpret unfamiliar follow-up wording. The same gateway handles both the existing website and ASI:One chat. No frontend files, pricing models, routing algorithms, quote providers or approval/execution rules change.

Add these settings to `services/agents/.env`, then restart the gateway using the existing launcher:

```dotenv
ASI_ONE_API_KEY=your-asi-one-api-key
ASI_CONTEXT_MODEL=asi1-mini
CONTEXT_LLM_ENABLED=1
```

Create the key in the [ASI:One dashboard](https://asi1.ai/dashboard/api-keys). An Agentverse key is not an ASI:One LLM key. Keep it server-side. `ASI1_API_KEY` is also accepted for existing deployments. `GET :8100/health` reports `contextUnderstanding.enabled` and the configured model without exposing the key. No key, `CONTEXT_LLM_ENABLED=0`, or local-only mode leaves the original deterministic parser active. ASI model inference uses the provider's API billing, not the x402 quote-payment wallet.

The deterministic parser runs first. Only unrecognized turns use the LLM, so recognized requests add no model latency. Examples include “Keep as much cash as possible, waiting is fine,” “Any update on that?” and “Bump the budget to 6000” after a payment draft. Existing conversation records retain the supplier, amount, currency, deadline and routing preference. Ambiguous phrasing asks for clarification; the model does not estimate missing prices or rewrite payment amounts.

The language boundary is deliberately narrow:

- The router offers a menu of supported interpretations built from the latest user message and current conversation. The model returns one ID or `clarify`. It cannot return arbitrary text, a URL, tool name, amount, account, supplier ID, route, user role or approval.
- The model sees at most six recent filtered turns, minimal task state and the menu. It does not see receiving credentials, bank records, quotes, raw provider/document payloads, service keys, approval tokens or the conversation binding. Known credential/address patterns are redacted; sensitive current messages and suspicious control instructions skip the model entirely. Redaction is defense in depth, not a guarantee that every form of sensitive free text will be detected.
- The latest message and history are untrusted data beneath fixed system instructions. Strict JSON output is validated again locally. Tool calls, planner mode and web search are unavailable. The server reconstructs the selected action and runs its existing validation; it never executes generated prose.
- Company, tenant, conversation revision and a server context digest bind each interpretation. A new turn, company switch or replay rejects a stale interpretation. The saved transcript preserves the original user message and the server-built normalized request.
- `yes` is never routed through the LLM. ASI chat acceptance still requires the previously displayed, unexpired proposal and the linked user's existing authority; model output cannot manufacture consent.
- Calls use a fixed HTTPS endpoint, no redirects, a seven-second total timeout, bounded input/output, at most four concurrent requests and twenty calls per minute per gateway. A provider error opens a short cooldown and falls back to the original response. No prompt, credential or raw provider error is logged.

Prompt instructions and pattern checks cannot make an LLM immune to injection. The security boundary is the fixed menu, server validation and unchanged approval/execution controls. This is conversational intent classification, not unrestricted generated financial advice or autonomous payment execution.

Offline validation (no model calls or payments): `python -m unittest test_context_llm test_context test_deadlines test_asi_chat test_chat_format test_chat_protocol`; in `payout-sim`, `npm run understanding:test`, `npm run context:test`, `npm run security:test`, and `npm run asi:test`.
