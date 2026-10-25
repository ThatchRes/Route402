// Route402 screens from Figma (file BlpW1Rd2LOvETHS98ss2y5): Recipients 58:3326 (#/suppliers), Manual payment 58:3505
// (#/payments/new), Review & approve 58:3670 (#/payments/review and requests awaiting call-back/approval) and Payment
// tracking 58:3832 (#/payments/:id after approval). Presentation only: every figure comes from the router's own quotes,
// payment requests, transfers and audit log, and every action goes through the existing endpoints and controls.

// ------------------------------------------------------------------ shared document primitives
const IC = (name, w, h = w, cls = "") => `<img class="${cls}" src="assets/${name}.svg" width="${w}" height="${h}" alt="" />`;
const dUtc = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "-");
const dUtcY = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "-");
const tUtc = (iso) => (iso ? `${dUtc(iso)} · ${utc(iso)}` : "-");
const badge = (text, kind = "") => `<span class="badge ${kind}">${esc(text)}</span>`;
const reqBadgeKind = (s) => (s === "COMPLETED" ? "" : ["FAILED", "REJECTED"].includes(s) ? "bad" : "warn");
const detail = (k, v, sub = "") => `<div class="detail"><span>${esc(k)}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
const drow = (k, v) => `<div class="drow"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
const notice = (html, kind = "") => `<div class="notice2 ${kind}">${IC(kind === "warn" ? "clock-warn" : "info", 16)}<p>${html}</p></div>`;
const docIntro = (title, sub, right = "") => `<section class="doc-intro"><div class="intro-text"><h1>${esc(title)}</h1><p class="lede">${esc(sub)}</p></div>${right}</section>`;
const shortName = (n) => String(n ?? "").replace(/\s+(GmbH|AG|SA|Ltd|Inc\.?|Co|LLC|S\.A\.|SAS|BV|Pte)\.?$/i, "");
const refLabel = (r) => (String(r.payable).startsWith("chat_") ? "Chat payment" : r.payable);
const supplierFor = (id) => STATE?.suppliers?.find((s) => s.id === id || s.billIds.includes(id));
const supplierByName = (name) => STATE?.suppliers?.find((s) => s.name === name);
// Footer note shared with the Agent home: states the router's real mode, never a made-up one
function workspaceNote() {
  if (!STATE) return "Route402 · demo";
  return STATE.localSimulation ? `Local simulation · ${STATE.connected ? "Linked company data" : "Demo company data"} · Simulated quotes and payouts · No x402 spending`
    : `Testnet demo · ${STATE.connected ? "Connected to Capital One" : "Demo company data"} · Testnet money only · Supplier payouts simulated`;
}
const docPage = (P, html) => { P.innerHTML = `<div class="doc">${html}<p class="app-note">${esc(workspaceNote())}</p></div>`; };
function download(name, text, type) {   // client-side export of data already on screen
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}
const csv = (rows) => rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
const ack = (id, text) => `<label class="ack"><input type="checkbox" id="${id}" /><span class="box" aria-hidden="true">${IC("check-white-12", 12)}</span><span>${esc(text)}</span></label>`;

// Terms of a stored quote (/ui/quotes): the exact intent the request is bound to
const quoteTerms = (id) => (id ? api(`/quotes/${encodeURIComponent(id)}`).catch(() => null) : Promise.resolve(null));
function termsOf(q) {
  const src = String(q.sourceDebit).split(" ")[1], dest = q.recipient.ccy, sum = (k) => q.legs.reduce((a, l) => a + num(l[k]), 0);
  const fundedCcy = String(q.legs[0].funded).split(" ")[1], payout = sum("payoutFee");
  return { src, dest, transferFee: `${fmt(sum("fundingFee"))} ${src}`, payoutFee: payout ? `${fmt(payout)} ${dest}` : null,
    principal: `${fmt(sum("funded"))} ${fundedCcy}`, fundedCcy, rate: q.legs.map((l) => fxFmt(l.fxRate)).join(" / "),
    converts: !(fundedCcy === dest && q.legs.every((l) => Number(l.fxRate) === 1)) };
}
const feesLine = (T) => [T.transferFee, T.payoutFee].filter(Boolean).join(" + ");
// Route402's own fee is not part of the transfer debit: it is shown on its own line wherever the amount is approved or reported
const feeText = (fee) => (fee == null ? null : num(fee) > 0 ? `${money(fee)}, charged separately` : "None on this payment");
const feeRow = (fee, rule) => (fee == null ? "" : `${drow("Route402 fee", feeText(fee))}${rule ? `<p class="note10">Route402 fee: ${esc(rule)}.</p>` : ""}`);
// Transaction-monitoring alerts raised when the request was prepared (company/monitoring.ts)
const reviewAlerts = (r) => (r.alerts ?? []).filter((a) => a.severity === "review");
function alertsBlock(r) {
  if (!r.alerts?.length) return "";
  return `<div class="divider"></div><div class="breakdown"><h3>Monitoring alerts</h3>
    <ul class="doc-checks">${r.alerts.map((a) => `<li class="${a.severity === "review" ? "warn" : "ok"}"><b>${a.severity === "review" ? "!" : "i"} ${esc(a.severity === "review" ? "Review" : "Note")}</b><span>${esc(a.detail)}</span></li>`).join("")}</ul>
    <p class="note10">${r.alertsReviewed ? `Reviewed by ${esc(nameOf(r.alertsReviewed.by))} · ${esc(tUtc(r.alertsReviewed.at))}.` : reviewAlerts(r).length ? "The approver must acknowledge these before approving." : "For the approver's information."}</p></div>`;
}
const fxFmt = (r) => Number(r).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 });
// One masked-account format across screens: the supplier directory's, falling back to the quote's
const maskedFor = (name, fallback) => supplierByName(name)?.maskedAccount ?? fallback ?? "—";

