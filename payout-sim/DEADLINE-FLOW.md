# Deadline-aware payments and the local demo

The recipient's arrival deadline is a hard routing constraint. Price, speed and risk select among feasible routes. A quote is an estimate; only recipient-credit evidence completes a transfer.

## How the pieces connect

1. Chat posts to the router's `/ui/ask`, which calls the Fetch.ai concierge's `/ask`. The CLI uses that same concierge.
2. The concierge calls the router calculator over the linked company snapshot. The snapshot's balances and invoices are reused, but its old import date no longer freezes planning time. `planningNow()` uses current time, or an explicit `DEMO_NOW_UTC` for repeatable demos.
3. The calculator validates beneficiaries, checks optional discount deadlines and uses already-arrived, confirmed foreign receipts. Expected receipts and future deposits cannot fund an immediate transfer. An impossible discount deadline falls back to the original invoice deadline without claiming that discount saving.
4. The routing agent obtains provider quotes; the compliance agent checks the supplier. Every quote passes through the same optimizer. It returns estimated arrival, the last safe initiation time and exact exclusion reasons. A late bank fallback is no longer printed as a sendable plan.
5. Agents exclude late routes before applying cheapest, fastest or lowest-risk preferences. An available route over the cost threshold requires explicit cost review. It is distinct from a bank-detail review that requires a call-back. Neither is auto-executed by the CLI.
6. The preparer creates a payment request. Existing segregation of duties, per-user limits, call-back verification and dual approval still apply. Chat has an explicit option to permit switching among quoted routes to the same supplier within the approved debit cap.
7. The router hashes the recipient intent, route allocations, dispatch time and execution policy into the approved terms. Execution reserves source funds and persists `SCHEDULED`. Immediate dispatch is the default; API callers may specify an earlier-than-latest-safe `dispatchAtUtc`.
8. Before sending, the dispatcher refreshes pricing and checks the remaining deadline and rail availability. It can select only permitted routes and cannot exceed the debit cap. The fresh execution plan is stored separately from the original signed terms. Without consent, changed allocations require approval. Funding or payout uncertainty never permits automatic rerouting or a second send.
9. The monitor keeps reading reconciliation instead of stopping after a short polling window. Unknown or funded-but-unpaid payouts keep their reservation. Verified completion books the treasury debit. `MET` or `MISSED` uses the beneficiary-credit event's timestamp; missing timestamp evidence is `UNVERIFIED`.
10. After restart, scheduled work is recovered from the router store. In-flight work goes to reconciliation instead of being replayed. Receipts retain both approved terms and the actual execution plan.

## Local run

From the Calhacks root:

```powershell
.\start-local.ps1
```

Open `http://localhost:8404/app/#/chat`. The launcher starts only the payout service, router, workers and concierge. It creates an isolated workspace at `payout-sim/data/local-workspace` and copies the linked company snapshot once if one exists. It leaves `.env` files and the existing payment stores untouched. Logs are in that local workspace.

The local mode uses offline rates and a **synthetic four-hour, 24/7 bank payout route**, priced at an assumed $15 plus 80 bps. This fixture is enabled only by `LOCAL_ROUTING=1`. It is not a real provider quote. Stablecoin settlement is disabled in this mode, even for suppliers with a USDC wallet. Agent tools still call the router's optimizer and validator, but charge zero and return explicitly simulated evidence. No wallet, x402 seller, external LLM, or automatic Nessie writeback is used.

The local CLI uses the same isolated data and running services:

```powershell
.\start-local.ps1 -Service ask -Text "pay all suppliers this month"
# Explicitly approve and execute eligible converted payments in the simulation:
.\start-local.ps1 -Service ask -Text "pay all suppliers this month" -Execute
# Stop the services:
.\stop-demo.ps1
```

## Checks

```powershell
cd payout-sim
npm.cmd run deadline:test
npm.cmd run selftest
npm.cmd run econ:test
cd ..\services\agents
.\.venv\Scripts\python.exe -m unittest test_deadlines -v
```

The deadline suite uses temporary data and an ephemeral fake payout provider. It checks impossible deadlines, safe-start boundaries, cost caps, consent, persistent scheduling, delayed dispatch, duplicate execution, unknown payouts and recipient-credit evidence. It performs no external transactions.

## Current limits

The production catalog still needs actual provider integrations and executable conversion quotes to expand coverage; the scheduler cannot create a route that does not exist. Bank and invoice-sized supplier payouts are simulated. Wallet-only allocations remain previews in the company CLI; its execution path submits converted cross-border payments. Savings remain projections before agent approval and execution. Route timing models cover configured cutoffs and weekends, not provider-specific holidays or guaranteed service levels. Already-submitted payouts are monitored and reconciled; they are not automatically resent through another route.
