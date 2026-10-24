# Company international payments: savings engine

**Who it's for:** companies that pay and get paid internationally. **What it does:** every payment run goes through the four
levers that actually save money, each measured against **the company's own bank** (FX markup, wire fee and speed taken from their statements):

1. **Validate beneficiaries.** Payments that would bounce (bad IBAN or routing number) are blocked before sending.
2. **Timing.** Take early-payment discounts only when they beat the company's cost of cash.
3. **Wallets / natural hedge.** Pay foreign invoices from foreign money already received; convert only the rest.
4. **Routing.** Everything that still converts goes through the cheapest and fastest stable route (bank, or stablecoin with x402 on USDC/Base).

```powershell
npm run company -- run              # full payment run for the demo company: per-payment plan + savings by lever
npm run company -- run --execute    # also executes each converted payment (needs: npm run server, npm run router, x402 seller)
```
Demo company: Acme Imports, whose bank charges a 1.2% markup plus 35 USD per wire. One run saves 41,439 USD
(routing 29,349 · wallets 4,297 · discounts 7,067 · failed payments avoided 726). The company keeps 33,151 after our 20% fee.
Endpoint: `POST /v1/company/payment-run` (empty body = demo). Edit `src/company/profile.ts` with a real company's bank terms.

### Link once, then just ask (`npm run ask`)
1. **Link** the company's data once: `npm run import -- nessie link` (bank) or `npm run import -- csv link <file>` (accounting export).
   It's saved to `data/linked.json`, so every request reuses it with no re-fetching.
2. **Ask in plain words.** Each request matches a ready-made template and is filled from the linked data, with no LLM needed:
   | Say | You get |
   |---|---|
   | `pay my German suppliers this week` | payment run for just those bills (country, currency and date window filled in) |
   | `send 50k CAD to Maple Freight by Friday` | validated recipient, best route, what you pay vs your bank, arrival |
   | `convert 200k dollars to pesos` | best conversion vs your bank |
   | `how much can I save this month` | savings by lever |
   | `check my suppliers' bank details` | OK / REVIEW / BLOCK per supplier |
   | `what do we owe in euros` | owed vs incoming vs expected per currency |
   Unknown recipients, ambiguous names, or missing amounts get one clarifying question. Every answer is a **preview**:
   `--execute` (or an Approve button) creates the plan, approves it and executes it.
   API: `POST /v1/assistant/ask {text}`.
3. **Before a pitch:** `npm run demo:reset` clears transfers, payouts and linked data (x402 testnet evidence is never touched).

### How a company ports its data in (`npm run import`)
- **Bank connection (Capital One Nessie sandbox).** Accounts become USD balances, pending bills become payables, deposits become receivables.
  Nessie is US-dollar only, so foreign currency, amount and supplier bank details are kept in `data/nessie-meta.json`, keyed by Nessie id.
  ```powershell
  npm run import -- nessie seed [--fresh]                  # creates "XB-DEMO Acme Imports" in your Nessie sandbox (--fresh = new copy)
  npm run import -- nessie run                             # import -> payment run
  npm run import -- nessie run --execute --writeback       # also executes, then records each USD debit back in Nessie
  ```
- **Accounting export (CSV from QuickBooks, Xero or NetSuite: open bills plus expected receipts).**
  ```powershell
  npm run import -- csv template                           # the columns
  npm run import -- csv run samples/acme-ap-ar.csv [--execute]
  ```