// ================================================================== RECIPIENTS (Figma 58:3326) — existing supplier directory
let SUP = { q: "", filter: "all", ccy: "", tools: false };
const supStatus = (s) => (s.check === "OK" ? ["Active", ""] : s.check === "BLOCK" ? ["Receiving details needed", "warn"] : ["Details to review", "warn"]);
const supRequests = (s) => REQS.filter((r) => s.billIds.includes(r.payable) || r.supplier === s.name).sort((a, b) => b.preparedAt.localeCompare(a.preparedAt));
function supContext(s) {
  const r = supRequests(s)[0];
  if (r) return [`${refLabel(r)} · ${usd(r.debitUsd, 2)}`, `${statusText(r.status)} · ${dUtc(r.preparedAt)}`, reqBadgeKind(r.status)];
  const b = s.bills.find((x) => !reqFor(x.id));
  if (b) return [`${b.id} · ${money(`${b.amount} ${b.currency}`, 0)}`, s.check === "BLOCK" ? "Blocked · details needed" : `Ready · due ${dUtc(b.dueUtc)}`, s.check === "BLOCK" ? "warn" : ""];
  return ["No open invoices", "—", ""];
}
function pageSupplier(P, id) { try { id = decodeURIComponent(id); } catch {} return pageSuppliers(P, id); }   // supplier ids can be names with spaces
function pageSuppliers(P, id) {
  const all = STATE.suppliers ?? [], ccys = [...new Set(all.flatMap((s) => s.currencies))].sort();
  const counts = { all: all.length, active: all.filter((s) => s.check === "OK").length, needs: all.filter((s) => s.check !== "OK").length };
  const q = SUP.q.toLowerCase();
  const list = all.filter((s) => (SUP.filter === "all" || (SUP.filter === "active" ? s.check === "OK" : s.check !== "OK"))
    && (!SUP.ccy || s.currencies.includes(SUP.ccy))
    && (!q || `${s.name} ${COUNTRY[s.country] ?? s.country} ${s.country} ${s.currencies.join(" ")} ${s.billIds.join(" ")}`.toLowerCase().includes(q)));
  const sel = (id && supplierFor(id)) || list[0] || all[0];
  setCrumbs("Suppliers", sel?.name);
  const blocked = all.find((s) => s.check === "BLOCK" && s.billIds.length);
  const rows = list.map((s) => { const [st, kind] = supStatus(s), [c1, c2, ck] = supContext(s), on = s === sel;
    return `<a class="rec ${on ? "on" : ""}" href="#/suppliers/${encodeURIComponent(s.id)}" ${on ? 'aria-current="true"' : ""}>
      <span class="mono2">${esc(initials(s.name))}</span>
      <span class="rec-id"><b>${esc(s.name)}</b><small>${esc(COUNTRY[s.country] ?? s.country)} · ${esc(s.currencies.join(", "))}   /   <span class="${kind}">${esc(st)}</span></small></span>
      <span class="rec-ctx"><span>${esc(c1)}</span><small class="${ck}">${esc(c2)}</small></span>
      ${IC(on ? "chevron-right-accent" : "chevron-right", 14)}</a>`; }).join("");
  const tab = (k, label) => `<button class="${SUP.filter === k ? "on" : ""}" data-sf="${k}">${label}  ${counts[k]}</button>`;
  docPage(P, `${docIntro("Suppliers", "Your suppliers, receiving details and shared payment history.", `<button class="btn-solid" id="sup-add">Add supplier ${IC("plus-white", 15)}</button>`)}
    <div class="doc-cols g32">
      <section class="doc-main g18" aria-label="Supplier directory">
        <div class="tabs2">${tab("all", "All suppliers")}${tab("active", "Active")}${tab("needs", "Needs details")}</div>
        <div class="search2">${IC("search", 16)}<input id="sup-q" type="search" placeholder="Search supplier, country or invoice" value="${esc(SUP.q)}" aria-label="Search suppliers" />
          <button class="icon-btn2 ${SUP.tools || SUP.ccy ? "on" : ""}" id="sup-tools" aria-label="Filter by currency" aria-expanded="${SUP.tools}">${IC("sliders-horizontal", 15)}</button></div>
        ${SUP.tools || SUP.ccy ? `<div class="chips">${["", ...ccys].map((c) => `<button data-sc="${c}" class="${SUP.ccy === c ? "on" : ""}">${c || "All currencies"}</button>`).join("")}</div>` : ""}
        <div class="recs"><div class="recs-head"><span>SUPPLIER / RECEIVING SETUP</span><span>PAYMENT CONTEXT</span></div>
          ${rows || `<p class="empty2">No suppliers match ${SUP.q ? `“${esc(SUP.q)}”` : "these filters"}.</p>`}</div>
        <p class="note10">Receiving checks are separate from payment status. They cover format and checksums, not bank ownership.</p>
        ${blocked ? notice(`${esc(blocked.name)} needs receiving details before quoting. ${esc(blocked.billIds.join(", "))} stays unpaid; updating details does not approve a payment.`, "warn") : ""}
        <div class="recs-foot"><span>${all.length} saved supplier${all.length === 1 ? "" : "s"}${list.length !== all.length ? ` · ${list.length} shown` : ""}</span><button class="text-btn" id="sup-export">Export directory ↓</button></div>
      </section>
      ${sel ? supplierPanel(sel) : `<aside class="doc-aside w386"><p class="note10">No suppliers yet. Add one in chat.</p></aside>`}
    </div>`);
  $$("[data-sf]").forEach((b) => b.onclick = () => { SUP.filter = b.dataset.sf; pageSuppliers(P, id); });
  $$("[data-sc]").forEach((b) => b.onclick = () => { SUP.ccy = b.dataset.sc; pageSuppliers(P, id); });
  $("#sup-tools").onclick = () => { SUP.tools = !SUP.tools; if (!SUP.tools) SUP.ccy = ""; pageSuppliers(P, id); };
  const input = $("#sup-q"); input.oninput = () => { SUP.q = input.value; const pos = input.selectionStart; pageSuppliers(P, id); const el = $("#sup-q"); el.focus(); el.setSelectionRange(pos, pos); };
  $("#sup-add").onclick = () => { CHAT_INPUT = "Add a supplier"; location.hash = "#/chat"; };
  $("#sup-export").onclick = () => download(`route402-suppliers-${new Date().toISOString().slice(0, 10)}.csv`, csv([["Supplier", "Country", "Currencies", "Receiving setup", "Account", "Linked invoices", "Payment context"],
    ...list.map((s) => [s.name, COUNTRY[s.country] ?? s.country, s.currencies.join(" "), supStatus(s)[0], s.maskedAccount, s.billIds.join(" "), supContext(s).slice(0, 2).join(" · ")])]), "text/csv");
  $("#sup-manage")?.addEventListener("click", () => $("#open-connect").click());
  $("#sup-new")?.addEventListener("click", (e) => { const s = sel, bill = s.bills.find((b) => !reqFor(b.id) && s.check !== "BLOCK");
    if (bill) location.hash = `#/payments/new?bill=${encodeURIComponent(bill.id)}`; else { CHAT_INPUT = `Send an amount to ${s.name}`; location.hash = "#/chat"; } e.preventDefault(); });
}
function supplierPanel(s) {
  const [st, kind] = supStatus(s), reqs = supRequests(s).slice(0, 3);
  const pay = (r) => { const tr = STATE.transfers.find((t) => t.transferId === r.transferId);
    return `<div class="pay2"><div class="pay2-head"><b>${esc(refLabel(r))}</b>${badge(statusText(r.status), reqBadgeKind(r.status))}</div>
      <p>${usd(r.debitUsd, 2)} → ${r.status === "COMPLETED" ? "" : "expected "}${money(tr?.credit ?? r.recipientGets)}</p>
      <small>${esc(r.id)} · ${esc(tUtc(r.preparedAt))}</small><a class="text-btn" href="#/payments/${esc(r.id)}">Track payment →</a></div>`; };
  const startable = s.check !== "BLOCK" && s.bills.some((b) => !reqFor(b.id));
  return `<aside class="doc-aside w386 g17" aria-label="Selected supplier">
    <div class="aside-head"><span class="eyebrow">SELECTED SUPPLIER</span><details class="menu"><summary aria-label="More actions">${IC("more-horizontal-17", 17)}</summary>
      <div class="menu-pop"><a href="#/payments">All payments</a><button type="button" id="sup-ask">Ask the agent about ${esc(shortName(s.name))}</button></div></details></div>
    <h2 class="serif28">${esc(s.name)}</h2>
    <div class="meta2">${badge(st, kind)}<span>${esc(COUNTRY[s.country] ?? s.country)} · ${esc(s.currencies.join(", "))}</span></div>
    ${s.billIds.length ? `<p class="t12">${s.billIds.length} linked invoice${s.billIds.length === 1 ? "" : "s"}: ${esc(s.billIds.join(", "))}</p>` : `<p class="t12">Saved supplier · no linked invoices</p>`}
    ${s.issues.length ? `<ul class="issues">${s.issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}
    <div class="divider"></div>
    ${detail("Receiving details", `${esc(s.currencies[0])} · ${s.acceptsUsdc ? "Bank account or USDC wallet" : "Bank account"} · ${esc(s.maskedAccount)}`)}
    <button class="text-btn" id="sup-manage">Update via accounting import →</button>
    <p class="note10">Format and checksum checks only, not bank verification. Changed details need a call-back before approval.</p>
    <div class="divider"></div>
    <span class="eyebrow">PAYMENT HISTORY · ${esc((STATE.localSimulation ? "simulation" : "testnet").toUpperCase())}</span>
    ${reqs.length ? reqs.map(pay).join("") : `<p class="note11">No payment requests for this supplier yet.</p>`}
    <div class="divider"></div>
    <a class="btn-solid" id="sup-new" href="#">${startable ? `New payment to ${esc(shortName(s.name))}` : `Plan a payment to ${esc(shortName(s.name))}`} ${IC("arrow-up-right-white", 15)}</a>
  </aside>`;
}
document.addEventListener("click", (e) => { const a = e.target.closest("#sup-ask"); if (!a) return;
  const name = a.textContent.replace(/^Ask the agent about /, ""); CHAT_INPUT = `What do we owe ${name}?`; location.hash = "#/chat"; });

// ================================================================== MANUAL PAYMENT (Figma 58:3505) — existing create step
const quoteKey = (d) => `${d.billId}|${d.mode}|${d.budgetUsd}|${d.due}|${d.routingObjective ?? "balanced"}`;
function compareRouteOptions(a, b, objective = "balanced") {
  const arrival = String(a.arrivalUtc).localeCompare(String(b.arrivalUtc));
  const key = objective === "cheapest" ? "moneyCostMinor" : "combinedCostMinor";
  const score = a.selection?.[key] != null && b.selection?.[key] != null
    ? (BigInt(a.selection[key]) < BigInt(b.selection[key]) ? -1 : BigInt(a.selection[key]) > BigInt(b.selection[key]) ? 1 : 0)
    : a.economics.allInUsd - b.economics.allInUsd;
  return objective === "fastest" ? arrival || score : score || arrival;
}
const recRoute = (R) => (R?.routes ?? []).filter((r) => r.status === "OK").sort((a, b) => compareRouteOptions(a, b, DRAFT.routingObjective ?? "balanced"))[0];
async function loadDraftQuotes(P, q) {
  const d = DRAFT, b = billOf(d.billId);
  if (!b || !d.due || (d.mode === "budget" && !(d.budgetUsd > 0)) || d.key === quoteKey(d)) return;
  DRAFT = { ...d, key: quoteKey(d), routes: null, routesErr: null, agent: null, agentErr: null, selected: d.selected ?? null }; saveDraft();
  const qs = `?due=${encodeURIComponent(DRAFT.due)}&objective=${DRAFT.routingObjective ?? "balanced"}${DRAFT.mode === "budget" ? `&mode=budget&usd=${DRAFT.budgetUsd}` : ""}`;
  const requestKey = DRAFT.key;
  try { const routes = await api(`/routes/${encodeURIComponent(b.id)}${qs}`); if (DRAFT.key !== requestKey) return; DRAFT.routes = routes; }
  catch (e) { if (DRAFT.key !== requestKey) return; DRAFT.routesErr = e.message; }
  if (!DRAFT.routes?.routes?.some((r) => r.provider === DRAFT.selected && r.status === "OK")) DRAFT.selected = recRoute(DRAFT.routes)?.provider ?? null;
  saveDraft(); if (location.hash.startsWith("#/payments/new")) pageCreate(P, q);
}
function pageCreate(P, q) {
  const startable = STATE.bills.filter((b) => b.check !== "BLOCK" && (!reqFor(b.id) || b.id === DRAFT.billId) && b.paid?.status !== "COMPLETED");
  if (q.get("bill") && q.get("bill") !== DRAFT.billId) DRAFT = { billId: q.get("bill") };
  const d = DRAFT, b = billOf(d.billId), s = b && supplierFor(b.id);
  if (b && !d.due) d.due = b.dueUtc;
  if (!d.purpose) d.purpose = "Invoice payment";
  setCrumbs("Payments", "Manual request");
  const R = d.key === quoteKey(d) ? d.routes : null, ok = (R?.routes ?? []).filter((r) => r.status === "OK");
  const sel = ok.find((r) => r.provider === d.selected), rec = recRoute(R), budget = d.mode === "budget";
  const busy = d.agentBusy, err = d.formErr ?? {};
  const field = (k, label, control, hint = "") => `<div class="field3 ${err[k] ? "err" : ""}" id="ff-${k}"><div class="flabel"><label for="${k}">${esc(label)}</label>${hint ? `<span class="h">${esc(hint)}</span>` : ""}</div>${control}${err[k] ? `<span class="e">${esc(err[k])}</span>` : ""}</div>`;
  const sel3 = (id, opts, attrs = "") => `<div class="sel3">${`<select id="${id}" ${attrs}>${opts}</select>`}${IC("chevron-down", 14)}</div>`;
  // Each section is a field card: title and a short note above, the inputs, then a footer strip for context
  const card = (title, note, body, foot = "") => `<section class="fsec"><div class="fsec-head"><h3>${title}</h3>${note}</div>
    <div class="fbox"><div class="fbox-body">${body}</div>${foot ? `<div class="fbox-foot">${foot}</div>` : ""}</div></section>`;
  const routeName = (r) => RAIL[r.provider] ?? r.provider, arrival = (r) => (r.economics.transitDays < 0.05 ? "minutes · 24/7" : `${r.economics.transitDays.toFixed(1)} days`);
  const others = ok.filter((r) => r !== sel);
  const diff = (r) => { if (!sel) return ""; const dv = budget ? num(r.supplierGets) - num(sel.supplierGets) : r.economics.allInUsd - sel.economics.allInUsd;
    return budget ? `${fmt(Math.abs(dv))} ${b.ccy} ${dv < 0 ? "less" : "more"} for the supplier` : `${usd(Math.abs(dv), 2)} ${dv > 0 ? "more" : "less"} all-in`; };
  const x = sel?.breakdown, e = sel?.economics;
  docPage(P, `<div class="mp">${docIntro("Manual payment", "Enter the details yourself. The same review and approval comes next.", `<a class="text-btn t12" href="#/chat">Ask the agent instead ↗</a>`)}
  <div class="doc-cols">
    <form class="doc-main mp-form" id="mp-form" novalidate>
      <div class="draft-ref"><span class="eyebrow">${b ? esc(b.id) : "NEW PAYMENT REQUEST"}</span>${badge("Draft · Unsent")}</div>
      ${card("Who you’re paying", `<button type="button" class="text-btn" id="mp-add">+ Add supplier</button>`,
        `${field("bill", "Saved supplier and invoice", sel3("bill", `<option value="">Choose a saved supplier</option>${startable.map((x2) => `<option value="${esc(x2.id)}" ${x2.id === d.billId ? "selected" : ""}>${esc(x2.supplier)} · ${esc(x2.id)} · ${money(`${x2.amount} ${x2.ccy}`)}</option>`).join("")}`), "Saved suppliers only")}
        ${b ? `<div class="pair">${detail("Location / currency", `${esc(COUNTRY[b.country] ?? b.country)} · ${esc(b.ccy)}`)}${detail("Receiving account", esc(s?.maskedAccount ?? R?.bill?.maskedAccount ?? "—"))}</div>` : ""}`,
        b ? `<p class="note11">${esc(b.issues[0] ?? `Saved receiving details · ${b.check === "OK" ? "format checks passed" : "review required"}`)}${b.acceptsUsdc ? " · accepts USDC" : ""}</p>`
          : `<p class="note11">${startable.length} invoice${startable.length === 1 ? "" : "s"} ready to pay. Blocked suppliers and invoices that already have a request are not listed.</p>`)}
      ${card("How much", `<span class="fsec-note">Fees are always included in what you pay</span>`,
        `${field("source", "Pay from", sel3("source", `<option>${esc(R?.sourceAccount ?? (STATE.connected ? "Operating account (Capital One)" : "USD operating account (demo)"))}</option>`))}
        <div class="seg" role="radiogroup" aria-label="Amount"><label class="${budget ? "" : "on"}"><input type="radio" name="mode" value="invoice" ${budget ? "" : "checked"} />Pay the full invoice amount</label>
          <label class="${budget ? "on" : ""}"><input type="radio" name="mode" value="budget" ${budget ? "checked" : ""} />Set how much we send</label></div>
        <div class="pair">${field("usd", "You pay · USD", budget ? `<input id="usd" inputmode="decimal" placeholder="0.00" value="${esc(d.budgetUsd ?? "")}" />`
            : `<input id="usd" readonly value="${sel ? esc(fmt(num(sel.youPay))) : ""}" placeholder="${b ? "Calculated from the quote" : "—"}" aria-describedby="usd-h" />`, budget ? "You set this" : "From the quote")}
          ${field("ccy", "Recipient currency", sel3("ccy", b ? `<option>${esc(b.ccy)} · ${esc(new Intl.DisplayNames(["en"], { type: "currency" }).of(b.ccy) ?? b.ccy)}</option>` : "<option>—</option>"))}</div>`,
        `<p class="note11" id="usd-h">${budget ? "Fees come out of this amount; the supplier gets what is left, converted." : `The supplier gets ${b ? money(`${b.amount} ${b.ccy}`) : "the full invoice amount"}; what you pay already includes every fee.`} The currency must match the supplier’s saved bank account.</p>`)}
      ${card("Invoice &amp; deadline", `<span class="fsec-note">Only routes that arrive by this date are offered</span>`,
        `<div class="pair">${field("inv", "Invoice reference", `<input id="inv" readonly value="${esc(b?.id ?? "")}" placeholder="From the saved invoice" />`)}
          ${field("due", "Must arrive by", `<input id="due" type="date" value="${esc((d.due ?? "").slice(0, 10))}" />`, b ? `Invoice due ${dUtcY(b.dueUtc)}` : "")}</div>
        ${field("purpose", "Purpose", `<textarea id="purpose" rows="3" maxlength="120" placeholder="Write a note for your approvers…">${esc(d.purpose)}</textarea>`, "Shown to approvers · 120 characters")}`,
        "")}
      ${releaseCard(d, b, sel)}
      ${card("How the money travels", `<span class="eyebrow">${STATE.localSimulation ? "SIMULATED QUOTES" : "ROUTER QUOTES"}</span>`,
        !b ? `<p class="note11">Choose a saved supplier to see the available routes.</p>` : d.routesErr ? notice(esc(d.routesErr), "warn")
          : !R ? `<div class="routebox"><i class="skel-line"></i></div>` : !sel ? notice("No route can deliver this payment as requested. Try a later delivery date.", "warn")
          : `<div class="routebox">${IC("circle-dot", 18)}<div><b>${esc(routeName(sel))} · ${sel === rec ? "Recommended" : "Selected"}</b><span>${sel === rec ? "Lowest all-in cost within the requested delivery" : diff(rec).replace(/more|less/, (w) => (w === "more" ? "less" : "more")) + " than the recommended route"} · ${e.meetsDeadline ? `arrives ${dUtc(sel.arrivalUtc)}` : "may miss the requested date"} · ${sel.provider === "stablecoin" ? "supplier accepts USDC" : "saved receiving details"}</span></div></div>
            ${others.length ? `<p class="routes-alt">Change route: ${others.map((r) => `<button type="button" class="text-btn" data-pick="${r.provider}">${esc(routeName(r))} · ${money(budget ? r.supplierGets : r.youPay)}</button>`).join("  /  ")}</p>
              <p class="note10">${others.map((r) => `${esc(routeName(r))}: ${esc(diff(r))}, ${r.economics.meetsDeadline ? `arrives ${dUtc(r.arrivalUtc)}` : "may arrive late"}.`).join(" ")}</p>` : ""}
            ${R.routes.filter((r) => r.status !== "OK").map((r) => `<p class="note10">${esc(RAIL[r.provider] ?? r.provider)}: ${esc(r.reason ?? "not available")}</p>`).join("")}`,
        b && sel ? `<a class="text-btn" href="#/payments/compare">Compare every route in detail →</a>` : "")}
      <div class="mp-actions">
        <button type="button" class="btn-solid" id="go" ${busy ? "disabled" : ""}>${busy ? `<span class="spinner"></span>Checking quotes and supplier…` : `Continue to review ${IC("arrow-right-white", 15)}`}</button>
        <p class="note11">No money moves when you complete this form or select a route.</p>
      </div>
      ${d.agentErr ? `<p class="note11 bad">Agents unavailable: ${esc(d.agentErr)}</p>` : ""}
    </form>
    <aside class="doc-aside mp-summary" aria-label="Payment summary">
      <span class="eyebrow">PAYMENT SUMMARY</span>
      <div><p class="serif30">${sel ? (budget ? usd(d.budgetUsd, 2) : money(sel.youPay)) : "—"}</p><p class="note11">Total you pay, fees included</p></div>
      <div class="divider"></div>
      ${detail("To", esc(b?.supplier ?? "Choose a supplier"))}${b ? detail("Invoice", esc(b.id)) : ""}
      ${detail("Deadline", d.due ? esc(dUtcY(d.due)) : "—", b ? `Invoice due ${esc(dUtcY(b.dueUtc))}` : "")}
      ${sel ? `<div class="divider"></div>
        ${drow("Exchange rate", b.ccy === "USD" ? "No conversion" : `${Number(sel.fxRate).toFixed(4)} ${b.ccy} / USD`)}${drow("Exchange-rate cost", usd(x.conversionCostUsd, 2))}
        ${drow("Transfer fee", usd(x.transferFeeUsd, 2))}${x.payoutFeeUsd ? drow("Payout fee", usd(x.payoutFeeUsd, 2)) : ""}
        ${drow("Total fees included", usd(e.pricedUsd, 2))}${drow("Amount converted", usd(x.convertedPrincipalUsd, 2))}
        ${e.platformFeeUsd ? drow("Route402 fee", usd(e.platformFeeUsd, 2)) : ""}
        <div class="divider"></div>${detail(budget ? "Estimated recipient amount" : "Supplier receives", money(sel.supplierGets))}
        ${detail(`${routeName(sel)} · ${arrival(sel)}`, `Estimated arrival ${dUtc(sel.arrivalUtc)}`)}
        <p class="note10">Quote captured ${esc(tUtc(sel.capturedAt))}; expires ${esc(utc(sel.expiresAt))} (<span data-exp="${esc(sel.expiresAt)}">${leftText(sel.expiresAt)}</span>). Next, the agents buy a paid quote and screen the supplier; you review that exact quote.</p>` : ""}
      <p class="note10">No additional recipient deductions assumed. Actual quotes may differ. Format checks are not bank verification.</p>
    </aside>
  </div></div>`);
  const set = (patch) => { DRAFT = { ...DRAFT, ...patch, formErr: null }; saveDraft(); pageCreate(P, new URLSearchParams()); loadDraftQuotes(P, new URLSearchParams()); };
  $("#bill").onchange = () => { DRAFT = { billId: $("#bill").value, mode: DRAFT.mode, purpose: DRAFT.purpose, deliver: DRAFT.deliver, release: DRAFT.release, latestShipment: DRAFT.latestShipment, inspection: DRAFT.inspection }; set({}); };
  $$("[name=mode]").forEach((r) => r.onchange = () => set({ mode: r.value }));
  if (budget) $("#usd").onchange = () => set({ budgetUsd: Number($("#usd").value.replace(/,/g, "")) || undefined });
  $("#due").onchange = () => set({ due: $("#due").value ? new Date(`${$("#due").value}T20:00:00Z`).toISOString() : undefined });
  $("#purpose").onchange = () => { DRAFT.purpose = $("#purpose").value; saveDraft(); };
  $$("[name=release]").forEach((x2) => x2.onchange = () => { DRAFT.release = x2.value; DRAFT.deliver = x2.value === "delivery"; saveDraft(); pageCreate(P, new URLSearchParams()); });
  $("#ship-by")?.addEventListener("change", () => { DRAFT.latestShipment = $("#ship-by").value; saveDraft(); });
  $("#inspect")?.addEventListener("change", () => { DRAFT.inspection = $("#inspect").checked; saveDraft(); });
  $$("[data-pick]").forEach((x2) => x2.onclick = () => { DRAFT.selected = x2.dataset.pick; saveDraft(); pageCreate(P, new URLSearchParams()); });
  $("#mp-add").onclick = () => { CHAT_INPUT = "Add a supplier"; location.hash = "#/chat"; };
  $("#mp-form").onsubmit = (ev) => ev.preventDefault();
  $("#go").onclick = async () => {
    const errs = {};
    if (!DRAFT.billId) errs.bill = "Select a supplier to continue.";
    if (DRAFT.mode === "budget" && !(DRAFT.budgetUsd > 0)) errs.usd = "Enter an amount greater than 0.00 USD.";
    DRAFT.purpose = $("#purpose").value.trim(); if (!DRAFT.purpose) errs.purpose = "Purpose is required.";
    if (!DRAFT.due) errs.due = "Choose a requested delivery date.";
    if (DRAFT.release === "documents") {
      if (!DRAFT.latestShipment) errs.shipBy = "Enter the latest date the goods may be shipped.";
      else if (DRAFT.due && DRAFT.latestShipment > DRAFT.due.slice(0, 10)) errs.shipBy = "The latest shipment date must be on or before the payment deadline.";
    }
    if (Object.keys(errs).length) { DRAFT.formErr = errs; saveDraft(); return pageCreate(P, new URLSearchParams()); }
    if (!DRAFT.routes) return;
    // Same agent step as the compare page: paid quotes + supplier screen. Review always shows the agents' exact quote.
    if (!DRAFT.agent) await runAgents(P, () => pageCreate(P, new URLSearchParams()), "#/payments/new");
    if (!location.hash.startsWith("#/payments/new")) return;
    location.hash = chosenDecision() ? "#/payments/review" : "#/payments/compare";
  };
  loadDraftQuotes(P, q);
}

// When the approved money is released: on approval, after receiving confirms delivery, or when the shipping documents
// verify. The third replaces a letter of credit: same promise to the supplier, no bank examination fee or five-day wait.
function releaseCard(d, b, sel) {
  const mode = d.release ?? (d.deliver ? "delivery" : "now"), err = d.formErr ?? {};
  const opt = (v, label) => `<label class="${mode === v ? "on" : ""}"><input type="radio" name="release" value="${v}" ${mode === v ? "checked" : ""} />${label}</label>`;
  const debit = sel ? num(sel.youPay) : b ? num(b.amount) / Number(STATE.market?.mids?.[b.ccy]?.split(" ")[0] ?? 1) : 0;
  const lcFee = Math.round(debit * (POLICY.lcFeePct ?? 1)) / 100;
  const docsBody = mode !== "documents" ? "" : `<div class="pair"><div class="field3 ${err.shipBy ? "err" : ""}"><div class="flabel"><label for="ship-by">Latest shipment date</label><span class="h">Goods must be on board by</span></div>
      <input id="ship-by" type="date" value="${esc(d.latestShipment ?? "")}" />${err.shipBy ? `<span class="e">${esc(err.shipBy)}</span>` : ""}</div>
      <div class="field3"><div class="flabel"><label>Documents required</label><span class="h">Checked automatically</span></div>
      <p class="docs-list">✓ Electronic bill of lading, with title passed to you<br>✓ Commercial invoice matching ${esc(b?.id ?? "the invoice")}<br>
      <label class="check2"><input type="checkbox" id="inspect" ${d.inspection ? "checked" : ""} /> <span>Inspection certificate</span></label></p></div></div>
    <div class="lc-compare"><div><span>Letter of credit at your bank</span><b>≈ ${usd(lcFee, 0)} fee</b><small>${esc(POLICY.lcFeePct ?? 1)}% of the payment, plus up to 5 banking days to examine documents</small></div>
      <div><span>Document-checked escrow</span><b class="good">No examination fee</b><small>released minutes after the documents verify</small></div></div>`;
  return `<section class="fsec"><div class="fsec-head"><h3>When the money is released</h3><span class="fsec-note">You approve now either way</span></div>
    <div class="fbox"><div class="fbox-body"><div class="seg" role="radiogroup" aria-label="When the money is released">${opt("now", "As soon as it’s approved")}${opt("delivery", "After delivery is confirmed")}${opt("documents", "When shipping documents verify")}</div>
      ${docsBody}</div>
      <div class="fbox-foot"><p class="note11">${mode === "documents" ? "Replaces a letter of credit: the supplier knows the money is committed, and it is released the moment an electronic bill of lading shows the goods shipped on time and title passed to you."
        : mode === "delivery" ? `Someone other than the preparer confirms the goods arrived (bill of lading or goods receipt). On our stablecoin rail the money is locked in escrow at approval and returned after ${esc(POLICY.escrowDeadlineDays)} days if not released.`
        : "The payment is sent as soon as it is approved."}</p></div></div></section>`;
}

// ================================================================== REVIEW & APPROVE (Figma 58:3670)
// One document for both moments: the preparer's review before submitting, and an approver's review of a request.
function exposureNote(q) {
  const x = q?.exposure, rows = Object.entries(x?.perIssuer ?? {});
  if (!x?.enabled || !rows.length) return "";
  return `<details class="chat-details exposure-note"><summary>Transfer limits checked</summary>
    <p class="note10">This plan fits the current treasury and issuer budgets, expected settlement time and available route liquidity. Limits are checked again before sending.</p>
    <ul class="reasons">${rows.map(([issuer, row]) => `<li>${esc(issuer)}: ${usd(row.amountUsd, 2)} allocated. Settlement-time budget used by this plan: ${usd(row.weightedUsd, 2)} of ${usd(row.limitUsd, 2)}.</li>`).join("")}</ul></details>`;
}
function reviewDocument({ q, T, supplier, invoice, ref, purpose, due, routeLabel, routeWhy, editHref, changeHref, alts }) {
  const s = supplierByName(q.recipient.name) ?? supplierFor(invoice), masked = s?.maskedAccount ?? q.recipient.maskedAccount;
  return `<div class="doc-main g18">
    <div class="tx-head"><div><h2 class="serif28">${esc(q.recipient.name)}</h2><p class="note11">${esc([invoice, ref, COUNTRY[q.recipient.country] ?? q.recipient.country].filter(Boolean).join(" · "))}</p></div>
      ${editHref ? `<a class="text-btn" href="${editHref}">Edit details ↗</a>` : s ? `<a class="text-btn" href="#/suppliers/${encodeURIComponent(s.id)}">Supplier ↗</a>` : ""}</div>
    <div class="flow2"><div><span class="eyebrow">YOU PAY · FEES INCLUDED</span><b class="serif32">${money(q.sourceDebit)}</b><small>${esc(q.sourceAccount)}</small></div>
      ${IC("arrow-right-24", 24)}<div><span class="eyebrow">${q.amountType === "SOURCE_FIXED" ? "THEY RECEIVE · ESTIMATE" : "THEY RECEIVE"}</span><b class="serif32">${money(q.recipientNet)}</b><small>${esc(shortName(q.recipient.name))} · ${esc(q.recipient.ccy)} account ${esc(masked)}</small></div></div>
    <div class="divider"></div>
    <div class="pair">${detail(`Receiving account · ${q.recipient.ccy}`, esc(masked))}${detail("Purpose", esc(purpose || "—"))}</div>
    <div class="pair">${detail("Requested delivery", esc(dUtcY(due)))}${detail("Estimated arrival", esc(tUtc(q.arrivalUtc)))}</div>
    <div class="divider"></div>
    <div class="breakdown"><h3>What this costs</h3>
      ${drow("Transfer fee", T.transferFee)}${T.payoutFee ? drow("Payout fee", T.payoutFee) : ""}${drow("Total fees (already in what you pay)", feesLine(T))}
      ${drow("Amount converted", T.principal)}${T.converts ? drow(`${q.simulation ? "Simulated" : "Quoted"} exchange rate`, `1 ${T.fundedCcy} = ${T.rate} ${T.dest}`) : ""}
      ${drow(`They receive${T.converts ? ` · ${T.principal.split(" ")[0]} × ${T.rate}` : ""}`, money(q.recipientNet))}
      ${feeRow(q.platformFee, q.feeRule)}
      <p class="note10">The provider’s margin is built into the exchange rate, so there is no separate conversion fee. We assume the supplier’s bank takes nothing extra${q.simulation ? " (simulated prices)" : ""}.</p></div>
    <div class="divider"></div>
    <div class="route2"><div class="route2-head"><span>${IC("landmark", 18)}<b>${esc(routeLabel)}</b></span>${changeHref ? `<a class="text-btn" href="${changeHref}">Change route</a>` : `<span class="note11">Route fixed at submission</span>`}</div>
      <p class="t12">${esc(routeWhy)}</p><p class="note10">Arrival time is an estimate, not a guarantee.</p>
      ${alts ?? ""}</div>${exposureNote(q)}
  </div>`;
}
function altRows(options, chosen, chosenQ, T) {
  const rows = options.filter((o) => o.provider !== chosen).map((o) => {
    const q = o.q, label = o.label && o.label !== o.provider ? o.label : RAIL[o.provider] ?? o.provider;
    if (!q) return `<details class="alt"><summary>${IC("chevron-right", 14, 14, "chev")}<div class="tradeoff"><b>${esc(label)}</b><span>${esc(o.why ?? "No quote")}</span></div></summary><div class="alt-more"><p>Not eligible for this payment.</p></div></details>`;
    const fixedSource = q.amountType === "SOURCE_FIXED", main = fixedSource ? q.recipientNet : q.sourceDebit, dv = num(main) - num(fixedSource ? chosenQ.recipientNet : chosenQ.sourceDebit), ccy = String(main).split(" ")[1];
    const diff = Math.abs(dv) < 0.005 ? "same amount" : fixedSource ? `${fmt(Math.abs(dv))} ${ccy} ${dv < 0 ? "less" : "more"} for the supplier` : `${fmt(Math.abs(dv))} ${ccy} ${dv > 0 ? "more" : "less"} to pay`;
    const t = termsOf(q);
    return `<details class="alt"><summary>${IC("chevron-right", 14, 14, "chev")}<div class="tradeoff"><b>${esc(label)} · ${money(main)}</b><span>Arrives ${esc(tUtc(q.arrivalUtc))} · ${esc(diff)}${o.why ? ` · ${esc(o.why)}` : ""}</span><small>${esc(feesLine(t))} fees${t.converts ? ` · ${esc(t.principal)} × ${esc(t.rate)}` : ""}</small></div></summary>
      <div class="alt-more">${o.riskWhy ? `<p>Risk ${esc(o.risk)}/5 · ${esc(o.riskWhy)}</p>` : ""}<a href="#/payments/compare">Compare and choose this route →</a></div></details>`;
  }).join("");
  return rows ? `<div class="alts">${rows}</div><p class="note10">${chosenQ.amountType === "SOURCE_FIXED" ? `All routes use the same ${esc(money(chosenQ.sourceDebit))} total debit.` : `All routes deliver ${esc(money(chosenQ.recipientNet))}.`} ${chosenQ.simulation ? "These are simulated quotes, not connected providers." : "Testnet quotes."}</p>` : "";
}
// Same text the shared 1s ticker writes, rendered immediately so the clock is never blank
const leftText = (iso) => { const s = Math.round((Date.parse(iso) - Date.now()) / 1000); return s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left` : "expired"; };
const quoteClock = (q, after) => `<div class="clock2"><div class="clock2-head">${IC("clock-accent", 16)}<b><span data-exp="${esc(q.expiresAt)}">${leftText(q.expiresAt)}</span> on this quote</b></div>
  <p>Captured ${esc(tUtc(q.capturedAt))}</p><p>Expires ${esc(tUtc(q.expiresAt))}</p><small>${esc(after)}</small></div>`;

