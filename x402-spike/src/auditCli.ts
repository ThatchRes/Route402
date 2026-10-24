// npm run audit            -> every order   |   npm run audit -- <orderId>
import { load } from "./store.js";
import { auditOrder } from "./audit.js";
const ids = process.argv[2] ? [process.argv[2]] : Object.keys(load().orders);
for (const id of ids) {
  const r = await auditOrder(id);
  if (!r) { console.log(`${id}: not found`); continue; }
  console.log(`\n${id} (${r.transferId}) order=${r.orderStatus} -> ${r.outcome}`);
  for (const l of r.legs) console.log(`  ${l.status.padEnd(21)} ${l.leg.padEnd(18)} expected ${l.expected} | observed ${l.observed}`);
}