- **Bank terms** (the savings baseline) go in `src/company/profile.ts`, taken from the company's statements.
- API: `POST /v1/company/import` with `{source:"csv", csv:"<text>"}` or `{source:"nessie", customerId:"..."}`.
- Validation now requires account details on every payment, checks Mexican CLABE check digits and the Canadian
  institution/transit format, and only warns (doesn't block) on Brazil local accounts without an IBAN.

For companies with several subsidiaries, netting and cash pooling are also available (`npm run treasury`).
Programmable rules and the agents run underneath as safety and operations features.

---

# payout-sim: route optimizer, orchestration, conversion, payout, ledger, reconciliation

## Stablecoin issuer limits

In **Policy & people → Stablecoin issuer limits**, an admin can set a default USD exposure limit and
expand **Set individual issuer limits** to override it for each issuer. Blank uses the default; zero
blocks new exposure. Coins from the same issuer share a limit (for example USDC and EURC share Circle's).
Quotes and release checks use the issuer's remaining room after existing in-flight and escrow exposure.
Changes are saved through the audited admin API. Existing policies keep their current default until edited.
Run `npm run issuer:test` for isolated policy, quote, exposure and authorization regression checks.

**Adaptive budgets:** expand **Adjust limits for each transfer** to enable treasury, settlement-time and
liquidity budgets underneath those hard ceilings. Demo settings: 50% of the router's unspent treasury per
issuer, 75% across stablecoin issuer exposure, 80% of quoted venue depth, and a 24-hour base window.
A 48-hour route consumes twice the budget of the same amount on a route within 24 hours. Escrow uses its
full lock window. These are configurable company rules, not estimated default probabilities or issuer ratings.
Every issuer touched by a swap is budgeted conservatively; two coins from one issuer count once.
Scheduled work, unresolved payouts and locked escrow retain exposure; a UI request and its transfer count once.
Quotes, approval, execution and dispatch refresh the same backend budget. A changed budget can require
a split, bank fallback or renewed approval; it cannot increase the approved debit or silently change routes.
The UI displays **Transfer limits checked**, and savings previews include the adaptive constraints.
`npm run exposure:test` checks these interactions without payments or external services.
Scenario USD exposure budgets remain separate from x402's small test-USDC spending limits.

**Cost and speed:** the default is `balanced`: route costs plus the Route402 fee and the company's cost of
cash during transit. `cheapest` minimizes cash cost after the platform fee; `fastest` minimizes arrival time,
then cost. The agents and UI use the same backend comparison values. Search includes every available route
and plans of up to three legs, with capacity boundaries calculated to currency precision plus interior split
samples. Cheapest, fastest and balanced summaries include split plans. This is the best evaluated feasible
plan within the available catalog and search limits, not a guarantee over unavailable markets or future prices.
Run `npm run optimization:test` for fee, split, speed/cost and exhaustive small-fixture comparisons.

The chat accepts follow-ups such as **I prefer the cheapest**, **use lowest fees**, **go with the faster
option**, and **balance speed and cost**. A draft keeps its supplier, amount, currency mode and deadline
while receiving a fresh preview and review revision. The preference is remembered in that conversation.
Without a draft, it is saved for the next payment. Completed payments are never cloned by a preference
change, and scheduled or unresolved transfers must be resolved first. Asking what a preference means
is read-only. These follow-ups never approve or execute a supplier payment.

## Route optimizer + orchestration (`npm run router`, port 8404)
The route finder that decides **how** each transfer moves, and the backend that the agents and the dashboard call.

**What it optimizes** (synthetic catalog in `src/router/registry.ts`, every number labeled):
- **Every complete route:** 3 bank providers; direct coin routes (onramp → coin → network → offramp); and two-coin routes
  (onramp → coin → on-chain swap to a local-currency coin → local redemption at par). Each route is priced with the same exact math the payout service executes.
- **Stablecoin catalog** (`registry.ts`), 22 fiat-reserved coins on 10 networks:
  - **USD:** USDC, PYUSD, USDG, USDP, RLUSD, GUSD.
  - **EUR:** EURC, EURCV, EURe.
  - **Local currencies:** QCAD, tGBP, XSGD, AUDD, JPYC, GYEN, MXNB, BRZ, TRYB, ZARP, XIDR, PHPC, cNGN.
  - Plus 16 swap venues and 17 offramps. Issuer, decimals, networks and liquidity are **demo assumptions**: verify each one before enabling.
- **Stable coins only.** Any coin more than 0.1% off its peg is excluded. A coin is used only when it's cheaper or faster; otherwise a bank route wins (for example USD→EUR or USD→JPY).
- **Cost and speed.** The default `balanced` objective is money cost plus the time value of a slower arrival. Bank cutoffs and weekends are modeled.
  Deadlines exclude late routes. `cheapest` and `fastest` are also reported.
- **Size tiers and capacity.** Large transfers split across up to 3 routes, each child priced at its own size, compared against the best single route.
- **Both modes:** send exactly X (`SOURCE_FIXED`) or deliver exactly Y (`RECIPIENT_FIXED`). Any ISO currency; pairs without a catalog rate need `--rate`.
- **Value.** Savings are measured against the customer's current correspondent wire. Our fee = 20% of measured savings, charged only when the customer saves.
- **Queues (advisory).** Netting own balances and confirmed inflows in the same ownership pool (no look-ahead; forecasts are never spent),
  batching same-currency payments into one conversion, and just-in-time funding. Reported against independent routing with own funds valued at mid rate.

**Execution:** intent → plan (termsHash) → approval → execute. Each leg runs on its own rail:
- **USDC on Base:** real **x402** testnet funding (it calls x402-spike `fund`).
- **Other coins:** labeled `simulated_token`.
- **Bank:** labeled `simulated_bank`.

Every leg then goes to the payout service, and the reconciliation is merged across split legs.

```powershell
npm run router                                   # window (with `npm run server` and the x402 seller running)
npm run route -- quote USD CAD 50000.00          # ranked plan, savings, fee, cheapest/fastest/best-x402
npm run route -- send USD CAD 50000.00 --live    # best route x402 can execute for real -> payout -> reconciliation
npm run route -- send USD CAD 500000.00          # split across providers (USDC-on-Base legs use x402)
npm run route -- quote USD CAD 68500.00 --type RECIPIENT_FIXED --deadline 2026-10-27T17:00:00Z
npm run route -- quote USD XOF 1000.00 --rate USD/XOF=605.20
npm run route -- queue                           # netting/batching/timing vs independent routing
```
**Agents:** in `services/agents/.env` set `MOCK_API=0`, `API_BASE_URL=http://localhost:8404`,
`AGENT_SERVICE_TOKEN=<ROUTER_TOKEN>`, and an empty `EVIDENCE_API_BASE_URL=`. Then `/coordinate` with a router `intentId` ranks real routes,
liquidity checks the treasury, the executor goes through the approval gate, and reconciliation and investigation read real transfers.

## Company tools (`npm run company -- hedge|discounts|validate|report`)
- **Multi-currency wallets + natural hedge.** Receivables in a currency pay that currency's payables first; only the shortfall or surplus
  is converted. Dates are respected and expected-but-unconfirmed receipts are never relied on. Demo: FX volume 3.02M → 0.85M USD, FX cost −12,074 USD.
- **Early-payment discount optimizer.** Pay early only when the annualized discount beats the cost of cash. Demo: +6,863 USD this cycle.
- **Beneficiary validation before sending.** IBAN checksum and length, SWIFT/BIC format and country, US routing checksum, unusual
  currency-for-country. Blocks the payments that would bounce back with fees and a second FX conversion.
- **report**: one page combining every saving lever.
Router endpoints: `POST /v1/company/hedge`, `/v1/company/discounts`, `/v1/company/beneficiaries/validate`.

## Treasury optimization for large groups (`npm run treasury -- netting|sweeps|rules`)
Large companies already get near-wholesale FX on a single payment. Their savings come from treasury structure:
- **Multilateral intercompany netting.** Subsidiaries settle one net amount each with a netting centre instead of paying invoice by invoice.
  In the demo group, 12 payments become 6, FX trades drop from 12 to 5, and FX notional falls 92.6% (net legs are priced by the optimizer).
- **Cash pooling / target-balance sweeps.** Surplus accounts cover overdrawn ones in the same currency and pool, so you stop paying overdraft
  interest while other accounts sit idle. Demo: +90,435 USD/yr and +46,458 EUR/yr after sweep fees.
- **Programmable treasury rules** (our own rule format): balance sweeps, top-ups, pay approved invoices via the optimizer,
  **bounded conversion windows** (best quote inside the window, forced at the deadline, never held beyond it), and
  **conditional payment release** (pay only when delivery is confirmed AND the invoice matches the PO; held otherwise, returned on expiry).
  Every proposal is either within a pre-approved mandate or needs approval, carries an idempotency key, and executes through `/v1/transfers`.
Router endpoints: `POST /v1/treasury/netting`, `/v1/treasury/sweeps`, `/v1/treasury/rules/evaluate` (empty body = demo data).

---

# Conversion, payout, ledger and reconciliation (guide prompt A5)

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