// Preparer's review before submitting (#/payments/review): the agents' exact paid quote that /requests will bind to
async function pageReview(P) {
  const d = DRAFT, b = billOf(d.billId), dec = chosenDecision();
  if (!b || !dec) { location.hash = DRAFT.billId ? "#/payments/compare" : "#/payments/new"; return; }
  setCrumbs("Payments", "Manual request", "Review");
  docPage(P, `${docIntro("Review & approve", "Check the details, then send it to your approvers. No money moves yet.")}<div class="doc-cols"><div class="doc-main"><i class="skel-line"></i></div></div>`);
  const [q, ...altQs] = await Promise.all([quoteTerms(dec.intentId), ...(dec.options ?? []).map((o) => (o.provider !== dec.chosen && o.intentId ? quoteTerms(o.intentId) : null))]);
  if (!location.hash.startsWith("#/payments/review")) return;
  if (!q) { docPage(P, `${docIntro("Review & approve", "One deliberate submission. Every detail in view.")}${notice("This quote is no longer available. Refresh the quotes before submitting.", "warn")}<a class="btn-line" href="#/payments/compare">Refresh quotes</a>`); return; }
  const T = termsOf(q), expired = Date.now() > Date.parse(q.expiresAt), two = num(q.sourceDebit) > POLICY.dualApprovalOverUsd;
  const options = (dec.options ?? []).map((o, i) => ({ ...o, q: altQs[i] }));
  docPage(P, `${docIntro("Review & approve", "One deliberate submission. Every detail in view.", badge(expired ? "Quote expired" : "Draft · Unsent", expired ? "warn" : ""))}
    <div class="doc-cols">
      ${reviewDocument({ q, T, invoice: b.id, ref: null, purpose: d.purpose, due: d.due, routeLabel: q.legs[0]?.label ?? RAIL[dec.chosen],
        routeWhy: dec.reasons?.find((r) => !r.startsWith("compared:")) ?? "Chosen by you", editHref: "#/payments/new", changeHref: "#/payments/compare", alts: altRows(options, dec.chosen, q, T) })}
      <aside class="doc-aside w312 g20" aria-label="Submit for approval">
        <span class="eyebrow">SUBMISSION · ${esc(utc(new Date().toISOString()))}</span>
        <h2 class="serif28">${expired ? "Refresh before submitting" : "Ready to submit for approval"}</h2>
        ${quoteClock(q, "After expiry, submitting is blocked until a refreshed quote is reviewed.")}
        ${detail("Preparer", ME ? `${esc(ME.name)} · ${esc(ME.title)}` : "Sign in to submit")}
        ${detail("Approval needed", `${two ? `Two approvers (over ${usd(POLICY.dualApprovalOverUsd)})` : "One approver"} other than you${dec.decision === "review" ? " · call-back first" : ""}`)}
        ${detail("You pay", `${money(q.sourceDebit)}, including ${esc(feesLine(T))} fees`)}
        ${q.platformFee != null ? detail("Route402 fee", esc(feeText(q.platformFee))) : ""}
        ${detail(q.amountType === "SOURCE_FIXED" ? "They receive (estimate)" : "They receive", money(q.recipientNet))}
        ${agentTrail(DRAFT.agent ?? {})}
        <div class="divider"></div>
        ${expired ? `<button class="btn-line" id="refresh">Refresh quotes</button>` : `${ack("ok", `I’ve checked the supplier, invoice, fees and delivery estimate. I understand this ${STATE.localSimulation ? "runs a local simulation" : "sends testnet money and a simulated payout"} only.`)}
          <button class="btn-solid" id="submit">Submit for approval ${IC("check-white-15", 15)}</button><div id="sub-err"></div>`}
        <p class="note10">Submitting creates a payment request. Nothing is sent until your approvers approve it. Reading this review or choosing a route does not submit anything.</p>
        <div class="divider"></div>
        <a class="text-btn" href="#/payments/new">← Return to draft</a><p class="note10">Your draft stays in this tab until you submit it.</p>
      </aside>
    </div>`);
  $("#refresh")?.addEventListener("click", () => { DRAFT.key = null; DRAFT.agent = null; saveDraft(); location.hash = "#/payments/new"; });
  $("#submit")?.addEventListener("click", async () => {
    if (!ME) return signIn(() => pageReview(P));
    if (Date.now() > Date.parse(q.expiresAt)) return pageReview(P);
    if (!$("#ok").checked) { $("#sub-err").innerHTML = `<p class="note11 bad">Tick the confirmation first.</p>`; return; }
    $("#submit").disabled = true;
    try {
      const docs = d.release === "documents" ? { [b.id]: { latestShipmentUtc: `${d.latestShipment}T23:59:59Z`, documents: d.inspection ? ["inspection_certificate"] : [] } } : {};
      const out = await api("/requests", { decisions: [chosenDecision()], releaseOnDelivery: d.release !== "documents" && d.deliver ? [b.id] : [], documentary: docs, confirmed: true, purpose: d.purpose, mode: d.mode });
      const one = out.requests?.[0]; if (!one?.requestId) throw new Error(one?.skipped ?? out.error ?? "not submitted");
      DRAFT = {}; saveDraft(); location.hash = `#/payments/${one.requestId}`;
    } catch (err) { $("#sub-err").innerHTML = `<p class="note11 bad">${esc(err.message)}</p>`; $("#submit").disabled = false; }
  });
}

