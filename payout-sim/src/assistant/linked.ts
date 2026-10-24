// "Linked accounts": the company's data after it connects its bank (Nessie) or uploads its accounting export (CSV).
// Saved once at link time so every prompt reuses it (no re-fetching, no LLM): data/linked.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { PaymentRunInput } from "../company/paymentRun.js";
import { DEMO_RUN } from "../company/demo.js";
const FILE = "data/linked.json";
export interface Linked { source: string; linkedAt: string; usdAvailable?: string; input: PaymentRunInput }
export function saveLinked(l: Linked) { mkdirSync("data", { recursive: true }); writeFileSync(FILE, JSON.stringify(l, null, 2)); }
export function loadLinked(): Linked {
  if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf8"));
  return { source: "demo company (nothing linked yet)", linkedAt: "", input: DEMO_RUN };
}
