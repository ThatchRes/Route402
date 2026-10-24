// npm run demo:reset          clear transfers, payouts and linked data for a clean pitch
// npm run demo:reset -- --all  also forget the Nessie id mapping (re-run `npm run import -- nessie seed`)
// x402-spike data is never touched: it holds real testnet evidence.
import { existsSync, rmSync } from "node:fs";
const files = ["data/router.json", "data/store.json", "data/linked.json", "data/executed.json", ...(process.argv.includes("--all") ? ["data/nessie-meta.json"] : [])];
for (const f of files) if (existsSync(f)) { rmSync(f); console.log(`cleared ${f}`); }
console.log("restart `npm run server` and `npm run router` before the demo");