// A submitted request awaiting call-back or approval (#/payments/:id): the approver's review, existing controls
const cbNote = (note) => { const n = String(note ?? "Bank details changed since the last payment.").trim(), t = n.charAt(0).toUpperCase() + n.slice(1);
  return `${t}${/[.!]$/.test(t) ? "" : "."}${/number already on file|vendor master/i.test(t) ? "" : " Call on a number from your vendor master, not one from the change request."}`; };
async function pageApprove(P, r, q) {
  const A = r.actions ?? {}, s = r.status, T = q && termsOf(q);
  setCrumbs("Payments", r.id, "Review");
  const sub = q ? reviewDocument({ q, T, invoice: r.payable.startsWith("chat_") ? null : r.payable, ref: r.id, purpose: r.purpose, due: r.timing?.deadlineUtc,
      routeLabel: q.legs[0]?.label ?? RAIL[r.provider] ?? r.provider, routeWhy: r.agentReasons?.[0] ?? "Chosen by the preparer", alts: `<details class="chat-details"><summary>Why the agent chose this route</summary><ul class="reasons">${(r.agentReasons ?? []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>
        ${r.allowReroute ? `<p class="note10">Backup route allowed: if this route stops working, another quoted route to the same supplier can be used, as long as it arrives on time and costs no more than you approved.</p>` : ""}` })
    : `<div class="doc-main g18"><h2 class="serif28">${esc(r.supplier)}</h2>${notice(`The quote terms for ${esc(r.id)} are no longer available here. Approving still uses the stored request: ${usd(r.debitUsd, 2)} for ${esc(money(r.recipientGets))}.`, "warn")}</div>`;
  const ready = A.approve?.allowed, title = ready ? "Ready for your approval" : s === "NEEDS_CALLBACK" ? "Call-back needed first" : !ME ? "Sign in to review" : "Waiting for approval";
  const why = !ME ? "Sign in as an approver to act on this payment." : s === "NEEDS_CALLBACK" ? (A.callback?.allowed ? null : A.callback?.why) : ready ? null : A.approve?.why;
  docPage(P, `${docIntro("Review & approve", "Check the details. Your approval is what lets this payment go.", badge(statusText(s), "warn"))}
    <div class="doc-cols">${sub}
      <aside class="doc-aside w312 g20" aria-label="Approval">
        <span class="eyebrow">APPROVAL · ${esc(utc(new Date().toISOString()))}</span>
        <h2 class="serif28">${esc(title)}</h2>
        ${q ? quoteClock(q, `After expiry, release re-prices within the approved ${money(q.sourceDebit)} cap; a higher price pauses the payment for a new approval.`) : ""}
        ${detail("Approver", ME ? `${esc(ME.name)} · ${esc(ME.title)}` : "Not signed in")}
        ${detail("Approvals", `${r.approvals.length} of ${r.approvalsRequired}`, r.approvals.map((a) => `${esc(nameOf(a.by))} · ${esc(tUtc(a.at))}`).join("<br>"))}
        ${detail("Prepared by", `${esc(nameOf(r.preparedBy))}`, esc(tUtc(r.preparedAt)))}
        ${detail("You pay", q ? `${money(q.sourceDebit)}, including ${esc(feesLine(T))} fees` : usd(r.debitUsd, 2))}
        ${(r.platformFee ?? q?.platformFee) != null ? detail("Route402 fee", esc(feeText(r.platformFee ?? q?.platformFee))) : ""}
        ${detail(q?.amountType === "SOURCE_FIXED" ? "They receive (estimate)" : "They receive", money(q?.recipientNet ?? r.recipientGets))}
        <div class="divider"></div>
        ${s === "NEEDS_CALLBACK" ? notice(esc(cbNote(r.detailsNote)), "warn") : ""}
        ${A.callback?.allowed ? `<button class="btn-line" data-act="callback">Record call-back</button>` : ""}
        ${s === "AWAITING_APPROVAL" && reviewAlerts(r).length && !r.alertsReviewed ? `${notice(`${reviewAlerts(r).length} monitoring alert${reviewAlerts(r).length === 1 ? "" : "s"} to review: ${esc(reviewAlerts(r).map((a) => a.detail).join("; "))}.`, "warn")}${ack("ok-alerts", "I’ve reviewed the monitoring alerts on this payment.")}` : ""}
        ${s === "AWAITING_APPROVAL" ? `${ack("ok", `I’ve checked the beneficiary, invoice, fees and delivery estimate. I understand this approves ${STATE.localSimulation ? "simulated" : "testnet"} execution only.`)}
          <button class="btn-solid" id="approve" ${ready ? "" : "disabled"}>Approve payment ${IC("check-white-15", 15)}</button>` : ""}
        ${why ? `<p class="note11 bad">${esc(why)}</p>` : ""}${!ME ? `<button class="btn-line" id="ap-signin">Sign in</button>` : ""}
        <div id="act-form"></div>
        ${alertsBlock(r)}${complianceBlock(r)}
        <p class="note10">${s === "NEEDS_CALLBACK" ? "Approval opens once someone other than the preparer records the call-back." : "Only this action approves."} ${r.approvalsRequired > 1 ? "Two different approvers are required before release. " : ""}Reading this review does not approve or send a payment.</p>
        ${A.reject?.allowed ? `<button class="text-btn danger" data-act="reject">Reject payment</button>` : ""}
        <div class="divider"></div>
        <a class="text-btn" href="#/payments">← All payments</a>
        <p class="note10">Standard bank payment file (ISO 20022): <a href="/ui/requests/${esc(r.id)}/iso20022" download>download ↓</a></p>
      </aside>
    </div>`);
  $$("[data-act]").forEach((x) => x.onclick = () => act(r, x.dataset.act, P));
  $("#ap-signin")?.addEventListener("click", () => signIn(route));
  $("#approve")?.addEventListener("click", () => {
    if (!$("#ok").checked || ($("#ok-alerts") && !$("#ok-alerts").checked)) { $("#act-form").innerHTML = `<p class="note11 bad">Tick ${$("#ok-alerts") ? "both confirmations" : "the confirmation"} first.</p>`; return; }
    $("#approve").disabled = true; act(r, "approve", P);
  });
}

