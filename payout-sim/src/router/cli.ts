// npm run route -- quote <SRC> <DEST> <amount> [--type RECIPIENT_FIXED] [--objective balanced|cheapest|fastest] [--live] [--deadline ISO] [--rate USD/XOF=605.2] [--no-split]
// npm run route -- send  <SRC> <DEST> <amount> [same flags]      quote -> plan -> approve -> execute -> reconciliation
// npm run route -- queue                                          advisory netting/batching/timing plan for the demo queue
import "dotenv/config";
const BASE = `http://localhost:${process.env.ROUTER_PORT ?? 8404}`;
const H = { authorization: `Bearer ${process.env.ROUTER_TOKEN ?? "dev-token"}`, "content-type": "application/json" };
const argv = process.argv.slice(2), [cmd, src, dest, amount] = argv;
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const call = async (method: string, p: string, body?: any, extra: Record<string, string> = {}) => {
  const r = await fetch(`${BASE}${p}`, { method, headers: { ...H, ...extra }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok && r.status !== 202) { console.error(r.status, JSON.stringify(j, null, 2)); process.exit(1); } return j;
};

function printDecision(d: any) {
  if (d.status !== "OK") { console.log(d.status, d.missing ?? d.reason); return; }
  console.log(`\nbest plan (${d.plan}, objective ${d.objective}): ${d.totals.sourceDebit} -> ${d.totals.recipientNet}, arrives ${d.totals.arrivalUtc}`);
  for (const a of d.allocations) console.log(`  ${a.routeId}${a.x402Executable ? "  [x402 live]" : a.token ? "  [simulated rail]" : "  [bank, simulated]"}  ${a.quote.sourceDebit.display} -> ${a.quote.recipientNet.display}`);
  console.log(`  vs customer's current wire: ${d.baseline?.sourceDebit} -> ${d.baseline?.recipientNet}, arrives ${d.baseline?.arrivalUtc}`);
  console.log(`  customer saves ${d.value.customerSavings} | our fee ${d.value.platformFee} (${d.value.feeRule}) | customer keeps ${d.value.customerNetSaving}`);
  console.log(`  cheapest plan: ${d.cheapest?.routeId} | fastest plan: ${d.fastest?.routeId} | best x402-executable: ${d.bestX402?.routeId ?? "none"} ${d.bestX402 ? `(${d.bestX402.recipientNet})` : ""}`);
  console.log(`  ${d.execution}`);
  const ex = d.candidates.filter((c: any) => !c.eligible);
  if (ex.length) console.log(`  excluded (${ex.length}): ` + ex.slice(0, 4).map((c: any) => `${c.routeId}: ${c.reason}`).join(" | "));
}

if (cmd === "quote" || cmd === "send") {
  const rate = flag("rate"); const midOverrides = rate ? { [rate.split("=")[0]]: rate.split("=")[1] } : undefined;
  const intent = { srcCcy: src, destCcy: dest, amount, amountType: flag("type") ?? "SOURCE_FIXED", objective: flag("objective"),
    deadlineUtc: flag("deadline"), liveOnly: argv.includes("--live"), allowSplit: !argv.includes("--no-split"), midOverrides };
  const { intentId, decision } = await call("POST", "/v1/intents", intent);
  console.log(`intent ${intentId}`); printDecision(decision);
  if (cmd === "send" && decision.status === "OK") {
    const t = await call("POST", "/v1/transfers", { intentId }, { "idempotency-key": `create_${intentId}` });
    console.log(`\nplan ${t.transferId} v${t.planVersion} termsHash ${t.termsHash.slice(0, 16)}... -> approving as demo-operator`);
    await call("POST", `/v1/transfers/${t.transferId}/approvals`, { planVersion: t.planVersion, termsHash: t.termsHash, approver: "demo-operator" });
    await call("POST", `/v1/transfers/${t.transferId}/execute`, { planVersion: t.planVersion, termsHash: t.termsHash }, { "idempotency-key": `exec_${t.transferId}` });
    let s: any;
    for (let i = 0; i < 120; i++) { s = await call("GET", `/v1/transfers/${t.transferId}`); if (!["EXECUTING", "APPROVED"].includes(s.status)) break; await new Promise((r) => setTimeout(r, 2000)); }
    console.log(`\ntransfer ${t.transferId}: ${s.status}`);
    for (const [k, v] of Object.entries<any>(s.steps)) console.log(`  ${k.padEnd(10)} ${v.status.padEnd(10)} ${v.rail ?? ""}${v.orderId ? ` order ${v.orderId}` : ""}${v.detail ? ` ${v.detail}` : ""}`);
    const r = await call("GET", `/v1/transfers/${t.transferId}/reconciliation`);
    console.log(`\nreconciliation${r.outstanding?.fundedButUnpaid ? " (FUNDED BUT UNPAID)" : ""}:`);
    for (const l of r.legs) console.log(`  ${(l.status ?? (l.expected === l.observed ? "MATCHED" : "MISMATCH")).padEnd(20)} ${l.leg.padEnd(19)} ${l.observed ?? "-"}`);
    console.log(`\nreceipt: GET ${BASE}/v1/transfers/${t.transferId}/receipt`);
  }
} else if (cmd === "queue") {
  const q = await call("POST", "/v1/queues/plan", {});
  for (const s of q.steps) console.log(`  ${s.payment.padEnd(44)} ${s.action}  ${s.amount}${s.costUsd ? `  cost ${s.costUsd}` : ""}`);
  console.log(`\n  ${q.notes.join("\n  ")}\n  blocked: ${q.blockedPools.join("; ")}\n  ${q.forecastShown.join("; ")}`);
  const m = q.metrics;
  console.log(`\n  economic cost   plan ${m.economicCost.plan}  vs baseline ${m.economicCost.baseline}  (delta ${m.netCostDelta})`);
  console.log(`  peak prefunding plan ${m.peakPrefunding.plan}  vs baseline ${m.peakPrefunding.baseline}`);
  console.log(`  FX volume       plan ${m.fxVolume.plan}  vs baseline ${m.fxVolume.baseline}   own balances used ${m.ownBalancesUsed}`);
  console.log(`  on time         plan ${m.onTime.plan}  vs baseline ${m.onTime.baseline}   (advisory only: nothing executed)`);
} else console.log("usage: npm run route -- quote|send <SRC> <DEST> <amount> [flags]  |  npm run route -- queue");
