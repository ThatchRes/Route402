# Contextual company chat

Open `http://localhost:8404/app/#/chat` after running `./start-local.ps1` from the project root.

Try these messages in one conversation:

1. `Which of my supplier companies use MXN?`
2. `Pay them` to preview their linked invoices, or `send them 50000` to preview a new payment. If several suppliers match, choose one by name or say `the first one`.
3. `Make it 60000 instead` or `change the deadline to 2026-11-03`.
4. `Why did it fail?` or `did it work?` to inspect the last agent review or submitted transfer status.

Other supported requests include `list my suppliers`, `what about CAD`, `what do we owe them`, supplier bank-detail checks, savings, and currency conversion. “Companies” here means supplier companies connected to the current business. Unrelated requests are redirected to company payments and suppliers.

Feature explanations are read-only: `What does the router do?`, `How does approval work?`, `What is USDC?`, `What does local simulation do?`, and `What does that mean?`. They preserve the payment being discussed and make no paid tool calls.

To create a supplier, say `add a supplier`. The chat collects its name, country, and receiving currency. Review & save opens a receiving-details form; sign-in, an authorized preparer/admin role, validation, and explicit confirmation are required to save. Saving creates no invoice or payment. Then ask `send them 500`.

Recent chats are saved in this browser and can be reopened. Each conversation has independent server-side supplier selections, payment slots, revisions, and review outcomes. An amount or deadline edit creates a fresh preview and invalidates old chat approval buttons. A completed transfer is unchanged; any further payment is a separate preview. Transfers whose outcome is unresolved must be resolved before retrying or changing an amount.

## How it connects

`Browser /ui/ask → Fetch.ai concierge /ask → router /v1/assistant/ask → structured conversation → existing payment planner → routing/compliance agents`

Informational requests use linked company data without buying quotes. Payment previews retain the existing routing, compliance, deadline checks, and approval flow. In local mode the same tools use simulated evidence and spend no USDC. Understanding uses scoped templates and structured slots, rather than an unrestricted general-purpose chatbot.

The browser sends only the new message, conversation ID, and expected revision. The router stores conversations under `data/conversations/`, scoped by tenant and company; client transcripts cannot authorize payments. New suppliers are stored separately in `data/suppliers.json`. With the local launcher these paths live inside the isolated local workspace. Fetch.ai chat senders also get stable conversation IDs.

Validation: `npm run context:test`, `npm run security:test`, `npm run deadline:test`, TypeScript checking, and `python -m unittest test_context test_deadlines` from `services/agents` using its virtual environment. These suites use isolated data or mocked agent tools and submit no payments.