// Shipping-document check (in place of a letter of credit): what is required, each presentation and its checks, and the
// letter-of-credit comparison from the company's own LC fee setting.
function documentsBlock(r) {
  const D = r.documentary; if (!D) return "";
  const t = D.terms, last = D.presentations.at(-1), lcFee = Math.round(r.debitUsd * (POLICY.lcFeePct ?? 1)) / 100;
  const label = STATE.documents?.labels ?? {};
  return `<div class="divider"></div><div class="breakdown"><h3>Shipping documents (instead of a letter of credit)</h3>
    <p class="t12">Ship by ${esc(dUtcY(t.latestShipmentUtc))} · present within ${t.presentationDays} days of shipment · ${t.documents.map((x) => esc(label[x] ?? x)).join(", ")}</p>
    ${last ? `<ul class="doc-checks">${last.checks.map((c) => `<li class="${c.ok ? "ok" : "bad"}"><b>${c.ok ? "✓" : "✗"} ${esc(c.label)}</b><span>${esc(c.detail)}</span></li>`).join("")}</ul>
      <p class="note10">${last.ok ? "All checks passed; the release condition is met." : "Not released: fix the failed checks and present again."} ${last.simulated ? "eBL platform simulated in this demo." : ""} ${D.presentations.length} presentation${D.presentations.length === 1 ? "" : "s"} recorded.</p>`
      : `<p class="note11">No documents presented yet.</p>`}
    <div class="lc-compare"><div><span>As a letter of credit</span><b>≈ ${usd(lcFee, 0)} fee</b><small>${esc(POLICY.lcFeePct ?? 1)}% at your bank, plus up to 5 banking days of document checks</small></div>
      <div><span>Document-checked escrow</span><b class="good">No examination fee</b><small>${r.delivery ? `released ${esc(tUtc(r.delivery.at))}` : "released the moment the documents verify"}</small></div></div></div>`;
}
// The compliance rules this payment passed when it was prepared (they run again just before money moves)
function complianceBlock(r) {
  const C2 = r.compliance; if (!C2?.checks?.length) return "";
  const shown = C2.checks.filter((c) => c.status !== "n/a");
  return `<div class="divider"></div><div class="breakdown"><h3>Compliance checks</h3>
    <ul class="doc-checks">${shown.map((c) => `<li class="${c.status === "pass" ? "ok" : c.status === "fail" ? "bad" : "warn"}"><b>${c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "!"} ${esc(c.label)}</b><span>${esc(c.detail)}</span></li>`).join("")}</ul>
    ${C2.travelRule ? `<p class="note10">Travel Rule record attached (${esc(C2.travelRule.standard)}): ${esc(C2.travelRule.originator.legalPerson)} → ${esc(C2.travelRule.beneficiary.legalPerson)}, ${esc(C2.travelRule.amount)}.</p>` : ""}
    <p class="note10">Checked ${esc(tUtc(C2.checkedAt))}; checked again just before the money moves.</p></div>`;
}

// ================================================================== IMPACT (payment pages)
// What this payment changed against the company's bank, and the running total across payments. Charts: inline SVG,
// validated palette slots 1-2 (blue = Route402, orange = your bank), thin marks with 4px rounded data ends, direct labels,
// hover tooltips (each value is also printed, so the tooltip never gates information).
const VIZ = { ours: "var(--viz-1)", bank: "var(--viz-2)" };
const svgEsc = (v) => esc(v);
function vizTip() {
  let t = document.getElementById("viz-tip");
  if (!t) { t = document.createElement("div"); t.id = "viz-tip"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  return t;
}
document.addEventListener("pointermove", (e) => {
  const m = e.target.closest?.("[data-tip]"), t = vizTip();
  if (!m) { t.style.opacity = "0"; return; }
  t.textContent = ""; const [v, l] = m.dataset.tip.split("|");
  const b = document.createElement("b"); b.textContent = v; t.appendChild(b);
  if (l) { const s = document.createElement("span"); s.textContent = l; t.appendChild(s); }
  t.style.opacity = "1"; t.style.left = `${Math.min(innerWidth - 220, e.clientX + 14)}px`; t.style.top = `${e.clientY + 14}px`;
});
// Two horizontal bars on one baseline: Route402 vs your bank wire. HTML bars, so text stays at its normal size at any width.
function barPair(title, rows, unitFmt) {
  const max = Math.max(...rows.map((r) => r.value), 1e-9);
  return `<figure class="viz"><figcaption>${esc(title)}</figcaption><div class="hbars" role="img" aria-label="${esc(`${title}: ${rows.map((r) => `${r.label} ${unitFmt(r.value)}`).join(", ")}`)}">
    ${rows.map((r) => `<div class="hbar" data-tip="${esc(unitFmt(r.value))}|${esc(r.label)}"><span class="hbar-cat">${esc(r.label)}</span>
      <span class="hbar-track"><i style="width:${Math.max(1.5, (r.value / max) * 100).toFixed(1)}%;background:${r.color}"></i></span><b>${esc(unitFmt(r.value))}</b></div>`).join("")}</div></figure>`;
}
// A line that grows over time, drawn to fit any tile: shapes are a stretched SVG, points and labels are HTML so text keeps
// its size. Points: { t, v, kind: "realized" | "projected", label }. Two states of one quantity share one hue:
// dark teal = realized, light teal = projected (validated one-hue ordinal pair). `marks` are labelled vertical lines.
function growthChart(pts, { marks = [], endLabel, aria, legend = true } = {}) {
  if (pts.length < 2) return `<p class="note11">This fills in as payments are made.</p>`;
  const t0 = pts[0].t, t1 = Math.max(pts.at(-1).t, t0 + 3600e3), maxV = Math.max(...pts.map((p) => p.v), 1), top = maxV * 1.08;
  const X = (t) => ((t - t0) / (t1 - t0)) * 100, Y = (v) => 100 - (v / top) * 100;
  const seq = (a) => a.map((p) => `${X(p.t).toFixed(2)},${Y(p.v).toFixed(2)}`).join(" ");
  const cut = pts.findLastIndex((p) => p.kind === "realized"), real = pts.slice(0, cut + 1), proj = cut >= 0 ? pts.slice(cut) : pts;
  const area = (a) => (a.length > 1 ? `<polygon points="${X(a[0].t)},100 ${seq(a)} ${X(a.at(-1).t)},100" class="g-area ${a === real ? "real" : "proj"}"/>` : "");
  const line = (a, k) => (a.length > 1 ? `<polyline points="${seq(a)}" class="g-line ${k}"/>` : "");
  const short = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0));
  const hasProj = proj.length > 1 && cut < pts.length - 1;
  return `<div class="growth" role="img" aria-label="${esc(aria ?? "")}">
    <span class="growth-y top">$${short(maxV)}</span><span class="growth-y bottom">$0</span>
    <div class="growth-plot">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${hasProj ? area(proj) : ""}${area(real)}${hasProj ? line(proj, "proj") : ""}${line(real, "real")}</svg>
      ${marks.map((m) => `<i class="growth-today" style="left:${X(m.t)}%"><b>${esc(m.label)}</b></i>`).join("")}
      ${pts.map((p, i) => `<span class="g-pt ${p.kind}${i === pts.length - 1 ? " end" : ""}" style="left:${X(p.t)}%;top:${Y(p.v)}%" data-tip="$${fmt(p.v, 0)}|${esc(p.label)}"></span>`).join("")}
      <span class="growth-end" style="top:${Y(pts.at(-1).v)}%">${esc(endLabel ?? `$${short(pts.at(-1).v)}`)}</span>
    </div>
    <span class="growth-x">${esc(day(new Date(t0).toISOString()))}</span><span class="growth-x right">${esc(day(new Date(t1).toISOString()))}</span>
  </div>${legend && hasProj ? `<p class="growth-legend"><span><i class="real"></i>Paid</span><span><i class="proj"></i>Open bills, projected</span></p>` : ""}`;
}

