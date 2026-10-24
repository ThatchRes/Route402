// Talk to the Fetch.ai agents (the concierge on :8100). The agents buy quotes and supplier screens with x402,
// then approve or hold each payment. This file only prints their answer; execution stays behind approval.
import "dotenv/config";
import { randomUUID } from "node:crypto";

const GATEWAY = process.env.AGENT_GATEWAY_URL ?? "http://127.0.0.1:8100";
const TOKEN = () => process.env.AGENT_SERVICE_TOKEN ?? process.env.ROUTER_TOKEN ?? "dev-token";
const TENANT = process.env.AGENT_TENANT ?? "demo-tenant";

export interface AgentAnswer { status: string; template?: string; title?: string; clarification?: string; preview?: any; decisions: any[];
  paidCalls: any[]; spentUsdc: string; hops: any[]; next?: string; error?: string; correlationId: string; policy?: string }

async function post(path: string, body: any): Promise<AgentAnswer> {
  const correlationId = `cli-${randomUUID().slice(0, 12)}`;
  let r: Response;
  try {
    r = await fetch(`${GATEWAY}${path}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, tenantId: TENANT, correlationId, serviceToken: TOKEN() }), signal: AbortSignal.timeout(280_000) });
  } catch (e: any) {
    throw new Error(`agents not reachable at ${GATEWAY} (${e.cause?.code ?? e.message}). Start them: python workers.py and python gateway.py in services/agents (or add --direct to skip the agents)`);
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`agents answered HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
export const askAgents = (text: string, policy?: string) => post("/ask", { text, policy });
export const reviewWithAgents = (homeCcy: string, currentBank: any, payments: any[], policy?: string) => post("/review", { homeCcy, currentBank, payments, policy });
/** --policy cheapest|fastest|lowest_risk from the command line (undefined = read from the prompt, else the default) */
export const policyFlag = () => { const i = process.argv.indexOf("--policy"); return i >= 0 ? process.argv[i + 1] : undefined; };

/** Payments that need conversion in a payment run (wallet-funded bills need no quote). */
export function paymentsOf(run: any) {
  return run.lines.filter((l: any) => l.convertedAmount && Number(l.convertedAmount) > 0 && (l.crossBorder ?? l.ccy !== run.homeCcy))
    .map((l: any) => ({ payable: l.payable, destCcy: l.ccy, amount: l.convertedAmount, deadlineUtc: l.deadlineUtc, beneficiary: l.beneficiary, reference: l.reference ?? l.payable }));
}

export function printAgents(a: AgentAnswer) {
  if (!a.decisions?.length) return;
  console.log(`\n  agents (Fetch.ai)  ${a.hops.map((h: any) => `${h.from}->${h.to}`).join("  ")}`);
  console.log(`  routing policy: ${a.policy ?? "cheapest"}   (change it: add "fastest" or "lowest risk" to the prompt, or --policy)`);
  for (const d of a.decisions) {
    console.log(`    ${d.payable.padEnd(18)} ${(d.decision.toUpperCase() + (d.chosen ? ` via ${d.chosen}` : "")).padEnd(22)} ${d.reasons[0] ?? ""}`);
    for (const r of d.reasons.slice(1)) console.log(`    ${"".padEnd(41)} ${r}`);
    for (const c of d.paidCalls ?? []) console.log(`    ${"".padEnd(41)} ${c.buyer} paid ${c.priceUsdc} test USDC for ${c.service}  ${c.mock ? "(MOCK)" : c.explorer}`);
  }
  console.log(`    x402 pay-per-call: ${a.paidCalls.length} calls, ${a.spentUsdc} test USDC on Base Sepolia (agent wallet -> stablecoin-rail and bank quote providers + screening service)`);
}
