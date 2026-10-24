import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
const FILE = "data/router.json";
export interface RDb { intents: Record<string, any>; transfers: Record<string, any>; jobs: Record<string, any>;
  observations: any[]; idem: Record<string, string>; reservedUsdMinor: string; spentUsdMinor?: string }
export function load(): RDb {
  if (!existsSync(FILE)) return { intents: {}, transfers: {}, jobs: {}, observations: [], idem: {}, reservedUsdMinor: "0" };
  return JSON.parse(readFileSync(FILE, "utf8"));
}
export function save(db: RDb) {
  mkdirSync("data", { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  for (let i = 0; ; i++) { try { renameSync(tmp, FILE); return; } catch (e: any) {
    if (!["EPERM", "EBUSY", "EACCES"].includes(e?.code) || i >= 20) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } }
}
export function update<T>(fn: (db: RDb) => T): T { const db = load(); const out = fn(db); save(db); return out; }
