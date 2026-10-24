# payout-sim: conversion, payout, ledger and reconciliation (guide prompt A5)

The step after funding: **convert the funded asset to the destination currency, pay the recipient, record a
balanced ledger, and prove it all matches.** The payout *provider* is simulated (labeled synthetic rates and fees)
and sits behind a provider adapter, so a real one (Bridge, a bank FX desk) can replace `provider.ts` later.
Everything around it is real logic: idempotent commands, signed webhooks, ordering, ledger and reconciliation.

```
x402 FUNDING_CONFIRMED ──▶ POST /payouts (Idempotency-Key) ──▶ ledger: source debit, fee, onramp/provider funding
     simulated provider ──signed webhooks──▶ ACCEPTED ─▶ CONVERSION_COMPLETED ─▶ BENEFICIARY_CREDITED | REJECTED
     ledger: provider FX (two linked legs), payout fee, beneficiary credit ──▶ reconciliation + receipt
```

## One command, whole transfer
```powershell
npm run transfer -- usd_cad_stablecoin          # x402 funding (real testnet) -> payout -> reconciliation table
npm run transfer -- usd_eur_bank                # bank route: x402 skipped
npm run transfer -- custom --from GBP --to INR --route bank --amount 1000.00 --rate 106.25 --funding-fee 1.00 --payout-fee 10.00
npm run transfer -- custom --from USD --to KRW --type RECIPIENT_FIXED --amount 1000000 --rate 1385.5 --funding-fee 2.00 --payout-fee 1000
npm run transfer -- custom --from EUR --to MXN --asset EURC --amount 20000.00 --rate 19.874 --funding-fee 8.00 --payout-fee 40.00 --outcome partial
npm run transfer                                 # list scenarios
```
**Any currency:** all 166 ISO 4217 currencies, with the correct decimals from the runtime's ISO data (plus ISO overrides),
and the tokens USDC, EURC, USDT and PYUSD. Custom pairs need explicit synthetic rates and fees; nothing is guessed.
Both modes work: `SOURCE_FIXED` (send exactly X) and `RECIPIENT_FIXED` (recipient gets exactly Y; sub-unit rounding
surplus is booked). `GET /currencies`, `POST /quotes/preview`.

**x402 is mandatory on stablecoin routes:** a payout is refused without an x402 order that is `FUNDING_CONFIRMED`,
whose x402 audit is `MATCHED`, and that payout-sim re-verifies on-chain itself. Bank routes skip x402.

**Reconciliation per transfer** (`npm run show`, `/v1/transfers/:id/reconciliation`) has these legs: bank_debit,
ledger_postings, chain_settlement (live chain read), x402_records (seller, buyer and chain agree), fx_conversion,
beneficiary_credit, plus the exact funded-but-unpaid outstanding.

## Rules it enforces
- No payout unless funding is confirmed (x402 order must be `FUNDING_CONFIRMED`); one testnet order backs one payout.
- Payout quote revalidated: expired after funding → `HOLD_QUOTE_EXPIRED`, funded liability kept, renewed approval needed.
- `Idempotency-Key` on create: same body returns the same payout, a different body gets 409; the provider dedupes by the same key.
- Timeout → `PAYOUT_UNKNOWN` → status lookup with the **same** key. A second order is never created.
- Webhooks: HMAC-SHA256 over the raw body plus a timestamp (5-minute window). Duplicates are ignored; out-of-order events are buffered and applied in provider sequence.
- Ledger is append-only and **balances per asset** (USD, USDC and CAD never mix). Conversions are linked legs that cite the rate.
- Rounding is exact integer minor units, rounded down, with the residual reported. JPY (0 decimals) and KWD (3 decimals) are covered.
- Delivered only on a beneficiary-credit event. Rejected or partial payouts stay **funded but unpaid**, with the exact remainder.
- The scenario amount (USD 50,210) is simulated. The 0.01 test USDC is linked as evidence in a separate `testnet` ledger.

## Scenarios (`npm run payout` with no args lists them)
| id | shows |
|---|---|
| usd_cad_stablecoin | happy path via USDC: 50,210.00 USD → 50,200 USDC → 68,523.00 CAD → 68,500.00 CAD to the recipient |
| usd_cad_delayed | recipient credit arrives late |
| usd_cad_rejected | payout rejected after funding: 68,500 CAD outstanding |
| usd_cad_mismatch | final credit 5.00 short: proceeds mismatch |
| usd_cad_partial | 60% credited, the rest rejected: exact remainder outstanding |
| usd_cad_late | rejected, then late success |
| usd_cad_timeout | create call "times out": UNKNOWN until `refresh` |
| usd_cad_chaos | duplicate and out-of-order webhooks |
| usd_eur_bank | bank route, no stablecoin |
| usd_jpy_stablecoin / usd_kwd_stablecoin | 0- and 3-decimal payout currencies |
| cad_usd_reverse | reverse direction with its own rates |
| usd_usd_crossborder | cross-border, no FX |

## Run (PowerShell, Node 22+)
```powershell
cd C:\Users\tlres\OneDrive\Desktop\Apps\Calhacks\payout-sim
npm install
Copy-Item .env.example .env      # set PAYOUT_INTERNAL_TOKEN, PROVIDER_WEBHOOK_SECRET, and X402_INTERNAL_TOKEN = the x402-spike value
npm run selftest                 # 14 offline checks
npm run server                   # window 1 (keep the x402 seller running too if you use x402 funding)
```
Window 2:
```powershell
npm run payout -- usd_cad_stablecoin fund_tr_demo_1_v1   # backed by your real x402 testnet order
npm run payout -- usd_cad_partial                        # simulated bank funding
npm run show -- <transferId printed above>               # events + reconciliation
npm run payout -- usd_cad_timeout
npm run refresh -- <payoutId>                            # status lookup recovers it
```

## Endpoints (Person A's backend calls these; the agents read the two evidence ones)
| Endpoint | Purpose |
|---|---|
| `POST /payouts` + `Idempotency-Key` `{transferId, scenario, quoteExpiresAt, funding:{mode:"x402_testnet",orderId} \| {mode:"simulated_bank"}}` | create payout |
| `POST /payouts/:id/refresh` | status lookup by the same key |
| `POST /payouts/:id/requote {approvalId}` | continue after a renewed approval |
| `POST /webhooks/provider` | signed provider events |
| `GET /v1/transfers/:id/events` → `{items}` | timeline (the investigation agent reads this) |
| `GET /v1/transfers/:id/reconciliation` → `{legs, outstanding}` | per-leg matching (the reconciliation agent reads this) |
| `GET /v1/transfers/:id/receipt` | downloadable JSON receipt with ledger, history and disclosure |
| `GET /scenarios` | scenario list with exact quotes (for the dashboard) |

Agents: set `EVIDENCE_API_BASE_URL=http://localhost:8403` and `EVIDENCE_API_TOKEN=<PAYOUT_INTERNAL_TOKEN>` in
`services/agents/.env`. The reconciliation and investigation agents then use this real evidence, even while `MOCK_API=1`.
