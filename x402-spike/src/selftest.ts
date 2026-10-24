// Offline checks of the refuse-before-signing rules. No network, no keys, no money.
import assert from "node:assert/strict";
import { checkRequirements, canStartAttempt, withinCap } from "./policy.js";
import type { Attempt } from "./store.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYTO = "0x1111111111111111111111111111111111111111";
const exp = { network: "eip155:84532", asset: USDC, amountAtomic: 10000n, payTo: PAYTO, maxTimeoutSeconds: 300 };
const good = { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "10000", payTo: PAYTO, maxTimeoutSeconds: 120 };
const t = (name: string, fn: () => void) => { fn(); console.log("PASS", name); };

t("accepts exact approved terms", () => assert.equal(checkRequirements([good], exp).ok, true));
t("rejects mainnet", () => assert.equal(checkRequirements([{ ...good, network: "eip155:8453" }], exp).ok, false));
t("rejects other token, same ticker", () => assert.equal(checkRequirements([{ ...good, asset: "0x2222222222222222222222222222222222222222" }], exp).ok, false));
t("rejects larger amount", () => assert.equal(checkRequirements([{ ...good, amount: "10001" }], exp).ok, false));
t("rejects other receiver", () => assert.equal(checkRequirements([{ ...good, payTo: "0x3333333333333333333333333333333333333333" }], exp).ok, false));
t("rejects long authorization", () => assert.equal(checkRequirements([{ ...good, maxTimeoutSeconds: 86400 }], exp).ok, false));
t("rejects non-exact scheme", () => assert.equal(checkRequirements([{ ...good, scheme: "upto" }], exp).ok, false));

const at = (status: Attempt["status"], orderId = "o1"): Attempt =>
  ({ attemptId: Math.random().toString(), orderId, payer: PAYTO, amountAtomic: "10000", status, startedAt: "" });
t("blocks second payment after settle", () => assert.equal(canStartAttempt([at("SETTLED")], "o1").ok, false));
t("blocks new payment while UNKNOWN", () => assert.equal(canStartAttempt([at("UNKNOWN")], "o1").ok, false));
t("allows retry after reconciled-not-settled", () => assert.equal(canStartAttempt([at("RECONCILED_NOT_SETTLED")], "o1").ok, true));
t("other orders unaffected", () => assert.equal(canStartAttempt([at("SETTLED", "o2")], "o1").ok, true));
t("cap counts unknown spend", () => assert.equal(withinCap([at("SETTLED"), at("UNKNOWN"), at("SETTLED"), at("SETTLED")], 10000n, 50000n), true));
t("cap blocks overflow", () => assert.equal(withinCap([at("SETTLED"), at("UNKNOWN"), at("SETTLED"), at("SETTLED"), at("SETTLED")], 10000n, 50000n), false));
console.log("all policy checks passed");
