// Deterministic SIMULATED payout provider. It behaves like a real one: idempotent create by operation
// reference, status lookup, and HMAC-signed webhooks that can be delayed, duplicated or out of order.
// Replace this file with a real provider adapter later; the server code does not change.
import { createHmac, randomUUID } from "node:crypto";
import { load, update } from "./store.js";
import { fmt } from "./money.js";
import type { Outcome } from "./scenarios.js";

const SECRET = () => process.env.PROVIDER_WEBHOOK_SECRET ?? "dev-secret";
const DELAY = () => Number(process.env.SIM_EVENT_DELAY_MS ?? 1500);
const PORT = () => Number(process.env.PORT ?? 8403);

export function sign(ts: string, raw: string) {
  return createHmac("sha256", SECRET()).update(`${ts}.${raw}`).digest("hex");
}

function plan(outcome: Outcome, quote: any) {
  const ccy = quote.recipientNet.ccy;
  const net = BigInt(quote.recipientNet.minor);
  const conv = { type: "CONVERSION_COMPLETED", amount: quote.converted.minor, currency: ccy };
  const credit = (m: bigint, final = true) => ({ type: "BENEFICIARY_CREDITED", amount: m.toString(), currency: ccy, final });
  const base = [{ type: "PAYOUT_ACCEPTED" }, conv];
  switch (outcome) {
    case "delayed": return [...base, { ...credit(net), wait: 6 }];
    case "rejected": return [...base, { type: "PAYOUT_REJECTED", reason: "beneficiary account closed" }];
    case "mismatch": return [...base, credit(net - 500n)];            // final credit, 500 minor units short
    case "partial": { const part = (net * 6n) / 10n;
      return [...base, credit(part, false), { type: "PAYOUT_REJECTED", reason: "remaining amount exceeds beneficiary limit" }]; }
    case "late_success": return [...base, { type: "PAYOUT_REJECTED", reason: "temporary bank outage" }, { ...credit(net), wait: 3 }];
    default: return [...base, credit(net)];             // delivered, timeout, chaos
  }
}

async function deliver(ev: any) {
  const raw = JSON.stringify(ev);
  const ts = Math.floor(Date.now() / 1000).toString();
  try {
    await fetch(`http://127.0.0.1:${PORT()}/webhooks/provider`, { method: "POST", body: raw,
      headers: { "content-type": "application/json", "x-sim-timestamp": ts, "x-sim-signature": sign(ts, raw) } });
  } catch { /* provider retries are modeled by /refresh status lookup */ }
}

function schedule(opRef: string) {
  const rec = load().provider[opRef];
  if (!rec) return;
  const outcome = rec.plan[0]?.__outcome as Outcome;
  const events = rec.plan.filter((e: any) => !e.__outcome && !e.emitted);
  let order = events.map((e: any, i: number) => ({ e, i }));
  if (outcome === "chaos" && events.length === 3) order = [order[2], order[0], order[1], order[2]];   // credit first, then dup
  let t = 0;
  for (const { e } of order) {
    t += DELAY() * (e.wait ?? 1);
    setTimeout(() => {
      update((db) => { const r = db.provider[opRef]; const pe = r.plan.find((x: any) => x.eventId === e.eventId); pe.emitted = true; });
      if (outcome !== "timeout") deliver(stripInternal(e));   // timeout: webhooks lost, only status lookup finds them
    }, t);
  }
}

function stripInternal(e: any) { const { wait, emitted, ...rest } = e; return rest; }

/** Idempotent: the same opRef always returns the same provider order and never schedules twice. */
export function createPayout(opRef: string, quote: any, outcome: Outcome): { providerRef: string; created: boolean } {
  const existing = load().provider[opRef];
  if (existing) return { providerRef: existing.providerRef, created: false };
  const providerRef = `sim_${randomUUID().slice(0, 8)}`;
  const events = plan(outcome, quote).map((e: any, i: number) => ({
    ...e, eventId: randomUUID(), opRef, providerRef, sequence: i + 1, provenance: "simulated",
    occurredAt: new Date(Date.now() + DELAY() * (i + 1)).toISOString(),
    display: e.amount ? fmt(BigInt(e.amount), e.currency) : undefined,
  }));
  update((db) => { db.provider[opRef] = { opRef, providerRef, plan: [{ __outcome: outcome }, ...events], createdAt: new Date().toISOString() }; });
  schedule(opRef);
  return { providerRef, created: true };
}

/** Status lookup by OUR operation reference (used after a timeout). Returns already-emitted events. */
export function getStatus(opRef: string) {
  const rec = load().provider[opRef];
  if (!rec) return { found: false as const };
  return { found: true as const, providerRef: rec.providerRef,
    events: rec.plan.filter((e: any) => !e.__outcome && e.emitted).map(stripInternal) };
}

/** After a restart, re-send anything not yet emitted (real providers retry webhooks too). */
export function resumeAll() { for (const opRef of Object.keys(load().provider)) {
  const rec = load().provider[opRef];
  if (rec.plan.some((e: any) => !e.__outcome && !e.emitted)) schedule(opRef);
} }
