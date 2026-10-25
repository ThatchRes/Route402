// Transaction monitoring at the moment a payment request is prepared. Rules flag patterns that call for a second look
// (new payee or country, changed bank details, many payments to one supplier, amounts just under a control threshold).
// An alert never moves or blocks money by itself: it goes with the request to the approver, who must acknowledge review alerts,
// and to the Activity page. Suspicious-activity reports are filed by the licensed partner of record, not by Route402.
import type { PaymentRequest, Policy, User } from "./controls.js";
import { compliancePolicy } from "../router/compliance.js";

// "info" alerts are shown to the approver; "review" alerts must be acknowledged on the approval screen before approving.
export interface Alert { rule: "new_payee" | "new_country" | "details_changed" | "velocity" | "near_threshold"; severity: "info" | "review"; detail: string }
const DAY = 24 * 3600e3;

export function monitorRequest(r: PaymentRequest, prior: PaymentRequest[], p: Policy, users: User[], now = Date.now()): Alert[] {
  const out: Alert[] = [], others = prior.filter((x) => x.id !== r.id);
  if (!others.some((x) => x.supplier === r.supplier)) out.push({ rule: "new_payee", severity: "info", detail: `first payment to ${r.supplier}` });
  else if (r.country !== "-" && !others.some((x) => x.country === r.country)) out.push({ rule: "new_country", severity: "info", detail: `first payment to a supplier in ${r.country}` });
  if (r.detailsChanged) out.push({ rule: "details_changed", severity: "review", detail: "the supplier's bank details changed recently: confirm them on a number already on file" });
  const recent = others.filter((x) => x.supplier === r.supplier && now - Date.parse(x.preparedAt) < 7 * DAY && x.status !== "REJECTED");
  if (recent.length >= 2) out.push({ rule: "velocity", severity: "review", detail: `${recent.length + 1} payments to ${r.supplier} in 7 days (${(recent.reduce((s, x) => s + x.debitUsd, 0) + r.debitUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })} USD)` });
  // Within 10% under a threshold that would otherwise add a control (Travel Rule record on a stablecoin route, an approver's limit)
  const near = (limit: number) => r.debitUsd < limit && r.debitUsd >= limit * 0.9;
  const tr = compliancePolicy(p).travelRuleThresholdUsd;
  if (r.route.includes("coin:") && tr > 0 && near(tr)) out.push({ rule: "near_threshold", severity: "review", detail: `${r.debitUsd.toLocaleString()} USD is just under the ${tr.toLocaleString()} USD Travel Rule threshold` });
  for (const lim of new Set(users.map((u) => u.approvalLimitUsd).filter((l): l is number => !!l)))
    if (near(lim)) out.push({ rule: "near_threshold", severity: "review", detail: `${r.debitUsd.toLocaleString()} USD is just under an approver limit of ${lim.toLocaleString()} USD` });
  return out;
}
