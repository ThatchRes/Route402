// Programmable treasury rules (our own rule format, inspired by programmable-money platforms).
// A rule = trigger + action + limits. Evaluation is deterministic and side-effect free: it returns PROPOSED actions,
// each either within a pre-approved mandate or needing approval. Execution goes through the router's
// plan -> approval -> execute path, never directly from a rule.
import { optimize } from "../router/optimizer.js";
import { fmt, toMinor, toMinorSigned } from "../money.js";

export type Trigger =
  | { kind: "balance_above"; account: string; threshold: string }
  | { kind: "balance_below"; account: string; threshold: string }
  | { kind: "invoice_approved"; dueWithinDays: number }
  | { kind: "conversion_window"; src: string; dest: string; amount: string; notBeforeUtc: string; mustExecuteByUtc: string; minRecipient?: string }
  | { kind: "conditional_release"; invoiceId: string; requires: string[]; expiresUtc: string };
export type Action =
  | { kind: "sweep_excess"; to: string; keep: string }
  | { kind: "top_up"; from: string; upTo: string }
  | { kind: "pay_invoice"; objective?: "balanced" | "cheapest" | "fastest" }
  | { kind: "convert" }
  | { kind: "release_escrow" };
export interface Rule { id: string; description: string; trigger: Trigger; action: Action;
  limits: { mandateMax: string; ccy: string; dailyLimit?: string } }

export interface State {
  nowUtc: string;
  balances: Record<string, { ccy: string; amount: string }>;
  invoices: { id: string; payeeCcy: string; payerCcy: string; amount: string; dueUtc: string; approved: boolean }[];
  events: Record<string, string[]>;          // invoiceId -> confirmed conditions, e.g. ["delivery_confirmed"]
  executedToday: Record<string, string>;      // ruleId -> amount already executed today (same ccy as limits)
}

export function evaluate(rules: Rule[], st: State) {
  const now = new Date(st.nowUtc), out: any[] = [];
  const decide = (r: Rule, amount: bigint, base: any) => {
    const max = toMinor(r.limits.mandateMax, r.limits.ccy), used = toMinor(st.executedToday[r.id] ?? "0", r.limits.ccy);
    const daily = r.limits.dailyLimit ? toMinor(r.limits.dailyLimit, r.limits.ccy) : null;
    const status = daily !== null && used + amount > daily ? "needs_approval (daily limit)" : amount > max ? "needs_approval (above mandate)" : "within_mandate";
    out.push({ rule: r.id, ...base, amount: fmt(amount, r.limits.ccy), status, idempotencyKey: `${r.id}:${st.nowUtc.slice(0, 10)}:${base.ref ?? ""}` });
  };
  for (const r of rules) {
    const t = r.trigger, a = r.action;
    if (t.kind === "balance_above" && a.kind === "sweep_excess") {
      const b = st.balances[t.account]; if (!b) continue;
      const bal = toMinorSigned(b.amount, b.ccy), keep = toMinor(a.keep, b.ccy);
      if (bal > toMinor(t.threshold, b.ccy) && bal > keep) decide(r, bal - keep, { action: `sweep ${t.account} -> ${a.to}`, ref: t.account });
    } else if (t.kind === "balance_below" && a.kind === "top_up") {
      const b = st.balances[t.account]; if (!b) continue;
      const bal = toMinorSigned(b.amount, b.ccy), upTo = toMinor(a.upTo, b.ccy);
      if (bal < toMinor(t.threshold, b.ccy)) decide(r, upTo - bal, { action: `top up ${t.account} from ${a.from}`, ref: t.account });
    } else if (t.kind === "invoice_approved" && a.kind === "pay_invoice") {
      for (const inv of st.invoices.filter((i) => i.approved && (Date.parse(i.dueUtc) - now.getTime()) / 86400e3 <= t.dueWithinDays)) {
        const q: any = optimize({ srcCcy: inv.payerCcy, destCcy: inv.payeeCcy, amountType: "RECIPIENT_FIXED", amount: inv.amount,
          deadlineUtc: inv.dueUtc, objective: a.objective ?? "balanced", nowUtc: st.nowUtc });
        if (q.status !== "OK") { out.push({ rule: r.id, action: `pay ${inv.id}`, status: "held", reason: q.reason ?? q.missing }); continue; }
        decide(r, toMinor(q.totals.sourceDebit.split(" ")[0], inv.payerCcy), { action: `pay ${inv.id} (${inv.amount} ${inv.payeeCcy}) via ${q.allocations.map((x: any) => x.routeId).join("+")}`,
          arrives: q.totals.arrivalUtc, saves: q.value.customerNetSaving, ref: inv.id });
      }
    } else if (t.kind === "conversion_window" && a.kind === "convert") {
      // Bounded mandate: convert at the best executable quote inside the window; at the deadline convert regardless.
      // It never extends the window or holds currency hoping for a better rate afterwards.
      if (now < new Date(t.notBeforeUtc)) { out.push({ rule: r.id, action: "convert", status: "waiting (window not open)" }); continue; }
      const q: any = optimize({ srcCcy: t.src, destCcy: t.dest, amountType: "SOURCE_FIXED", amount: t.amount, objective: "cheapest", nowUtc: st.nowUtc });
      if (q.status !== "OK") { out.push({ rule: r.id, action: "convert", status: "held", reason: q.reason ?? q.missing }); continue; }
      const got = toMinor(q.totals.recipientNet.split(" ")[0], t.dest), atDeadline = now >= new Date(t.mustExecuteByUtc);
      const ok = !t.minRecipient || got >= toMinor(t.minRecipient, t.dest);
      if (ok || atDeadline) decide(r, toMinor(t.amount, t.src), { action: `convert ${t.amount} ${t.src} -> ${q.totals.recipientNet}${!ok ? " (deadline reached: executing at best available)" : ""}`, ref: `${t.src}${t.dest}` });
      else out.push({ rule: r.id, action: "convert", status: `waiting: best quote ${q.totals.recipientNet} below floor ${t.minRecipient} ${t.dest}; must execute by ${t.mustExecuteByUtc}` });
    } else if (t.kind === "conditional_release" && a.kind === "release_escrow") {
      const have = st.events[t.invoiceId] ?? [], missing = t.requires.filter((c) => !have.includes(c));
      const inv = st.invoices.find((i) => i.id === t.invoiceId);
      if (!inv) continue;
      if (!missing.length) decide(r, toMinor(inv.amount, r.limits.ccy), { action: `release escrowed payment for ${t.invoiceId}: all conditions met (${t.requires.join(", ")})`, ref: t.invoiceId });
      else if (now > new Date(t.expiresUtc)) out.push({ rule: r.id, action: `return escrow for ${t.invoiceId} to payer`, status: "needs_approval (conditions expired)", missing });
      else out.push({ rule: r.id, action: `hold escrow for ${t.invoiceId}`, status: "held", missing });
    }
  }
  return { advisoryOnly: true, evaluatedAtUtc: st.nowUtc, proposals: out,
    notes: ["within_mandate actions still execute through plan -> approval(mandate) -> execute with the idempotency key shown",
            "conversion windows are bounded: best quote inside the window, forced at the deadline, never held beyond it"] };
}