// A grid of six tiles of different shapes forming one flat-edged rectangle. Drag a tile onto another (or focus it and press
// [ or ]) to swap places; the slots keep their shapes so the edges stay flat. Each grid remembers its own layout.
const BENTO_SLOTS = ["a", "b", "c", "d", "e", "f"];
function bento(key, title, sub, tiles, order) {
  try { const o = JSON.parse(localStorage.getItem(`r402-bento-${key}`) ?? "null"); if (Array.isArray(o) && o.length === 6 && o.every((x) => x in tiles)) order = o; } catch {}
  return `<section class="bento-wrap" aria-label="${esc(title)}">
    <div class="bento-head"><h3 class="serif26">${esc(title)}</h3><span class="note11">${esc(sub)} · drag tiles to rearrange</span></div>
    <div class="bento" data-bento="${key}">${BENTO_SLOTS.map((slot, i) => `<div class="b-tile" draggable="true" tabindex="0" aria-label="Tile; drag, or press [ or ] to move" data-tile="${order[i]}" style="grid-area:${slot}">${tiles[order[i]]}</div>`).join("")}</div>
  </section>`;
}
function swapTiles(from, to) {
  const grid = from.closest(".bento"); if (!grid || grid !== to.closest(".bento")) return;
  const a = from.style.gridArea, b = to.style.gridArea; from.style.gridArea = b; to.style.gridArea = a;
  const order = BENTO_SLOTS.map((s) => [...grid.querySelectorAll(".b-tile")].find((x) => x.style.gridArea.split(" ")[0] === s)?.dataset.tile);
  try { localStorage.setItem(`r402-bento-${grid.dataset.bento}`, JSON.stringify(order)); } catch {}
}
document.addEventListener("dragstart", (e) => { const t = e.target.closest?.(".b-tile"); if (t) { e.dataTransfer.setData("text/plain", t.dataset.tile); t.classList.add("dragging"); } });
document.addEventListener("dragend", (e) => e.target.closest?.(".b-tile")?.classList.remove("dragging"));
document.addEventListener("dragover", (e) => { if (e.target.closest?.(".b-tile")) e.preventDefault(); });
document.addEventListener("drop", (e) => {
  const to = e.target.closest?.(".b-tile"); if (!to) return; e.preventDefault();
  const from = to.closest(".bento").querySelector(`.b-tile[data-tile="${e.dataTransfer.getData("text/plain")}"]`); if (from && from !== to) swapTiles(from, to);
});
document.addEventListener("keydown", (e) => {
  const t = e.target.closest?.(".b-tile"); if (!t || !["[", "]"].includes(e.key)) return;
  const tiles = [...t.closest(".bento").querySelectorAll(".b-tile")], slot = (x) => BENTO_SLOTS.indexOf(x.style.gridArea.split(" ")[0]);
  const target = tiles.find((x) => slot(x) === slot(t) + (e.key === "]" ? 1 : -1)); if (target) { swapTiles(t, target); t.focus(); }
});
const howWeDidIt = (checks) => `<span class="eyebrow">How we did it</span>
  <ul class="b-list"><li>Every route priced against the live market rate, fees and time in transit included</li>
    <li>${checks ? `${checks} compliance checks` : "Compliance checks"} before quoting and again before release</li>
    <li>Independent quotes and a supplier screen bought by our agents</li></ul>
  <p class="note10">The routing models themselves stay with Route402.</p>`;
const daysLabel = (d) => (d >= 1.5 ? `${d.toFixed(1)} days` : `${Math.max(1, Math.round(d * 24))} hours`);

// One payment's impact: only this payment. Its advantage over your bank wire builds in two parts: the price difference at
// send, then the value of the cash for each day it is no longer in transit (your cost of cash), until the wire would land.
function impactPanel(r, q, impact) {
  const row = impact?.payments?.find((x) => x.id === r.id), an = q?.analysis;
  if (!row) return "";
  const done = row.status === "COMPLETED", saved = Math.max(0, row.savedUsd), sooner = row.bankDays != null && row.ourDays != null ? row.bankDays - row.ourDays : 0;
  const routes = an?.searched?.routes ?? row.routesCompared ?? 0, checks = (r.compliance?.checks ?? []).filter((c) => c.status === "pass").length;
  const coc = STATE.costOfCashPct ?? 6, perDay = (row.debitUsd * coc) / 100 / 365, timeValue = sooner > 0.04 ? perDay * sooner : 0, total = saved + timeValue;
  const sent = Date.parse(an?.plannedAtUtc ?? r.preparedAt), ours = sent + (row.ourDays ?? 0) * 86400e3, bank = sent + (row.bankDays ?? 0) * 86400e3;
  const chart = total > 0.5
    ? growthChart([{ t: sent, v: saved, kind: "realized", label: "Price difference at send" }, { t: ours, v: saved, kind: "realized", label: "Arrived by Route402" },
        { t: bank, v: total, kind: "realized", label: `Bank wire would land · +$${fmt(timeValue, 0)} cash value` }],
        { marks: sooner > 0.04 ? [{ t: ours, label: "Arrived" }, { t: bank, label: "Wire would land" }] : [], aria: `This payment's advantage grows from $${fmt(saved, 0)} to $${fmt(total, 0)}`, legend: false })
      + `<p class="b-sub">Price difference at send, plus ${esc(coc)}% cost of cash for each day it is not in transit</p>`
    : `${barPair("", [{ label: "This payment", value: row.bpsOurs ?? 0, color: "var(--g-real)" }, { label: "Bank wire", value: row.bpsBank ?? 0, color: "var(--g-proj)" }], (v) => `${(v / 100).toFixed(2)}%`)}
       <p class="b-sub">Cost above the market rate. Your bank wire matched or beat the ${routes > 1 ? `${routes - 1} other route${routes > 2 ? "s" : ""}` : "alternatives"} for this payment.</p>`;
  const tiles = {
    saved: `<span class="eyebrow">${done ? "This payment" : "This payment · expected"}</span>
      ${saved > 0.5 ? `<div class="b-num">$${fmt(saved, 0)} saved</div><p class="b-sub">against your bank wire for the same payment, after our fee</p>`
        : `<div class="b-num">Best price confirmed</div><p class="b-sub">Your bank wire was the cheapest route for this payment, so it went that way.</p>`}
      <dl class="b-facts"><div><dt>You paid</dt><dd>${esc(money(`${row.debitUsd} USD`))}</dd></div><div><dt>Total advantage</dt><dd>${total > 0.5 ? `$${fmt(total, 0)}` : "—"}</dd></div></dl>`,
    speed: `<span class="eyebrow">Speed</span><div class="b-num">${sooner > 0.04 ? `${daysLabel(sooner)} sooner` : "Same as a wire"}</div>
      <p class="b-sub">${row.ourDays != null ? `${row.ourDays < 0.05 ? "minutes" : daysLabel(row.ourDays)} here vs ${daysLabel(row.bankDays)} by bank wire` : ""}</p>`,
    cost: `<span class="eyebrow">Cost above market</span><div class="b-num">${row.bpsOurs != null ? `${(row.bpsOurs / 100).toFixed(2)}%` : "—"}</div>
      <p class="b-sub">${row.bpsBank != null ? `vs ${(row.bpsBank / 100).toFixed(2)}% through your bank` : ""}</p>`,
    routes: `<span class="eyebrow">Routes compared</span><div class="b-num">${routes}</div><p class="b-sub">for this payment</p>`,
    chart: `<span class="eyebrow">${total > 0.5 ? "How this payment's advantage builds" : "Price check"}</span>${chart}`,
    process: howWeDidIt(checks),
  };
  return bento("payment", done ? "Impact of this payment" : "Expected impact", "This payment only, measured against your bank wire", tiles, ["saved", "speed", "cost", "routes", "chart", "process"]);
}

// All payments (Payments page): what has been saved on paid payments, and where it grows as the open bills are paid
function portfolioPanel(g, impact) {
  if (!g) return "";
  const T = g.totals, grand = T.realizedUsd + T.projectedUsd, pts = [];
  let total = 0;
  for (const x of g.realized) { total += x.savedUsd; pts.push({ t: Date.parse(x.at), v: total, kind: "realized", label: `${x.supplier} · paid, +$${fmt(x.savedUsd, 0)}` }); }
  const now = Math.max(Date.now(), pts.at(-1)?.t ?? 0); pts.push({ t: now, v: total, kind: "realized", label: "Today" });
  for (const x of g.projected) { total += x.savedUsd; pts.push({ t: Math.max(now, Date.parse(x.payOnUtc)), v: total, kind: "projected", label: `${x.supplier} · open bill, +$${fmt(x.savedUsd, 0)} by ${day(x.payOnUtc)}` }); }
  const by = g.projected.length ? ` (by ${esc(day(g.projected.at(-1).payOnUtc))})` : "";
  const tiles = {
    growth: `<span class="eyebrow">Savings growth</span>${g.realized.length
        ? `<div class="b-num">$${fmt(T.realizedUsd, 0)} <em>→</em> $${fmt(grand, 0)}</div>
      <p class="b-sub">Saved on paid payments so far, and where it grows as your open bills are paid on their best routes${by}.</p>`
        : `<div class="b-num">$${fmt(grand, 0)} <em>projected</em></div>
      <p class="b-sub">Nothing has been paid through Route402 yet. This is what your open bills save once they are paid on their best routes${by}.</p>`}
      <dl class="b-facts"><div><dt>Paid payments</dt><dd>${g.realized.length}</dd></div><div><dt>Open bills with a route</dt><dd>${g.projected.length} of ${g.open?.bills ?? g.projected.length}</dd></div></dl>`,
    paid: `<span class="eyebrow">Paid so far</span><div class="b-num">$${fmt(T.realizedUsd, 0)}</div><p class="b-sub">${!g.realized.length ? "No completed payments yet"
      : T.realizedUsd >= 0.5 ? `saved across ${plural(g.realized.length, "completed payment")}`
      : `across ${plural(g.realized.length, "completed payment")}; none beat your bank wire on price`}</p>`,
    projected: `<span class="eyebrow">Open bills, projected</span><div class="b-num">+$${fmt(T.projectedUsd, 0)}</div>
      <p class="b-sub">on ${g.projected.length} of ${g.open?.bills ?? g.projected.length} open bills, after our fee${g.open?.blocked || g.open?.noRoute ? ` (${[g.open.blocked && `${g.open.blocked} need bank details fixed`, g.open.noRoute && `${g.open.noRoute} with no route by the deadline yet`].filter(Boolean).join(", ")})` : ""}</p>`,
    speed: `<span class="eyebrow">Speed</span><div class="b-num">${T.avgDaysFaster > 0.04 ? `${daysLabel(T.avgDaysFaster)} sooner` : "Same as a wire"}</div><p class="b-sub">${T.fasterBills
      ? `on average, for the ${T.fasterBills} of ${g.projected.length} open bills that arrive before a bank wire would`
      : `none of the ${g.projected.length} open bills with a route arrive before a bank wire would`}</p>`,
    chart: `<span class="eyebrow">Cumulative savings vs your bank</span>${growthChart(pts, { marks: [{ t: now, label: "Today" }], aria: `Savings ${fmt(T.realizedUsd, 0)} USD paid so far, growing to ${fmt(grand, 0)} USD as open bills are paid` })}`,
    process: howWeDidIt(0),
  };
  return bento("portfolio", "Savings across your payments", "Paid payments plus open bills, against your bank wire", tiles, ["growth", "paid", "speed", "projected", "chart", "process"]);
}

