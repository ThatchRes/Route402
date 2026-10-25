// Stand-in for the router backend.
//   npm run transfer -- <scenario> [--expired]                     full flow: x402 funding (stablecoin routes) -> payout -> reconciliation
//   npm run transfer -- custom --from USD --to BRL --amount 1000.00 --rate 5.4321 [--type SOURCE_FIXED|RECIPIENT_FIXED]
//        [--route stablecoin|bank] [--asset USDC] [--onramp-rate 1.000000] [--funding-fee 2.00] [--payout-fee 10.00] [--outcome delivered]
//   npm run payout -- <scenario> [x402OrderId]                    payout only (you funded via x402 yourself)
//   npm run show -- <transferId>      npm run refresh -- <payoutId>      npm run payout   (lists scenarios)
import "dotenv/config";
import { spawnSync } from "node:child_process";
import path from "node:path";

const BASE = `http://localhost:${process.env.PORT ?? 8403}`;
const X402_DIR = process.env.X402_DIR ?? path.resolve("..", "x402-spike");
const H = { authorization: `Bearer ${process.env.PAYOUT_INTERNAL_TOKEN ?? "dev-token"}`, "content-type": "application/json" };
const argv = process.argv.slice(2);
const [cmd, a, b] = argv;
const flag = (name: string, dflt?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function scenarios() { return (await (await fetch(`${BASE}/scenarios`)).json()) as any[]; }

function fundViaX402(transferId: string): string {
  console.log(`\n== x402 funding leg (${X402_DIR})`);
  const r = spawnSync("npx", ["tsx", "src/fund.ts", transferId], { cwd: X402_DIR, encoding: "utf8", shell: process.platform === "win32" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  console.log(out.trim().split("\n").filter((l) => /settled|tx |explorer|confirmations|FUNDED|REFUSED|rejected|UNKNOWN|error|Error/.test(l)).join("\n"));
  const last = out.trim().split("\n").reverse().find((l) => l.startsWith("FUNDED ") || l.startsWith("NOT_FUNDED "));
  if (!last?.startsWith("FUNDED ")) { console.error("x402 funding did not complete: no payout created (nothing to undo)"); process.exit(1); }
  return last.split(" ")[1];
}

async function createPayout(transferId: string, body: any) {
  const r = await fetch(`${BASE}/payouts`, { method: "POST", headers: { ...H, "idempotency-key": `op_${transferId}` }, body: JSON.stringify(body) });
  const p = await r.json();
  if (!r.ok && r.status !== 202) { console.error(r.status, JSON.stringify(p)); process.exit(1); }
  if (p.status === "FUNDING_NOT_CONFIRMED") console.error(`\nNO PAYOUT: ${p.history?.at(-1)?.note}\nIf x402 audit is UNREACHABLE, check SELLER_URL and that X402_INTERNAL_TOKEN matches x402-spike/.env, restart this server, then:\n  npm run payout -- ${body.scenario ?? "<scenario>"} ${body.funding?.orderId ?? ""}`);
  console.log(`\n== payout ${p.payoutId} ${p.status}`);
  const q = p.quote;
  console.log(`quote (synthetic, ${q.amountType}): debit ${q.sourceDebit.display} -> funding ${q.funding.display}${q.funding.viaX402 ? " [x402]" : ""} -> converted ${q.converted.display} -> recipient ${q.recipientNet.display}`);
  return p;
}

async function waitAndReconcile(transferId: string, payoutId: string) {
  const terminal = ["DELIVERED", "PAYOUT_REJECTED", "PAYOUT_UNKNOWN", "HOLD_QUOTE_EXPIRED", "FUNDING_NOT_CONFIRMED"];
  for (let i = 0; i < 30; i++) {
    const p = await (await fetch(`${BASE}/payouts/${payoutId}`, { headers: H })).json();
    if (terminal.includes(p.status)) break;
    await sleep(1000);
  }
  await sleep(1500);   // let any trailing events (late success, duplicates) land
  const r = await (await fetch(`${BASE}/v1/transfers/${transferId}/reconciliation`, { headers: H })).json();
  console.log(`\n== reconciliation ${transferId}: payout ${r.status}${r.outstanding.fundedButUnpaid ? ` | FUNDED BUT UNPAID: ${r.outstanding.payoutClearing}` : " | nothing outstanding"}`);
  for (const l of r.legs)
    console.log(`  ${(l.status ?? (l.expected === l.observed ? "MATCHED" : l.observed ? "MISMATCH" : "PENDING")).padEnd(21)} ${l.leg.padEnd(19)} expected ${l.expected} | observed ${l.observed ?? "-"}  [${l.provenance ?? ""}]`);
  console.log(`\nreceipt: GET ${BASE}/v1/transfers/${transferId}/receipt    timeline: npm run show -- ${transferId}`);
}

if (cmd === "transfer") {
  if (!a) { (await scenarios()).forEach((s) => console.log(`${s.id.padEnd(24)} ${s.quote.route.padEnd(10)} ${s.label}`)); process.exit(0); }
  const transferId = `tr_${a}_${Date.now().toString(36)}`;
  let body: any, route: string, scenarioLive = false;
  if (a === "custom") {
    route = flag("route", "stablecoin")!;
    body = { custom: { route, srcCcy: flag("from"), destCcy: flag("to"), amountType: flag("type", "SOURCE_FIXED"), amount: flag("amount"),
      fxRate: flag("rate"), fundingFee: flag("funding-fee", "0"), payoutFee: flag("payout-fee", "0"), outcome: flag("outcome", "delivered"),
      ...(route === "stablecoin" ? { fundingAsset: flag("asset", "USDC"), onrampRate: flag("onramp-rate", "1.000000"), network: flag("network", "base") } : {}) } };
    const pre = await fetch(`${BASE}/quotes/preview`, { method: "POST", headers: H, body: JSON.stringify(body.custom) });
    if (!pre.ok) { console.error(JSON.stringify(await pre.json(), null, 2)); process.exit(1); }   // validate BEFORE spending x402 funds
  } else {
    const s = (await scenarios()).find((x) => x.id === a);
    if (!s) { console.error(`unknown scenario ${a}`); process.exit(1); }
    route = s.quote.route; scenarioLive = !!s.quote.funding.viaX402; body = { scenario: a };
  }
  body.transferId = transferId;
  body.quoteExpiresAt = argv.includes("--expired") ? new Date(Date.now() - 60_000).toISOString() : new Date(Date.now() + 900_000).toISOString();
  const live = body.custom ? route === "stablecoin" && body.custom.fundingAsset === "USDC" && body.custom.network === "base" : scenarioLive;
  body.funding = live ? { mode: "x402_testnet", orderId: fundViaX402(transferId) } : route === "stablecoin" ? { mode: "simulated_token" } : { mode: "simulated_bank" };
  const p = await createPayout(transferId, body);
  await waitAndReconcile(transferId, p.payoutId);
} else if (cmd === "payout") {
  if (!a) { (await scenarios()).forEach((s) => console.log(`${s.id.padEnd(24)} ${s.quote.route.padEnd(10)} ${s.label}`)); process.exit(0); }
  const transferId = `tr_${a}_${Date.now().toString(36)}`;
  const p = await createPayout(transferId, { transferId, scenario: a, quoteExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    funding: b ? { mode: "x402_testnet", orderId: b } : { mode: "simulated_bank" } });
  await waitAndReconcile(transferId, p.payoutId);
} else if (cmd === "show") {
  for (const p of ["events", "reconciliation"]) { console.log(`--- ${p}`); console.log(JSON.stringify(await (await fetch(`${BASE}/v1/transfers/${a}/${p}`, { headers: H })).json(), null, 2)); }
} else if (cmd === "refresh") {
  const p = await (await fetch(`${BASE}/payouts/${a}/refresh`, { method: "POST", headers: H })).json(); console.log(p.status ?? p.note, p.history?.slice(-2));
} else console.log("commands: transfer <scenario|custom ...> | payout <scenario> [x402OrderId] | show <transferId> | refresh <payoutId>");
