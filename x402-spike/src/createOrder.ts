// Stand-in for Person A's backend creating a funding order after plan approval.
// Usage: npm run order -- <transferId> [planVersion] [termsHash]
import { SELLER_URL, INTERNAL_TOKEN } from "./config.js";
const [transferId = "tr_demo_1", planVersion = "1", termsHash = "demo-terms-hash"] = process.argv.slice(2);
const orderId = `fund_${transferId}_v${planVersion}`;
const res = await fetch(`${SELLER_URL}/orders`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${INTERNAL_TOKEN()}` },
  body: JSON.stringify({ orderId, transferId, planVersion: Number(planVersion), termsHash }),
});
console.log(res.status, JSON.stringify(await res.json(), null, 2));
console.log(`next: npm run pay -- ${orderId}`);
