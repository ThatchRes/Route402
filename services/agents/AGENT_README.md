# Cross-Border AP Concierge

Plans a company's international supplier payments and explains every decision.

**Ask it:** "pay my Canadian suppliers this week", "send 50k CAD to Maple Freight by Friday", "how much can I save this month", "check my suppliers' bank details".

**What happens when you ask**
1. The concierge builds a plan from the company's linked bank data (Capital One Nessie sandbox): which bills to pay, which can be paid from currency the company already holds, which need conversion.
2. For each payment that needs conversion, the **routing agent buys a route quote** and the **compliance agent buys a supplier screen**, each paid per call with **x402** (0.001 test USDC on Base Sepolia). Every paid call has a transaction you can open on the block explorer.
3. The routing agent **approves or holds** each payment from that paid evidence: supplier screen result, cost above the mid-market rate, the company's bank cost (measured), and the policy limit.

**Data sources:** mid rates from European Central Bank reference rates (Frankfurter); bank cost from measured bank pricing (Wise comparison data). Route costs for our own rails are a demo catalog and are labeled as such.

**Safety:** chat is preview-only. Payments are sent only after approval in the company app, and only on the exact plan the routing agent approved. Agents never hold keys; a separate wallet enforces the per-call price and a spending cap. Testnet only.