// ================================================================== PAYMENT TRACKING (Figma 58:3832)
async function pageTracking(P, id) {
  const r = REQS.find((x) => x.id === id);
  if (!r) { setCrumbs("Payments", id); docPage(P, `${docIntro("Payment", "")}${notice(`No payment request ${esc(id)} in this workspace.`, "warn")}<a class="text-btn" href="#/payments">← All payments</a>`); return; }
  const [t, q, audit, impact] = await Promise.all([r.transferId ? api(`/transfers/${encodeURIComponent(r.transferId)}`).catch(() => null) : null,
    quoteTerms(r.intentId), api("/audit").catch(() => ({ entries: [] })), api("/impact").catch(() => null)]);
  if (location.hash !== `#/payments/${id}`) return;
  if (["NEEDS_CALLBACK", "AWAITING_APPROVAL"].includes(r.status)) return pageApprove(P, r, q);
  setCrumbs("Payments", r.id);
  const s = r.status, A = r.actions ?? {}, sup = supplierByName(r.supplier) ?? supplierFor(r.payable);
  const H = (st) => t?.history?.find((h) => h.status === st), alloc = t?.terms?.allocations ?? [];
  const debit = t?.terms?.totals?.sourceDebit ?? q?.sourceDebit ?? `${r.debitUsd} USD`, net = t?.terms?.totals?.recipientNet ?? q?.recipientNet ?? r.recipientGets;
  const arrival = t?.terms?.totals?.arrivalUtc ?? q?.arrivalUtc ?? r.arrivalUtc, credited = t?.creditedAtUtc, completedAt = s === "COMPLETED" ? H("COMPLETED")?.at : null;
  const masked = sup?.maskedAccount ?? q?.recipient?.maskedAccount ?? "—", country = sup?.country ?? q?.recipient?.country ?? (r.country !== "-" ? r.country : null), srcAcct = q?.sourceAccount ?? (STATE.connected ? "Operating account (Capital One)" : "USD operating account (demo)");
  // fees and conversion of the executed (or approved) terms
  let fees = q ? feesLine(termsOf(q)) : null, conv = null;
  if (alloc.length) {
    const src = String(debit).split(" ")[1], dest = String(net).split(" ")[1], f = alloc.reduce((a, x) => a + num(x.input.fundingFee), 0), p = alloc.reduce((a, x) => a + num(x.input.payoutFee), 0);
    fees = [`${fmt(f)} ${src}`, p ? `${fmt(p)} ${dest}` : null].filter(Boolean).join(" + ");
    conv = alloc.map((x) => `${fmt(num(x.sourceDebit) - num(x.input.fundingFee))} ${src} × ${fxFmt(x.input.fxRate)} = ${money(x.recipientNet)}`).join(" · ");
  } else if (q) { const T = termsOf(q); conv = T.converts ? `${T.principal} × ${T.rate} = ${money(q.recipientNet)}` : "No conversion"; }
  // timeline: only recorded events are marked done; forecasts are labelled as such
  const ev = [];
  const push = (title, at, sub, state, right) => ev.push({ title, at, sub, state, right });
  push("Prepared", r.preparedAt, `${nameOf(r.preparedBy)} · ${r.id}`, "done");
  if (r.detailsChanged) push("Call-back verified", r.callback?.at, r.callback ? `${nameOf(r.callback.by)} · ${r.callback.contact} on ${r.callback.phoneOnFile}` : "Verify the new details on a number already on file", r.callback ? "done" : "todo");
  r.approvals.forEach((a, i) => push(r.approvalsRequired > 1 ? `Approved ${i + 1} of ${r.approvalsRequired}` : "Approved", a.at, `${nameOf(a.by)} · ${USERS.find((u) => u.id === a.by)?.title ?? ""}`, "done"));
  if (r.rejected) push("Rejected", r.rejected.at, `${nameOf(r.rejected.by)} · ${r.rejected.why}`, "bad");
  if (r.escrow) push("Funds locked in escrow", null, r.escrow.state === "FAILED" ? r.escrow.error : `${r.escrow.amountUsdc} test USDC · ${r.escrow.chain}`, ["LOCKED", "RELEASED", "REFUNDED"].includes(r.escrow.state) ? "done" : r.escrow.state === "FAILED" ? "bad" : "now");
  if (r.releaseOnDelivery) push(r.documentary ? "Shipping documents verified" : "Delivery confirmed", r.delivery?.at, r.delivery ? `${r.delivery.documentRef} · ${nameOf(r.delivery.by)}` : r.documentary ? "Electronic bill of lading and commercial invoice" : "Bill of lading or goods receipt", r.delivery ? "done" : s === "AWAITING_DELIVERY" ? "now" : "todo");
  if (r.escrow?.state === "RELEASED") push("Escrow released to the supplier", null, "On-chain release", "done");
  if (r.escrow?.state === "REFUNDED") push("Escrow refunded to the company", null, "On-chain refund", "done");
  if (!["REJECTED", "REFUNDED"].includes(s)) {
    const sched = H("SCHEDULED") ?? H("APPROVED"), exec = H("EXECUTING"), fund = t?.steps?.fund_1, payout = t?.steps?.payout_1;
    push("Submitted", sched?.at, t ? `Route402 router · ${t.transferId}` : "After approval", t ? "done" : s === "READY" ? "now" : "todo");
    push(s === "PAUSED" ? "Paused" : "Processing", exec?.at, s === "PAUSED" ? r.note ?? "Paused by your safety policy" : fund ? `${fund.rail ?? "Funding"} · ${String(fund.status).toLowerCase()}` : "Funding and payout", s === "PAUSED" ? "bad" : exec ? (s === "EXECUTING" && !credited ? "now" : "done") : "todo");
    push(credited ? "Recipient credited" : "Settlement pending", credited, credited ? `Payout ${payout?.payoutId ?? ""} confirmed`.trim() : "No recipient credit confirmed · Forecast only", credited ? "done" : s === "FAILED" ? "bad" : "todo", credited ? null : `Forecast: ${tUtc(arrival)}`);
    push(completedAt ? "Reconciled" : "Reconciliation pending", completedAt, completedAt ? `Ledger balanced · deadline ${String(t?.deadlineStatus ?? r.deadlineStatus ?? "recorded").toLowerCase()}` : s === "FAILED" ? r.note ?? "Needs reconciliation" : "No reconciliation event recorded · Pending",
      completedAt ? "done" : s === "FAILED" ? "bad" : "todo", completedAt ? null : "After confirmed settlement");
  }
  const mark = { done: IC("check-accent-13", 13), now: IC("clock-stage", 13), bad: "!", todo: "○" };
  const timeline = ev.map((e, i) => `<div class="ev2 ${e.state}"><div class="rail2"><span class="mk">${mark[e.state]}</span>${i < ev.length - 1 ? `<i class="conn ${e.state === "done" ? "on" : ""}"></i>` : ""}</div>
    <div class="ev2-d"><div class="ev2-h"><b>${esc(e.title)}</b><span>${esc(e.at ? tUtc(e.at) : e.right ?? "")}</span></div><p>${esc(e.sub)}</p></div></div>`).join("");
  const mine = (audit.entries ?? []).filter((x) => x.ref === r.id || (r.transferId && x.ref === r.transferId)), done = ev.filter((e) => e.state === "done").length;
  const banner = { READY: ["Approved and releasing. Not yet settled; recipient credit and reconciliation remain pending.", ""], EXECUTING: [`Submitted for ${STATE.localSimulation ? "simulated" : "testnet"} processing, not yet settled. Recipient credit and reconciliation remain pending.`, ""],
    AWAITING_DELIVERY: [r.documentary ? "Approved. The money is released when the shipping documents verify (instead of a letter of credit)." : "Approved. Release waits for receiving to confirm delivery.", ""], COMPLETED: [`Completed: recipient credit${completedAt ? ` and reconciliation recorded ${tUtc(completedAt)}` : " recorded"}.`, ""],
    PAUSED: [`Paused by your safety policy. ${r.note ?? ""}`, "warn"], FAILED: [`Check ${r.id}${r.transferId ? ` / ${r.transferId}` : ""} before any retry. ${r.note ?? ""} Do not submit again: a new request for this bill is blocked until this one is resolved.`, "warn"],
    REJECTED: [`Rejected by ${nameOf(r.rejected?.by)}: ${r.rejected?.why ?? ""}`, "warn"], REFUNDED: [r.note ?? "Refunded.", ""] }[s] ?? [r.note ?? statusText(s), ""];
  const acts = [["presentDocuments", "Present shipping documents"], ["confirmDelivery", "Confirm delivery"], ["recheck", "Re-check and release"], ["refund", "Refund escrow"], ["reject", "Reject payment"]].filter(([k]) => A[k]?.allowed);
  docPage(P, `${docIntro(`Payment to ${shortName(r.supplier)}`, `${r.id} · ${refLabel(r)} · ${statusText(s)} snapshot`, `<button class="btn-line" id="refresh">Refresh status ${IC("refresh-cw", 15)}</button>`)}
    ${notice(esc(banner[0]), banner[1])}
    ${impactPanel(r, q, impact)}
    <div class="doc-cols">
      <section class="doc-main g20" aria-label="Payment progress">
        <div class="status-head"><span class="eyebrow">${esc((RAIL[r.provider] ?? r.provider).toUpperCase())}</span>${badge(statusText(s), reqBadgeKind(s))}</div>
        <div class="flow2"><div><span class="eyebrow">YOU PAY · FEES INCLUDED</span><b class="serif32">${money(debit)}</b><small>${esc(srcAcct)}</small></div>
          ${IC("arrow-right-24", 24)}<div><span class="eyebrow">${credited ? "SUPPLIER RECEIVED" : "SUPPLIER RECEIVES · ESTIMATE"}</span><b class="serif32">${money(net)}</b><small>${esc(shortName(r.supplier))} · ${esc(r.ccy)} account ${esc(masked)}</small></div></div>
        <div class="divider"></div>
        <div class="tl2-head"><h3>Payment timeline</h3><span>✓ Happened   ○ Still to come</span></div>
        <div class="tl2">${timeline}</div>
        <div class="divider"></div>
        <div class="breakdown"><h3>Transfer details</h3>
          <div class="pair">${detail("Requested delivery", esc(dUtcY(r.timing?.deadlineUtc)))}${detail(credited ? "Recipient credited" : "Estimated arrival", esc(credited ? tUtc(credited) : dUtcY(arrival)))}</div>
          <div class="pair">${detail("Fees (already included)", esc(fees ?? "—"))}${detail("Exchange at approval", esc(conv ?? "—"))}</div>
          ${(r.platformFee ?? q?.platformFee) != null ? `<div class="pair">${detail("Route402 fee", esc(feeText(r.platformFee ?? q?.platformFee)))}${detail("Fee rule", esc(r.feeRule ?? q?.feeRule ?? "—"))}</div>` : ""}
          <p class="note10">${t?.approval ? `Approved ${esc(tUtc(t.approval.at))}; the amounts are locked to what was approved (terms ${esc(t.termsHash.slice(0, 8))})` : `Prepared ${esc(tUtc(r.preparedAt))}`}${t?.deadlineStatus ? ` · deadline ${esc(String(t.deadlineStatus).toLowerCase())}` : ""}. We assume the supplier’s bank takes nothing extra.</p></div>
        ${exposureNote(q)}${documentsBlock(r)}${alertsBlock(r)}${complianceBlock(r)}
        <div id="acct"></div>
      </section>
      <aside class="doc-aside w310" aria-label="Recipient and audit">
        <span class="eyebrow">RECIPIENT</span><h2 class="serif26">${esc(r.supplier)}</h2>
        <p class="note11">${esc([country && (COUNTRY[country] ?? country), r.ccy, masked].filter(Boolean).join(" · "))}</p>
        ${sup ? `<a class="text-btn" href="#/suppliers/${encodeURIComponent(sup.id)}">Manage supplier →</a>` : ""}
        <div class="divider"></div>
        ${detail("Source", esc(srcAcct))}${detail("Purpose", esc(r.purpose ?? "—"))}
        <div class="divider"></div>
        <span class="eyebrow">AUDIT SNAPSHOT</span><p class="t11">${esc(mine.length ? tUtc(mine[0].at) : tUtc(new Date().toISOString()))}</p>
        <p class="note11">${mine.length} audit entr${mine.length === 1 ? "y" : "ies"} · ${done} recorded timeline event${done === 1 ? "" : "s"}${completedAt ? "" : ". No settlement or reconciliation event yet"}. ${audit.verify?.ok ? "Tamper check passed." : "Tamper check failed: review the activity log."}</p>
        <button class="text-btn" id="export-audit">Export audit trail ↓</button>
        ${acts.length ? `<div class="divider"></div><span class="eyebrow">ACTIONS</span><div class="acts2">${acts.map(([k, l]) => `<button class="${k === "reject" ? "btn-line danger" : "btn-solid"}" data-act="${k}">${esc(l)}</button>`).join("")}</div>` : ""}
        <div id="act-form"></div>
        <div class="divider"></div>
        <span class="eyebrow">NEED AN UPDATE?</span>
        <p class="t11">If status is uncertain, check ${esc(r.id)}${r.transferId ? ` and ${esc(r.transferId)}` : ""} before retrying. Do not submit another payment to resolve a delay.</p>
        <a class="btn-line" href="#/activity">View activity log</a>
        <p class="note10">Bank payment file: <a href="/ui/requests/${esc(r.id)}/iso20022" download>download ↓</a>${r.proof ? ` · <a href="${esc(r.proof)}" target="_blank" rel="noopener">settlement proof ↗</a>` : ""}${r.escrow?.lockTx ? ` · escrow ${txLink(r.escrow, r.escrow.lockTx)}` : ""}. ${t?.receipt ? "Receipt recorded with the transfer." : "Receipt available only after confirmed settlement."}</p>
      </aside>
    </div>`);
  $("#refresh").onclick = () => route();
  $("#export-audit").onclick = () => download(`route402-audit-${r.id}.json`, JSON.stringify({ request: r.id, transfer: r.transferId ?? null, chainVerified: !!audit.verify?.ok, exportedAt: new Date().toISOString(), entries: mine }, null, 2), "application/json");
  $$("[data-act]").forEach((x) => x.onclick = () => act(r, x.dataset.act, P));
  loadAccounting(r.id);
  if (["READY", "EXECUTING"].includes(s) || r.escrow?.state === "LOCKING") POLL = setTimeout(route, 2500);
}

