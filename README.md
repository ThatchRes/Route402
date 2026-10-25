# Route402

Route402 helps companies pay overseas suppliers faster and cheaper without losing control. A finance team member describes a payment in plain language ("pay Maple Freight 50,000 CAD by Friday"). AI agents then compare every way to send it, from the company's own bank wire to regulated stablecoin routes. Each option shows the total cost, what the supplier receives and when it arrives. A person approves the payment, and Route402 tracks it to settlement, checks the actual cost against the quote, and prepares the accounting entry.

Built at Cal Hacks with Fetch.ai uAgents, ASI:One, x402 on Base Sepolia, and Capital One's Nessie API.

## What's real and what's simulated

| Real | Simulated or testnet |
|---|---|
| Exchange rates: European Central Bank reference rates (Frankfurter) | Supplier payouts and currency conversion (a simulated payout provider with its own ledger) |
| Bank baseline: measured bank FX markups (Wise comparison data) | x402 payments and on-chain settlement proofs use test USDC on Base Sepolia |
| Stablecoin conversion prices: live Coinbase, Kraken and Bitso order books | Escrow smart contract runs on a local or test chain |
| Company accounts, bills and deposits from the Capital One Nessie sandbox, or a CSV export | Sign-in is a demo one-time code, not SSO |
| Approval controls, compliance checks, audit log, accounting records | |

If the live feeds can't be reached, or `LIVE_MARKET=0` is set, prices come from a built-in demo table, and the app labels them as synthetic.

## Features

- **Agent chat:** plan payments in plain language in the web app or in ASI:One, with interactive cards.
- **Route comparison:** bank wire, fintech payout partners and stablecoin rails, priced all-in and split across up to three routes when that's cheaper.
- **Controls:** separate preparer and approver roles, approval limits, and a phone call-back when a supplier's bank details change.
- **Compliance checks:** sanctioned countries, supplier name and wallet screening, GENIUS Act issuer rules (from January 18, 2027), MiCA for EU suppliers, Travel Rule records, KYB gating, and monitoring alerts.
- **Release on delivery:** an escrow that holds funds until delivery is confirmed or shipping documents check out.
- **Tracking:** every transfer is followed to supplier credit and reconciliation.
- **Accounting:** a proposed journal entry for each settled payment, a quote vs. actual cost breakdown, flags for unusual variances, and a CSV export.
- **Audit:** a hash-chained activity log and an ISO 20022 (pain.001) export.

## How it fits together

```
Browser (/app) ──▶ router :8404 ──▶ payout service :8403   (simulated payouts, ledger, reconciliation)
                     │   ▲
                     ▼   │
            concierge agent :8100 ◀──▶ worker agents :8101   (routing, liquidity, compliance,
                     │                                        execution, reconciliation, investigation)
                     ▼
     agent wallet :8405 ──x402──▶ quote and screening providers :8411/:8413, seller :8402 (Base Sepolia)
```

| Folder | What it is |
|---|---|
| `payout-sim/` | TypeScript/Express backend. The router (`src/router`) prices routes, enforces controls and compliance, and serves the web app (`public/`). The payout service (`src/server.ts`) simulates the payout provider and keeps a double-entry ledger. |
| `services/agents/` | Python Fetch.ai uAgents: the concierge (gateway) and the worker agents, plus ASI:One chat and interactive cards. |
| `x402-spike/` | x402 seller, agent wallet with spending caps, quote providers, and the escrow contract (`contracts/Route402Escrow.sol`). |

More detail: [payout-sim/README.md](payout-sim/README.md), [services/agents/README.md](services/agents/README.md), [x402-spike/README.md](x402-spike/README.md), [chat security](payout-sim/CHAT-SECURITY.md), [deadline flow](payout-sim/DEADLINE-FLOW.md) and [contextual chat](payout-sim/CONTEXTUAL-CHAT.md).

## Running it

Requirements: Node 22+ and Python 3 (tested with 3.14).

```bash
cd payout-sim && npm install && cp .env.example .env && cd ..
cd x402-spike && npm install && cp .env.example .env && cd ..
cd services/agents && python -m venv .venv && .venv/bin/pip install -r requirements.txt && cp .env.example .env && cd ../..
```

Fill in the `.env` files. The comments in each one explain the values. At minimum:
- Set random agent seeds in `services/agents/.env`.
- Use the same shared token for `ROUTER_TOKEN` (payout-sim) and `AGENT_SERVICE_TOKEN` (agents).
- Use the same `X402_INTERNAL_TOKEN` in all three.
- Add a `NESSIE_API_KEY` to link Capital One sandbox data.
- Add Coinbase Developer Platform keys in `x402-spike/.env` for testnet x402 payments.

**Windows:** `.\start-demo.ps1` starts every service in its own window, `.\check-demo.ps1` shows which ports are up, and `.\stop-demo.ps1` stops them. `.\start-local.ps1` runs an isolated local simulation with no x402 spending or testnet settlement.

**macOS / Linux:** start each service in its own terminal:

```bash
cd payout-sim && npm run server          # payout service :8403
cd payout-sim && npm run router          # router + web app :8404
cd x402-spike && npm run seller          # x402 seller :8402
cd x402-spike && npm run providers       # quote and screening providers
cd x402-spike && npm run wallet          # agent wallet :8405
cd services/agents && set -a && . ./.env && set +a && .venv/bin/python workers.py
cd services/agents && set -a && . ./.env && set +a && .venv/bin/python gateway.py
```

For a local run without x402 or testnet payments, set `LOCAL_ROUTING=1` for the router and the agents, and skip the `x402-spike` services.

Open http://localhost:8404/app/ and sign in as a demo user. Maya prepares payments; Jordan and Priya approve them. After pulling new code, restart the router: the browser loads new page files on refresh, but the server keeps its old routes until it restarts.

## Tests

```bash
cd payout-sim
npx tsc --noEmit
npm run selftest && npm run security:test && npm run compliance:test && npm run accounting:test
npm run econ:test && npm run deadline:test && npm run context:test && npm run understanding:test
npm run issuer:test && npm run exposure:test && npm run optimization:test && npm run asi:test

cd ../services/agents
for f in test_*.py; do .venv/bin/python -m unittest "$f"; done

cd ../../x402-spike && npm run selftest
```

## Limitations

This is a hackathon prototype, not a licensed payment service. Before handling real money, it would need:
- licensed partners for funding, stablecoin conversion and payouts;
- real KYB and a sanctions screening provider;
- SSO with multi-factor authentication;
- regulated key custody;
- an encrypted multi-tenant database in place of the JSON files under `data/`.
