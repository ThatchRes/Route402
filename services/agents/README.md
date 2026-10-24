# services/agents (Person B): Fetch.ai uAgents

Six real uAgents with typed messages and an ID that ties every message for one payment together. The agents **read data and ask
Person A's permission gates.** They never sign, approve, write the ledger, change approved terms, refund, resend or
mark a payment delivered.

```
Person A API ─REST─▶ gateway :8100 ─typed msg─▶ Bureau :8101
                      (auth, tenant, rate limit,   routing ⇄ liquidity   (agent-to-agent funding check)
                       jobId de-dup, ID checks)    execution_coordinator → reconciliation (on UNKNOWN)
                                                   investigation
```

## Blueprint coverage
| Requirement (blueprint) | Where |
|---|---|
| Routing: fetch validated quotes, request solver, no invented quotes (sec 7, Prompt 4) | `on_route`; numbers only from A's `/internal/quotes/rank` |
| Both modes, split allocations, baseline, exclusions (Prompt 4) | `RouteResult.mode/allocations/baseline/excluded` |
| Liquidity: confirmed vs reserved vs forecast, pools, queue + treasury, advisory only (Prompt 5) | `on_funding_check`, `on_liquidity` |
| Execution coordinator: approved steps only, fixed idempotency key, UNKNOWN → reconcile first (Prompt 8) | `on_execute` |
| Reconciliation: per-leg match, distinct outcomes, funded-but-rejected stays outstanding (Prompt 10) | `reasoning.reconcile` |
| Investigation: evidence vs hypothesis, exception classification, permitted actions (sec 7) | `reasoning.investigate` |
| LLM intent extraction, reviewed, no authorization effect (sec 7) | `POST /parse` |
| LLM explanations cite IDs, invalid output → labeled fallback (Prompt 9) | `reasoning.explain_routes`, `llm.py` |
| Multi-agent trace for one instruction, correlation IDs kept (Prompt 9 acceptance) | `POST /coordinate` |
| Wrong tenant / unapproved plan / injected text cannot authorize (Prompt 9 acceptance) | `gateway.check`, `on_execute`, `guard.untrusted` |
| Fixed tools, no arbitrary URLs, rate limits, no retry multiplication (sec 7) | `backend.py`, `guard.py`, job de-dup |
| Model/tool usage + cost instrumentation, redacted logs (Prompt 9) | `GET /metrics`, `guard.redact` |
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

## Endpoints Person A must provide (OpenAPI v1)
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

Person B's B5 forecasting service replaces `backend.get_forecast` when it exists.

## Gateway routes
`GET /health`, `GET /metrics`, `POST /parse`, `/coordinate`, `/route-jobs`, `/liquidity-jobs` (`kind`: queue | treasury_rebalance),
`/execute-requests`, `/reconcile`, `/investigate`. Every body includes `tenantId`, `correlationId`, `serviceToken`.

## Notes
- Python 3.14 works because of the event-loop line at the top of `workers.py` and `gateway.py`.
- The "not enough funds" and "Almanac" warnings come from an optional mainnet listing. Don't send funds.
- LLM is off unless `ANTHROPIC_API_KEY` and `LLM_MODEL` are set. With it off, outputs say `deterministic_fallback`.
