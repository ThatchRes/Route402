import { load } from "./store.js";
const db = load();
console.table(Object.values(db.orders).map((o) => ({ orderId: o.orderId, status: o.status, tx: o.settlement?.transaction ?? "", conf: o.confirmations ?? "" })));
console.table(db.attempts.map((a) => ({ attempt: a.attemptId.slice(0, 8), orderId: a.orderId, status: a.status, tx: a.transaction ?? "" })));
