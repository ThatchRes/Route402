// Capital One Nessie (hackathon sandbox) connector. Nessie is a US-dollar banking simulator: customers, accounts,
// bills, deposits, withdrawals. It has NO currency field, so foreign-currency details (currency, amount, supplier bank
// details) live in a local metadata file keyed by the Nessie object id. Nessie writes never move real money.
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.NESSIE_BASE_URL ?? "https://api.nessieisreal.com";
const KEY = () => { const k = process.env.NESSIE_API_KEY; if (!k) throw new Error("Set NESSIE_API_KEY in .env"); return k; };
const META = "data/nessie-meta.json";

async function req(method: string, path: string, body?: any) {
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(KEY())}`;
  const r = await fetch(url, { method, headers: { "content-type": "application/json", accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j: any; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
  if (!r.ok) throw new Error(`Nessie ${method} ${path} -> ${r.status}: ${typeof j === "string" ? j.slice(0, 200) : JSON.stringify(j).slice(0, 200)}`);
  return j?.objectCreated ?? j;                       // POSTs return {code, message, objectCreated}
}

export const nessie = {
  customers: () => req("GET", "/customers"),
  customer: (id: string) => req("GET", `/customers/${id}`),
  createCustomer: (c: any) => req("POST", "/customers", c),
  accounts: (customerId: string) => req("GET", `/customers/${customerId}/accounts`),
  createAccount: (customerId: string, a: any) => req("POST", `/customers/${customerId}/accounts`, a),
  bills: (accountId: string) => req("GET", `/accounts/${accountId}/bills`),
  createBill: (accountId: string, b: any) => req("POST", `/accounts/${accountId}/bills`, b),
  deposits: (accountId: string) => req("GET", `/accounts/${accountId}/deposits`),
  createDeposit: (accountId: string, d: any) => req("POST", `/accounts/${accountId}/deposits`, d),
  createWithdrawal: (accountId: string, w: any) => req("POST", `/accounts/${accountId}/withdrawals`, w),
};

export type Meta = Record<string, any>;
export function loadMeta(): Meta { return existsSync(META) ? JSON.parse(readFileSync(META, "utf8")) : {}; }
export function saveMeta(m: Meta) { mkdirSync("data", { recursive: true }); writeFileSync(META, JSON.stringify(m, null, 2)); }