// ================================================================== ACCOUNTING (payment tracking)
// The payment's accounting-ready record (/ui/accounting/:id): source and invoice, quoted vs actual cost with the variance
// explained, flags, and the proposed journal entry. Proposed until an approver approves it; never posted to a ledger here.
const JSTATUS = { not_ready: ["Not ready", ""], needs_review: ["Needs review", "warn"], draft: ["Ready for approval", ""], approved: ["Approved", ""] };
async function loadAccounting(id) {
  const el = $("#acct"); if (!el) return;
  const a = await api(`/accounting/${encodeURIComponent(id)}`).catch((e) => ({ error: e.message }));
  if (!$("#acct")) return;
  if (a.error) { el.innerHTML = `<div class="divider"></div>${notice(`Accounting record unavailable: ${esc(a.error)}`, "warn")}`; return; }
  el.innerHTML = accountingBlock(a); bindAccounting(a);
}
function accountingBlock(a) {
  const J = a.journal, V = a.variance, [st, kind] = JSTATUS[J.status] ?? [J.status, ""], inv = a.source.invoice;
  const canReview = ME && USERS.find((u) => u.id === ME.id)?.roles.some((x) => ["approver", "admin"].includes(x));
  const mv = (v) => (v && / [A-Z]{3,5}$/.test(v) ? money(v) : esc(v));
  const metricRow = (m) => `<tr><td><b>${esc(m.label)}</b><div class="note">${esc(m.basis)}</div></td><td>${m.quoted == null ? "—" : mv(m.quoted)}</td><td>${m.actual == null ? "Not recorded" : mv(m.actual)}</td>
    <td>${m.diff == null ? "—" : `${mv(m.diff)}${m.pct != null ? `<div class="note">${m.unit === "bps" ? `${fmt(m.pct * 100, 2)} bps` : `${fmt(m.pct, 2)}%`}</div>` : ""}`}</td></tr>`;
  const line = (l) => `<tr><td class="mono">${esc(l.account.code)}</td><td><b>${esc(l.account.name)}</b><div class="note">${esc(l.description)}</div><div class="note">${esc(l.calculation)}</div></td>
    <td class="num">${l.side === "debit" ? esc(l.amount ? money(l.amount.display) : "Missing") : ""}</td><td class="num">${l.side === "credit" ? esc(l.amount ? money(l.amount.display) : "Missing") : ""}</td></tr>`;
  return `<div class="divider"></div><div class="breakdown acct">
    <div class="acct-head"><h3>Accounting</h3>${badge(st, kind)}</div>
    <p class="note10">${J.status === "approved" ? `Approved by ${esc(nameOf(a.approval?.by))} · ${esc(tUtc(a.approval?.at))}. ` : "Proposed entry. "}Accounting-ready for export; Route402 has not posted it to any general ledger. Execution data: ${esc(a.provenance)}.</p>
    <div class="pair">${detail("Invoice", inv.ref ? `${esc(inv.ref)}${inv.amount ? ` · ${money(inv.amount)}` : ""}` : "None linked", inv.origin ? `${esc(inv.origin)} · not verified against the supplier's invoice` : "")}
      ${detail("Lifecycle", esc(a.lifecycleLabel), a.source.payment.settledAtUtc ? `Settled ${esc(tUtc(a.source.payment.settledAtUtc))}` : "")}</div>
    <div class="pair">${detail("Payment", `${esc(a.requestId)}${a.transferId ? ` · ${esc(a.transferId)}` : ""}`, a.source.payment.payoutIds.length ? `Payout ${esc(a.source.payment.payoutIds.join(", "))}` : "")}
      ${detail("Requested", money(a.source.payment.requestedAmount))}</div>
    <h3>Quoted vs actual cost</h3>
    ${V.unavailable ? notice(esc(V.unavailable), "warn") : ""}
    <div class="scroll"><table class="tbl compact acct-tbl"><thead><tr><th>Measure</th><th>Quoted (approved)</th><th>Actual (ledger)</th><th>Difference</th></tr></thead><tbody>${V.metrics.map(metricRow).join("")}</tbody></table></div>
    ${V.explanation?.length ? `<ul class="reasons">${V.explanation.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${V.effects?.length ? `<details class="chat-details"><summary>How the difference breaks down (${esc(a.journal.currency)})</summary><ul class="reasons">${V.effects.map((e) => `<li><b>${esc(e.label)}: ${esc(e.amount.display)}</b> · ${esc(e.explanation)}</li>`).join("")}
      ${V.residual ? `<li><b>Unexplained: ${esc(V.residual.display)}</b></li>` : ""}</ul></details>` : ""}
    ${a.flags.length ? `<ul class="doc-checks">${a.flags.map((f) => `<li class="warn"><b>! ${esc(f.reason)}</b><span>${esc(f.values)}</span><span>Next: ${esc(f.next)}</span></li>`).join("")}</ul>` : ""}
    <h3>Proposed journal entry${J.transactionDate ? ` · ${esc(J.transactionDate)}` : ""}</h3>
    ${J.lines.length ? `<div class="scroll"><table class="tbl compact acct-tbl"><thead><tr><th>Code</th><th>Account</th><th class="num">Debit (${esc(J.currency)})</th><th class="num">Credit (${esc(J.currency)})</th></tr></thead><tbody>${J.lines.map(line).join("")}
      ${J.totals ? `<tr class="tot"><td></td><td><b>Total</b> ${J.balanced ? pill("ok", "Balanced") : pill("bad", "Not balanced")}</td><td class="num"><b>${esc(money(J.totals.debit.display))}</b></td><td class="num"><b>${esc(money(J.totals.credit.display))}</b></td></tr>` : ""}</tbody></table></div>` : ""}
    ${J.mappingIllustrative ? `<p class="note10">Account codes are illustrative until an admin confirms the chart of accounts in Policy &amp; people.</p>` : ""}
    ${J.missing.length || J.errors.length ? `<ul class="doc-checks">${J.errors.map((x) => `<li class="bad"><b>✗ Error</b><span>${esc(x)}</span></li>`).join("")}${J.missing.map((x) => `<li class="warn"><b>! Missing</b><span>${esc(x)}</span></li>`).join("")}</ul>` : ""}
    ${J.notes.map((x) => `<p class="note10">${esc(x)}</p>`).join("")}
    ${J.status !== "approved" && J.status !== "not_ready" && canReview ? `<details class="chat-details" ${J.missing.length ? "open" : ""}><summary>Reviewer inputs</summary><div class="acct-form">
        ${inv.origin !== "linked bill" ? `<label class="note11">Invoice reference<input id="ac-inv" value="${esc(a.review?.invoiceRef ?? "")}" maxlength="60" placeholder="e.g. bill number in your ERP" /></label>` : ""}
        <label class="note11">Booked AP carrying amount for this settlement (${esc(J.currency)})<input id="ac-carry" inputmode="decimal" value="${esc(a.review?.carryingAmount ?? "")}" placeholder="from your ledger" /></label>
        <label class="note11">Source of the carrying amount<input id="ac-src" value="${esc(a.review?.carryingSource ?? "")}" maxlength="80" placeholder="e.g. ERP bill 4471, booked at 1.3601" /></label>
        <button class="btn-line" id="ac-save">Save inputs</button></div></details>` : ""}
    ${J.status === "draft" && canReview ? `${ack("ac-ok", "I've checked the lines, accounts and amounts against the source records.")}<button class="btn-solid" id="ac-approve">Approve journal entry ${IC("check-white-15", 15)}</button>` : ""}
    ${J.status === "draft" && !canReview ? `<p class="note10">An approver or admin approves this entry.</p>` : ""}
    <div id="ac-out"></div></div>`;
}
function bindAccounting(a) {
  const out = (m, bad) => { $("#ac-out").innerHTML = `<p class="note11 ${bad ? "bad" : ""}">${esc(m)}</p>`; };
  $("#ac-save")?.addEventListener("click", async () => {
    try { await api(`/accounting/${a.requestId}/review`, { invoiceRef: $("#ac-inv")?.value, carryingAmount: $("#ac-carry").value, carryingSource: $("#ac-src").value }); loadAccounting(a.requestId); }
    catch (e) { out(e.message, true); }
  });
  $("#ac-approve")?.addEventListener("click", async () => {
    if (!$("#ac-ok").checked) return out("Tick the confirmation first.", true);
    try { await api(`/accounting/${a.requestId}/approve`, {}); loadAccounting(a.requestId); } catch (e) { out(e.message, true); }
  });
}
// Payments page: period summary of settled payments, fees, quote variance and review queue
async function accountingSummary(period = "30d") {
  const el = $("#acct-summary"); if (!el) return;
  const s = await api(`/accounting/summary?period=${period}`).catch(() => null); if (!s || !$("#acct-summary")) return;
  const tile = (label, value, sub, basis) => `<div class="acct-tile" title="${esc(basis)}"><span class="eyebrow">${esc(label)}</span><b>${esc(value)}</b><small>${esc(sub)}</small></div>`;
  el.innerHTML = `<div class="panel2"><div class="acct-head"><span class="label accent">Payment accounting · ${esc(s.period.label)} · ${esc(s.currency)}</span>
      <span class="seg-mini">${[["30d", "30 days"], ["mtd", "Month to date"], ["all", "All time"]].map(([k, l]) => `<button class="${k === period ? "on" : ""}" data-period="${k}">${l}</button>`).join("")}</span></div>
    <div class="acct-tiles">${tile("Completed volume", money(s.completed.volume), `${s.completed.count} settled payment${s.completed.count === 1 ? "" : "s"}`, s.completed.basis)}
      ${tile("Observed fees", money(s.fees.amount), "transfer + payout fees", s.fees.basis)}
      ${tile("Cost vs quote", money(s.variance.amount), `${s.variance.comparable} of ${s.variance.of} comparable`, s.variance.basis)}
      ${tile("Flagged", String(s.flagged.count), "payments to investigate", s.flagged.basis)}
      ${tile("Entries to review", String(s.awaitingReview.count), "settled, not approved", s.awaitingReview.basis)}</div>
    <p class="note">${esc(s.completed.basis)}. Only settled payments with provider ledger data count; ${s.excluded} request${s.excluded === 1 ? "" : "s"} excluded (not settled in the period or no execution data). Execution data is simulated in this demo.
      ${ME ? ` <a href="/ui/accounting/export.csv" download>Export validated journal entries (CSV) ↓</a>` : " Sign in to export journal entries."}</p></div>`;
  el.querySelectorAll("[data-period]").forEach((b) => b.onclick = () => accountingSummary(b.dataset.period));
}
