# Cross-Border AP Concierge

Plans a company's international supplier payments and explains every decision.

**Ask it:** "pay my Canadian suppliers this week", "send 50k CAD to Maple Freight by Friday", "how much can I save this month", "check my suppliers' bank details".

**What happens when you ask**
1. The concierge builds a plan from the company's linked bank data (Capital One Nessie sandbox): which bills to pay, which can be paid from currency the company already holds, which need conversion.
2. For each payment that needs conversion, the **routing agent buys a route quote** and the **compliance agent buys a supplier screen**, each paid per call with **x402** (0.001 test USDC on Base Sepolia). Every paid call has a transaction you can open on the block explorer.
3. The routing agent **approves or holds** each payment from that paid evidence: supplier screen result, cost above the mid-market rate, the company's bank cost (measured), and the policy limit.

**Data sources:** mid rates from European Central Bank reference rates (Frankfurter); bank cost from measured bank pricing (Wise comparison data). Route costs for our own rails are a demo catalog and are labeled as such.

**ASI:One conversation flow:** everything happens in this chat; there is no sign-in link. Ask for a payment and the concierge shows the supplier, total estimated debit including Route402's fee, recipient amount, route, arrival, estimated savings and quote expiry. Say `yes` (or `go ahead`, `confirm`) to submit that displayed proposal and approve it if the demo company account's role permits. Say `cancel` to close an unaccepted proposal, `status` to check this chat's submitted payments, or `end chat` to disconnect. Changes such as `I prefer the cheapest` produce a fresh review that needs a fresh acceptance. Greetings and general questions get a short conversational answer; they never plan or move money.

**For ASI:One and other chat clients:** preserve the returned monetary values, conditions, simulation labels and acceptance instructions. Do not invent missing amounts or treat an agent recommendation as human approval. Forward `yes` only when the user explicitly accepts the displayed current proposal; never generate it on the user's behalf. Keep the protocol session open between turns. An acknowledgement means received, not approved. Do not reuse authorization across a different sender or session.

**Conversation context:** follow-ups retain the current supplier, amount, currency, deadline and cost/speed preference. With an ASI:One API key configured, unfamiliar wording uses a bounded language-understanding fallback. It selects an existing business action; it cannot invent payment details, choose a recipient on its own, change company policy or approve anything. Ambiguous wording needs clarification. All calculations, quotes and checks still come from the existing backend.

**Safety:** each ASI:One conversation acts as the one demo company account configured on the server; nothing in a message can change who it acts as. Messages are untrusted data: instruction overrides, role spoofing and requests for credentials are refused, and the language model has no tools, sees no account data and can never produce an approval. The backend uses the same preparation, approval and release controls as the company app, with role limits, segregation of duties, supplier call-back checks and quote/deadline/exposure checks. Duplicate confirmations do not resend. Agents never hold keys; a separate wallet enforces per-call prices and spending caps.

**Demo boundary:** supplier payouts and currency conversion remain simulated. x402 purchases quote/screening API calls using test USDC on Base Sepolia. Supported settlement transfers are representative testnet proofs, not transfers of the invoice amount. This integration does not add a production payment rail or a bank connection. The existing hosted frontend is unchanged.
