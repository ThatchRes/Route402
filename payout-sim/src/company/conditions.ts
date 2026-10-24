// A payment condition written down as data, not as code in one rail. Today Route402 enforces it (money is not sent until
// the condition is met). On a tokenized-deposit network the same record can be handed to the ledger, which locks the
// funds and releases them when the evidence arrives (the UK GBTD pilot locked a buyer's money until goods changed hands).
// The fields answer the four questions banks say conditional payments need rules for: who sets the condition, how it is
// proven, who can halt it, and what happens in a dispute or if it never happens.
export type ConditionKind = "delivery_confirmed";
export type Enforcement = "route402_before_send" | "ledger_lock_and_release";

export interface ConditionSpec {
  version: 1;
  kind: ConditionKind;
  setBy: { userId: string; role: string; at: string };                     // who set it
  proof: { evidence: "bill_of_lading" | "goods_receipt"; confirmerRoles: string[]; notThePreparer: true }; // how it is proven
  haltableBy: string[];                                                    // roles that can stop it before release
  ifNotMet: { action: "keep_with_payer"; reviewAfterDays: number };        // nothing leaves the payer's account until met
  dispute: string;                                                         // where a disagreement goes
  enforcement: Enforcement;                                                // who enforces it today
  met?: { by: string; at: string; documentRef: string };
}

export function deliveryCondition(userId: string, role: string): ConditionSpec {
  return {
    version: 1, kind: "delivery_confirmed",
    setBy: { userId, role, at: new Date().toISOString() },
    proof: { evidence: "bill_of_lading", confirmerRoles: ["receiving", "approver", "admin"], notThePreparer: true },
    haltableBy: ["approver", "admin"],
    ifNotMet: { action: "keep_with_payer", reviewAfterDays: 30 },
    dispute: "goes back to the approvers; the funds have not left the company's account",
    enforcement: "route402_before_send",
  };
}

/** How the same condition would be enforced on a given rail. */
export function enforcementOn(rail: "bank_wire" | "stablecoin_usdc" | "tokenized_deposit"): { enforcement: Enforcement; how: string } {
  return rail === "tokenized_deposit"
    ? { enforcement: "ledger_lock_and_release", how: "the ledger locks the funds at approval and releases them when the evidence is recorded" }
    : { enforcement: "route402_before_send", how: "Route402 holds the instruction and sends it only after the evidence is recorded" };
}
