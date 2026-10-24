// Only responses obtained directly from the configured concierge populate this store.
// The browser chooses an allowed quote; it cannot supply screening outcomes or remove approval requirements.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadLinked } from "./linked.js";
import { conversationView } from "./conversation.js";
const key = (tenant: string, id: string) => createHash("sha256").update(JSON.stringify([tenant, loadLinked().input.company.companyId, id])).digest("hex");
const file = "data/ui-reviews.json";
const read = (): Record<string, any> => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};

export function recordUiReview(tenant: string, answer: any) {
  if (answer.status !== "ok" || !Array.isArray(answer.decisions)) return;
  const rows = read();
  for (const d of answer.decisions) {
    if (!["approve", "review"].includes(d.decision) || !d.intentId) continue;
    const choices = [{ intentId: d.intentId, provider: d.chosen, routeIds: d.routeIds }, ...(d.options ?? []).filter((o: any) => o.eligible || o.requiresCostApproval)];
    for (const option of choices) if (typeof option.intentId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(option.intentId)) rows[key(tenant, option.intentId)] = {
      decision: { ...d, intentId: option.intentId, chosen: option.provider, routeIds: option.routeIds,
        decision: option.requiresCostApproval ? "review" : d.decision,
        needs: [...new Set([...(d.needs ?? []), ...(option.requiresCostApproval ? ["cost approval"] : [])])] },
      conversationId: answer.conversationId, revision: answer.conversationRevision, at: Date.now() };
  }
  // Bounded disk usage; expired quotes must be reviewed again.
  const kept = Object.fromEntries(Object.entries(rows).filter(([, row]) => Date.now() - row.at < 24 * 60 * 60e3).slice(-2000));
  mkdirSync("data", { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(kept)); renameSync(`${file}.tmp`, file);
}

// Read-only: was this quote returned by the agents to this workspace within the review window?
export function reviewedIntent(tenant: string, intentId: string) {
  const row = /^[A-Za-z0-9_-]{1,80}$/.test(intentId) ? read()[key(tenant, intentId)] : undefined;
  return row && Date.now() - row.at < 24 * 60 * 60e3 ? row : undefined;
}

export function trustedUiDecision(tenant: string, client: any) {
  const row = typeof client?.intentId === "string" ? read()[key(tenant, client.intentId)] : undefined;
  if (!row || row.decision.payable !== client.payable || Date.now() - row.at >= 24 * 60 * 60e3) throw new Error("No current agent review for this quote. Request a fresh preview.");
  if (row.conversationId && conversationView(tenant, row.conversationId).conversationRevision !== row.revision) throw new Error("This conversation changed. Request a fresh preview.");
  return row.decision;
}
