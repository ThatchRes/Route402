# x402-spike: x402 payments, agent wallet and escrow

One **real, capped test-USDC payment on Base Sepolia**:

```
Router ──POST /orders──▶ seller :8402   (order bound to transferId, planVersion, termsHash)
buyer (backend wallet) ──GET /fund?orderId── 402 ──validate terms──▶ sign ──▶ CDP facilitator settles on-chain
seller records tx ──▶ SETTLED_PENDING_CONFIRMATION ──confirm.ts checks chain──▶ FUNDING_CONFIRMED ──▶ A starts payout
```

| Rule | Where |
|---|---|
| Create order + quote record before requesting funds; bind to approved terms | `POST /orders` (idempotent, never mutated) |
| Validate network, token contract, amount, receiver, lifetime **before signing** | `policy.checkRequirements` in `buyer.ts` |
| Restricted signing + per-payment and cumulative caps | CDP backend wallet, `spendControls`, `withinCap` |
| Persist the attempt before submission | `buyer.ts` step 4 |
| Settlement tracked separately; payout never started in the handler | `paymentFlow: "upfront"` + `/fund` handler only records |
| Verification is not finality: check the real USDC Transfer and confirmations | `confirm.ts` + `chain.verifyTransfer` |
| Duplicate / restart / timeout cannot cause a second transfer | guard before 402, in-flight lock, `canStartAttempt`, `reconcile.ts` |
| One tx cannot fund two orders | `txIndex` |
| Mainnet disabled; show test amount separately from the scenario amount | `config.ts` (testnet only), buyer output |

## 1. Coinbase Developer Platform (one time, about 10 min)
1. Sign in at https://portal.cdp.coinbase.com and create a project.
2. **API Keys** → create a **Secret API key**. Copy the key ID and the secret.
3. **Server Wallet** (or Wallets) → generate a **Wallet Secret**. Copy it.
4. Pick a **receiving address** you control on Base Sepolia (Coinbase Wallet or MetaMask). This is `X402_PAY_TO`.

## 2. Install (PowerShell, Node 22+)
```powershell
cd x402-spike
node --version          # must be v22 or newer
npm install
Copy-Item .env.example .env
notepad .env            # fill CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET, X402_PAY_TO, X402_INTERNAL_TOKEN
npm run selftest        # 13 offline safety checks, no keys or money needed
```
`.env` is loaded automatically, so you don't need the PowerShell env trick here.

## 3. Fund the buyer wallet with test USDC
```powershell
npm run address         # prints the buyer wallet
npm run faucet          # requests test USDC from the CDP faucet (or use https://faucet.circle.com, Base Sepolia)
```
Gas is paid by the facilitator for this USDC transfer method, so the buyer needs only test USDC. If the payment fails on gas, also request Base Sepolia ETH from the CDP faucet.

## 4. Run the payment (two windows)
```powershell
# Window A
npm run seller
# Window B
npm run order -- tr_demo_1          # stand-in for the router creating the order after approval
npm run pay -- fund_tr_demo_1_v1    # validates the 402, then pays 0.01 test USDC
npm run confirm                     # FUNDING_CONFIRMED after 3 confirmations (rerun, or use -- --watch)
npm run status                      # orders + attempts table
```
Open the printed `sepolia.basescan.org` link. That is the on-chain proof of the payment.

## 5. Safety demos
```powershell
npm run pay -- fund_tr_demo_1_v1    # again: refused ("order is ...", no second payment)
npm run reconcile                   # resolves any UNKNOWN attempt from chain logs before a new attempt is allowed
```

## Reconciliation and one-command funding
```powershell
npm run audit                      # every order: approved terms vs seller record vs buyer record vs chain
npm run audit -- fund_tr_demo_1_v1
npm run fund -- tr_demo_2          # order -> validated pay -> wait for confirmations; last line: FUNDED <orderId> <tx>
```
The seller also serves `GET /orders/:orderId/reconciliation`. The payout service requires its outcome to be `MATCHED`
before it pays out. The cumulative cap is 0.25 test USDC (25 transfers at 0.01).

## Integration with the router
- Port `store.ts` to PostgreSQL tables: `funding_orders`, `funding_attempts`, plus a unique `tx_hash`.
- The router calls `POST /orders` after plan approval, then runs `buyer` logic from its execution worker,
  and starts the payout only when the order is `FUNDING_CONFIRMED`.
- The tx hash, payer, amount and confirmations go to the transfer event timeline with `provenance: "testnet"`.

## Tested here vs. not
- Tested: typecheck, all 13 policy checks, order idempotency, guard (unknown, funded, double pay refused before any 402),
  and settlement recording, with a stand-in facilitator.
- Not tested here (needs your CDP keys and internet): the real facilitator settlement, the faucet, and chain confirmation.
