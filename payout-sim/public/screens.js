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
    : `Testnet demo · ${STATE.connected ? `Connected: ${STATE.source.replace("Nessie customer", "Capital One ·")}` : "Demo company data"} · Testnet money only · Supplier payouts simulated`;
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
const quoteKey = (d) => `${d.billId}|${d.mode}|${d.budgetUsd}|${d.due}`;
const recRoute = (R) => (R?.routes ?? []).filter((r) => r.status === "OK").sort((a, b) => a.economics.allInUsd - b.economics.allInUsd)[0];
async function loadDraftQuotes(P, q) {
  const d = DRAFT, b = billOf(d.billId);
  if (!b || !d.due || (d.mode === "budget" && !(d.budgetUsd > 0)) || d.key === quoteKey(d)) return;
  DRAFT = { ...d, key: quoteKey(d), routes: null, routesErr: null, agent: null, agentErr: null, selected: d.selected ?? null }; saveDraft();
  const qs = `?due=${encodeURIComponent(DRAFT.due)}${DRAFT.mode === "budget" ? `&mode=budget&usd=${DRAFT.budgetUsd}` : ""}`;
  try { DRAFT.routes = await api(`/routes/${encodeURIComponent(b.id)}${qs}`); } catch (e) { DRAFT.routesErr = e.message; }
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
  const field = (k, label, control, hint = "") => `<div class="field3 ${err[k] ? "err" : ""}" id="ff-${k}"><label for="${k}">${esc(label)}</label>${control}${err[k] ? `<span class="e">${esc(err[k])}</span>` : hint ? `<span class="h">${esc(hint)}</span>` : ""}</div>`;
  const sel3 = (id, opts, attrs = "") => `<div class="sel3">${`<select id="${id}" ${attrs}>${opts}</select>`}${IC("chevron-down", 14)}</div>`;
  const routeName = (r) => RAIL[r.provider] ?? r.provider, arrival = (r) => (r.economics.transitDays < 0.05 ? "minutes · 24/7" : `${r.economics.transitDays.toFixed(1)} days`);
  const others = ok.filter((r) => r !== sel);
  const diff = (r) => { if (!sel) return ""; const dv = budget ? num(r.supplierGets) - num(sel.supplierGets) : r.economics.allInUsd - sel.economics.allInUsd;
    return budget ? `${fmt(Math.abs(dv))} ${b.ccy} ${dv < 0 ? "less" : "more"} for the supplier` : `${usd(Math.abs(dv), 2)} ${dv > 0 ? "more" : "less"} all-in`; };
  const x = sel?.breakdown, e = sel?.economics;
  docPage(P, `${docIntro("Manual payment", "Enter the details yourself. The same review and approval comes next.", `<a class="text-btn t12" href="#/chat">Ask the agent instead ↗</a>`)}
  <div class="doc-cols">
    <form class="doc-main g22" id="mp-form" novalidate>
      <div class="draft-ref"><span class="eyebrow">${b ? esc(b.id) : "NEW PAYMENT REQUEST"}</span>${badge("Draft · Unsent")}</div>
      <section class="fsec"><div class="fsec-head"><h3>Recipient &amp; receiving details</h3><button type="button" class="text-btn" id="mp-add">+ Add supplier</button></div>
        ${field("bill", "Saved supplier and invoice", sel3("bill", `<option value="">Choose a saved supplier</option>${startable.map((x2) => `<option value="${esc(x2.id)}" ${x2.id === d.billId ? "selected" : ""}>${esc(x2.supplier)} · ${esc(x2.id)} · ${money(`${x2.amount} ${x2.ccy}`)}</option>`).join("")}`))}
        ${b ? `<div class="pair">${detail("Location / currency", `${esc(COUNTRY[b.country] ?? b.country)} · ${esc(b.ccy)}`)}${detail("Receiving account", esc(s?.maskedAccount ?? R?.bill?.maskedAccount ?? "—"))}</div>
          <p class="note11">${esc(b.issues[0] ?? `Saved receiving details · ${b.check === "OK" ? "format checks passed" : "review required"}`)}${b.acceptsUsdc ? " · accepts USDC" : ""}</p>` : `<p class="note11">${startable.length} invoice${startable.length === 1 ? "" : "s"} ready to pay. Blocked suppliers and invoices that already have a request are not listed.</p>`}
      </section>
      <div class="divider"></div>
      <section class="fsec"><h3>Source &amp; total debit</h3>
        ${field("source", "Source account", sel3("source", `<option>${esc(R?.sourceAccount ?? (STATE.connected ? "Operating account (Capital One)" : "USD operating account (demo)"))}</option>`))}
        <div class="seg" role="radiogroup" aria-label="Amount"><label class="${budget ? "" : "on"}"><input type="radio" name="mode" value="invoice" ${budget ? "" : "checked"} />Supplier receives the invoice amount</label>
          <label class="${budget ? "on" : ""}"><input type="radio" name="mode" value="budget" ${budget ? "checked" : ""} />Fix the total debit</label></div>
        <div class="pair">${field("usd", "Total debit · USD", budget ? `<input id="usd" inputmode="decimal" placeholder="0.00" value="${esc(d.budgetUsd ?? "")}" />`
            : `<input id="usd" readonly value="${sel ? esc(fmt(num(sel.youPay))) : ""}" placeholder="${b ? "Calculated from the quote" : "—"}" aria-describedby="usd-h" />`)}
          ${field("ccy", "Recipient currency", sel3("ccy", b ? `<option>${esc(b.ccy)} · ${esc(new Intl.DisplayNames(["en"], { type: "currency" }).of(b.ccy) ?? b.ccy)}</option>` : "<option>—</option>"))}</div>
        <p class="note10" id="usd-h">${budget ? "Include all fees in your total debit." : `The supplier receives ${b ? money(`${b.amount} ${b.ccy}`) : "the invoice amount"}; the total debit includes all fees.`} Recipient currency must match saved receiving details.</p>
      </section>
      <div class="divider"></div>
      <section class="fsec"><h3>Invoice &amp; delivery</h3>
        <div class="pair">${field("inv", "Invoice reference", `<input id="inv" readonly value="${esc(b?.id ?? "")}" placeholder="From the saved invoice" />`)}
          ${field("due", "Requested delivery", `<input id="due" type="date" value="${esc((d.due ?? "").slice(0, 10))}" />`, b ? `Invoice due ${dUtcY(b.dueUtc)}` : "")}</div>
        ${field("purpose", "Purpose", `<input id="purpose" maxlength="120" value="${esc(d.purpose)}" placeholder="Enter purpose" />`)}
        <label class="check2"><input type="checkbox" id="deliver" ${d.deliver ? "checked" : ""} /> <span><b>Release only after delivery is confirmed</b> (bill of lading or goods receipt). On our stablecoin rail the money is locked in escrow at approval and returned after ${esc(POLICY.escrowDeadlineDays)} days if not released.</span></label>
      </section>
      <div class="divider"></div>
      <section class="fsec"><div class="fsec-head"><h3>Route preference</h3><span class="eyebrow">${STATE.localSimulation ? "SIMULATED QUOTES" : "ROUTER QUOTES"}</span></div>
        ${!b ? `<p class="note11">Choose a saved supplier to see the available routes.</p>` : d.routesErr ? notice(esc(d.routesErr), "warn")
          : !R ? `<div class="routebox"><i class="skel-line"></i></div>` : !sel ? notice("No route can deliver this payment as requested. Try a later delivery date.", "warn")
          : `<div class="routebox">${IC("circle-dot", 18)}<div><b>${esc(routeName(sel))} · ${sel === rec ? "Recommended" : "Selected"}</b><span>${sel === rec ? "Lowest all-in cost within the requested delivery" : diff(rec).replace(/more|less/, (w) => (w === "more" ? "less" : "more")) + " than the recommended route"} · ${e.meetsDeadline ? `arrives ${dUtc(sel.arrivalUtc)}` : "may miss the requested date"} · ${sel.provider === "stablecoin" ? "supplier accepts USDC" : "saved receiving details"}</span></div></div>
            ${others.length ? `<p class="routes-alt">Change route: ${others.map((r) => `<button type="button" class="text-btn" data-pick="${r.provider}">${esc(routeName(r))} · ${money(budget ? r.supplierGets : r.youPay)}</button>`).join("  /  ")}</p>
              <p class="note10">${others.map((r) => `${esc(routeName(r))}: ${esc(diff(r))}, ${r.economics.meetsDeadline ? `arrives ${dUtc(r.arrivalUtc)}` : "may arrive late"}.`).join(" ")}</p>` : ""}
            ${R.routes.filter((r) => r.status !== "OK").map((r) => `<p class="note10">${esc(RAIL[r.provider] ?? r.provider)}: ${esc(r.reason ?? "not available")}</p>`).join("")}
            <a class="text-btn" href="#/payments/compare">Compare every route in detail →</a>`}
      </section>
    </form>
    <aside class="doc-aside w310" aria-label="Payment summary">
      <span class="eyebrow">PAYMENT SUMMARY</span>
      <p class="serif30">${sel ? (budget ? usd(d.budgetUsd, 2) : money(sel.youPay)) : "—"}</p><p class="note11">Total debit · All fees included</p>
      <div class="divider"></div>
      ${detail("To", esc(b?.supplier ?? "Choose a supplier"))}${b ? detail("Invoice", esc(b.id)) : ""}
      ${sel ? `${drow("Transfer fee", usd(x.transferFeeUsd, 2))}${x.payoutFeeUsd ? drow("Payout fee", usd(x.payoutFeeUsd, 2)) : ""}${drow("Conversion cost vs mid-market", usd(x.conversionCostUsd, 2))}
        ${drow("Total fees included", usd(e.pricedUsd, 2))}${drow("Principal", usd(x.convertedPrincipalUsd, 2))}${drow("Rate", b.ccy === "USD" ? "No conversion" : `${Number(sel.fxRate).toFixed(4)} ${b.ccy} / USD`)}
        <div class="divider"></div>${detail(budget ? "Estimated recipient amount" : "Supplier receives", money(sel.supplierGets))}
        ${detail(`${routeName(sel)} · ${arrival(sel)}`, `Estimated arrival ${dUtc(sel.arrivalUtc)}`)}
        <p class="note10">Quote captured ${esc(tUtc(sel.capturedAt))}; expires ${esc(utc(sel.expiresAt))} (<span data-exp="${esc(sel.expiresAt)}">${leftText(sel.expiresAt)}</span>). Next, the agents buy a paid quote and screen the supplier; you review that exact quote.</p>` : ""}
      ${notice("No money moves when you complete this form or select a route.")}
      <button class="btn-solid" id="go" ${busy ? "disabled" : ""}>${busy ? `<span class="spinner"></span>Checking quotes and supplier…` : `Continue to review ${IC("arrow-right-white", 15)}`}</button>
      ${d.agentErr ? `<p class="note11 bad">Agents unavailable: ${esc(d.agentErr)}</p>` : ""}
      <p class="note10">No additional recipient deductions assumed. Actual quotes may differ. Format checks are not bank verification.</p>
    </aside>
  </div>`);
  const set = (patch) => { DRAFT = { ...DRAFT, ...patch, formErr: null }; saveDraft(); pageCreate(P, new URLSearchParams()); loadDraftQuotes(P, new URLSearchParams()); };
  $("#bill").onchange = () => { DRAFT = { billId: $("#bill").value, mode: DRAFT.mode, purpose: DRAFT.purpose, deliver: DRAFT.deliver }; set({}); };
  $$("[name=mode]").forEach((r) => r.onchange = () => set({ mode: r.value }));
  if (budget) $("#usd").onchange = () => set({ budgetUsd: Number($("#usd").value.replace(/,/g, "")) || undefined });
  $("#due").onchange = () => set({ due: $("#due").value ? new Date(`${$("#due").value}T20:00:00Z`).toISOString() : undefined });
  $("#purpose").onchange = () => { DRAFT.purpose = $("#purpose").value; saveDraft(); };
  $("#deliver").onchange = () => { DRAFT.deliver = $("#deliver").checked; saveDraft(); };
  $$("[data-pick]").forEach((x2) => x2.onclick = () => { DRAFT.selected = x2.dataset.pick; saveDraft(); pageCreate(P, new URLSearchParams()); });
  $("#mp-add").onclick = () => { CHAT_INPUT = "Add a supplier"; location.hash = "#/chat"; };
  $("#mp-form").onsubmit = (ev) => ev.preventDefault();
  $("#go").onclick = async () => {
    const errs = {};
    if (!DRAFT.billId) errs.bill = "Select a supplier to continue.";
    if (DRAFT.mode === "budget" && !(DRAFT.budgetUsd > 0)) errs.usd = "Enter an amount greater than 0.00 USD.";
    DRAFT.purpose = $("#purpose").value.trim(); if (!DRAFT.purpose) errs.purpose = "Purpose is required.";
    if (!DRAFT.due) errs.due = "Choose a requested delivery date.";
    if (Object.keys(errs).length) { DRAFT.formErr = errs; saveDraft(); return pageCreate(P, new URLSearchParams()); }
    if (!DRAFT.routes) return;
    // Same agent step as the compare page: paid quotes + supplier screen. Review always shows the agents' exact quote.
    if (!DRAFT.agent) await runAgents(P, () => pageCreate(P, new URLSearchParams()), "#/payments/new");
    if (!location.hash.startsWith("#/payments/new")) return;
    location.hash = chosenDecision() ? "#/payments/review" : "#/payments/compare";
  };
  loadDraftQuotes(P, q);
}

// ================================================================== REVIEW & APPROVE (Figma 58:3670)
// One document for both moments: the preparer's review before submitting, and an approver's review of a request.
function reviewDocument({ q, T, supplier, invoice, ref, purpose, due, routeLabel, routeWhy, editHref, changeHref, alts }) {
  const s = supplierByName(q.recipient.name) ?? supplierFor(invoice), masked = s?.maskedAccount ?? q.recipient.maskedAccount;
  return `<div class="doc-main g18">
    <div class="tx-head"><div><h2 class="serif28">${esc(q.recipient.name)}</h2><p class="note11">${esc([invoice, ref, COUNTRY[q.recipient.country] ?? q.recipient.country].filter(Boolean).join(" · "))}</p></div>
      ${editHref ? `<a class="text-btn" href="${editHref}">Edit details ↗</a>` : s ? `<a class="text-btn" href="#/suppliers/${encodeURIComponent(s.id)}">Supplier ↗</a>` : ""}</div>
    <div class="flow2"><div><span class="eyebrow">TOTAL DEBIT · ALL FEES INCLUDED</span><b class="serif32">${money(q.sourceDebit)}</b><small>${esc(q.sourceAccount)}</small></div>
      ${IC("arrow-right-24", 24)}<div><span class="eyebrow">${q.amountType === "SOURCE_FIXED" ? "ESTIMATED RECIPIENT AMOUNT" : "RECIPIENT AMOUNT · QUOTED"}</span><b class="serif32">${money(q.recipientNet)}</b><small>${esc(shortName(q.recipient.name))} · ${esc(q.recipient.ccy)} account ${esc(masked)}</small></div></div>
    <div class="divider"></div>
    <div class="pair">${detail(`Receiving account · ${q.recipient.ccy}`, esc(masked))}${detail("Purpose", esc(purpose || "—"))}</div>
    <div class="pair">${detail("Requested delivery", esc(dUtcY(due)))}${detail("Estimated arrival", esc(tUtc(q.arrivalUtc)))}</div>
    <div class="divider"></div>
    <div class="breakdown"><h3>Cost &amp; conversion</h3>
      ${drow("Transfer fee", T.transferFee)}${T.payoutFee ? drow("Payout fee", T.payoutFee) : ""}${drow("Total fees · included in debit", feesLine(T))}
      ${drow("Converted principal", T.principal)}${T.converts ? drow(`${q.simulation ? "Simulated" : "Quoted"} exchange rate`, `1 ${T.fundedCcy} = ${T.rate} ${T.dest}`) : ""}
      ${drow(`Recipient amount${T.converts ? ` · ${T.principal.split(" ")[0]} × ${T.rate}` : ""}`, money(q.recipientNet))}
      <p class="note10">The conversion cost is built into the rate; there is no separate conversion fee. No additional recipient deductions assumed${q.simulation ? " in this simulation" : ""}. Actual quotes may differ.</p></div>
    <div class="divider"></div>
    <div class="route2"><div class="route2-head"><span>${IC("landmark", 18)}<b>${esc(routeLabel)}</b></span>${changeHref ? `<a class="text-btn" href="${changeHref}">Change route</a>` : `<span class="note11">Route fixed at submission</span>`}</div>
      <p class="t12">${esc(routeWhy)}</p><p class="note10">Delivery is estimated, not guaranteed. Verified historical reliability is unavailable.</p>
      ${alts ?? ""}</div>
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
  docPage(P, `${docIntro("Review & approve", "One deliberate submission. Every detail in view.")}<div class="doc-cols"><div class="doc-main"><i class="skel-line"></i></div></div>`);
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
        ${detail("Total debit to submit", `${money(q.sourceDebit)}, including ${esc(feesLine(T))} fees`)}
        ${detail(q.amountType === "SOURCE_FIXED" ? "Estimated recipient amount" : "Recipient amount", money(q.recipientNet))}
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
      const out = await api("/requests", { decisions: [chosenDecision()], releaseOnDelivery: d.deliver ? [b.id] : [], confirmed: true, purpose: d.purpose, mode: d.mode });
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
        ${r.allowReroute ? `<p class="note10">Reroute allowed: another quoted route to the same supplier may be used if it meets the deadline within the approved debit cap.</p>` : ""}` })
    : `<div class="doc-main g18"><h2 class="serif28">${esc(r.supplier)}</h2>${notice(`The quote terms for ${esc(r.id)} are no longer available here. Approving still uses the stored request: ${usd(r.debitUsd, 2)} for ${esc(money(r.recipientGets))}.`, "warn")}</div>`;
  const ready = A.approve?.allowed, title = ready ? "Ready for your approval" : s === "NEEDS_CALLBACK" ? "Call-back needed first" : !ME ? "Sign in to review" : "Waiting for approval";
  const why = !ME ? "Sign in as an approver to act on this payment." : s === "NEEDS_CALLBACK" ? (A.callback?.allowed ? null : A.callback?.why) : ready ? null : A.approve?.why;
  docPage(P, `${docIntro("Review & approve", "One deliberate approval. Every detail in view.", badge(statusText(s), "warn"))}
    <div class="doc-cols">${sub}
      <aside class="doc-aside w312 g20" aria-label="Approval">
        <span class="eyebrow">APPROVAL · ${esc(utc(new Date().toISOString()))}</span>
        <h2 class="serif28">${esc(title)}</h2>
        ${q ? quoteClock(q, `After expiry, release re-prices within the approved ${money(q.sourceDebit)} cap; a higher price pauses the payment for a new approval.`) : ""}
        ${detail("Approver", ME ? `${esc(ME.name)} · ${esc(ME.title)}` : "Not signed in")}
        ${detail("Approvals", `${r.approvals.length} of ${r.approvalsRequired}`, r.approvals.map((a) => `${esc(nameOf(a.by))} · ${esc(tUtc(a.at))}`).join("<br>"))}
        ${detail("Prepared by", `${esc(nameOf(r.preparedBy))}`, esc(tUtc(r.preparedAt)))}
        ${detail("Total debit to approve", q ? `${money(q.sourceDebit)}, including ${esc(feesLine(T))} fees` : usd(r.debitUsd, 2))}
        ${detail(q?.amountType === "SOURCE_FIXED" ? "Estimated recipient amount" : "Recipient amount", money(q?.recipientNet ?? r.recipientGets))}
        <div class="divider"></div>
        ${s === "NEEDS_CALLBACK" ? notice(esc(cbNote(r.detailsNote)), "warn") : ""}
        ${A.callback?.allowed ? `<button class="btn-line" data-act="callback">Record call-back</button>` : ""}
        ${s === "AWAITING_APPROVAL" ? `${ack("ok", `I’ve checked the beneficiary, invoice, fees and delivery estimate. I understand this approves ${STATE.localSimulation ? "simulated" : "testnet"} execution only.`)}
          <button class="btn-solid" id="approve" ${ready ? "" : "disabled"}>Approve payment ${IC("check-white-15", 15)}</button>` : ""}
        ${why ? `<p class="note11 bad">${esc(why)}</p>` : ""}${!ME ? `<button class="btn-line" id="ap-signin">Sign in</button>` : ""}
        <div id="act-form"></div>
        <p class="note10">${s === "NEEDS_CALLBACK" ? "Approval opens once someone other than the preparer records the call-back." : "Only this action approves."} ${r.approvalsRequired > 1 ? "Two different approvers are required before release. " : ""}Reading this review does not approve or send a payment.</p>
        ${A.reject?.allowed ? `<button class="text-btn danger" data-act="reject">Reject payment</button>` : ""}
        <div class="divider"></div>
        <a class="text-btn" href="#/payments">← All payments</a>
        <p class="note10">ISO 20022 instruction: <a href="/ui/requests/${esc(r.id)}/iso20022" download>pain.001 ↓</a></p>
      </aside>
    </div>`);
  $$("[data-act]").forEach((x) => x.onclick = () => act(r, x.dataset.act, P));
  $("#ap-signin")?.addEventListener("click", () => signIn(route));
  $("#approve")?.addEventListener("click", () => {
    if (!$("#ok").checked) { $("#act-form").innerHTML = `<p class="note11 bad">Tick the confirmation first.</p>`; return; }
    $("#approve").disabled = true; act(r, "approve", P);
  });
}

// ================================================================== PAYMENT TRACKING (Figma 58:3832)
async function pageTracking(P, id) {
  const r = REQS.find((x) => x.id === id);
  if (!r) { setCrumbs("Payments", id); docPage(P, `${docIntro("Payment", "")}${notice(`No payment request ${esc(id)} in this workspace.`, "warn")}<a class="text-btn" href="#/payments">← All payments</a>`); return; }
  const [t, q, audit] = await Promise.all([r.transferId ? api(`/transfers/${encodeURIComponent(r.transferId)}`).catch(() => null) : null,
    !r.transferId ? quoteTerms(r.intentId) : null, api("/audit").catch(() => ({ entries: [] }))]);
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
  if (r.releaseOnDelivery) push("Delivery confirmed", r.delivery?.at, r.delivery ? `${r.delivery.documentRef} · ${nameOf(r.delivery.by)}` : "Bill of lading or goods receipt", r.delivery ? "done" : s === "AWAITING_DELIVERY" ? "now" : "todo");
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
    AWAITING_DELIVERY: ["Approved. Release waits for receiving to confirm delivery.", ""], COMPLETED: [`Completed: recipient credit${completedAt ? ` and reconciliation recorded ${tUtc(completedAt)}` : " recorded"}.`, ""],
    PAUSED: [`Paused by your safety policy. ${r.note ?? ""}`, "warn"], FAILED: [`Check ${r.id}${r.transferId ? ` / ${r.transferId}` : ""} before any retry. ${r.note ?? ""} Do not submit again: a new request for this bill is blocked until this one is resolved.`, "warn"],
    REJECTED: [`Rejected by ${nameOf(r.rejected?.by)}: ${r.rejected?.why ?? ""}`, "warn"], REFUNDED: [r.note ?? "Refunded.", ""] }[s] ?? [r.note ?? statusText(s), ""];
  const acts = [["confirmDelivery", "Confirm delivery"], ["recheck", "Re-check and release"], ["refund", "Refund escrow"], ["reject", "Reject payment"]].filter(([k]) => A[k]?.allowed);
  docPage(P, `${docIntro(`Payment to ${shortName(r.supplier)}`, `${r.id} · ${refLabel(r)} · ${statusText(s)} snapshot`, `<button class="btn-line" id="refresh">Refresh status ${IC("refresh-cw", 15)}</button>`)}
    ${notice(esc(banner[0]), banner[1])}
    <div class="doc-cols">
      <section class="doc-main g20" aria-label="Payment progress">
        <div class="status-head"><span class="eyebrow">${esc((RAIL[r.provider] ?? r.provider).toUpperCase())}</span>${badge(statusText(s), reqBadgeKind(s))}</div>
        <div class="flow2"><div><span class="eyebrow">TOTAL DEBIT · ALL FEES INCLUDED</span><b class="serif32">${money(debit)}</b><small>${esc(srcAcct)}</small></div>
          ${IC("arrow-right-24", 24)}<div><span class="eyebrow">${credited ? "RECIPIENT CREDITED" : "ESTIMATED RECIPIENT AMOUNT"}</span><b class="serif32">${money(net)}</b><small>${esc(shortName(r.supplier))} · ${esc(r.ccy)} account ${esc(masked)}</small></div></div>
        <div class="divider"></div>
        <div class="tl2-head"><h3>Payment timeline</h3><span>✓ Recorded event   ○ Pending / forecast</span></div>
        <div class="tl2">${timeline}</div>
        <div class="divider"></div>
        <div class="breakdown"><h3>Transfer details</h3>
          <div class="pair">${detail("Requested delivery", esc(dUtcY(r.timing?.deadlineUtc)))}${detail(credited ? "Recipient credited" : "Estimated arrival", esc(credited ? tUtc(credited) : dUtcY(arrival)))}</div>
          <div class="pair">${detail("Fees included", esc(fees ?? "—"))}${detail("Conversion at approval", esc(conv ?? "—"))}</div>
          <p class="note10">${t?.approval ? `Approved ${esc(tUtc(t.approval.at))} under signed terms ${esc(t.termsHash.slice(0, 12))}…` : `Prepared ${esc(tUtc(r.preparedAt))}`}${t?.deadlineStatus ? ` · deadline ${esc(String(t.deadlineStatus).toLowerCase())}` : ""}. No additional recipient deductions assumed.</p></div>
      </section>
      <aside class="doc-aside w310" aria-label="Recipient and audit">
        <span class="eyebrow">RECIPIENT</span><h2 class="serif26">${esc(r.supplier)}</h2>
        <p class="note11">${esc([country && (COUNTRY[country] ?? country), r.ccy, masked].filter(Boolean).join(" · "))}</p>
        ${sup ? `<a class="text-btn" href="#/suppliers/${encodeURIComponent(sup.id)}">Manage supplier →</a>` : ""}
        <div class="divider"></div>
        ${detail("Source", esc(srcAcct))}${detail("Purpose", esc(r.purpose ?? "—"))}
        <div class="divider"></div>
        <span class="eyebrow">AUDIT SNAPSHOT</span><p class="t11">${esc(mine.length ? tUtc(mine[0].at) : tUtc(new Date().toISOString()))}</p>
        <p class="note11">${mine.length} audit entr${mine.length === 1 ? "y" : "ies"} · ${done} recorded timeline event${done === 1 ? "" : "s"}${completedAt ? "" : ". No settlement or reconciliation event yet"}. Hash chain ${audit.verify?.ok ? "verified" : "not verified"}.</p>
        <button class="text-btn" id="export-audit">Export audit trail ↓</button>
        ${acts.length ? `<div class="divider"></div><span class="eyebrow">ACTIONS</span><div class="acts2">${acts.map(([k, l]) => `<button class="${k === "reject" ? "btn-line danger" : "btn-solid"}" data-act="${k}">${esc(l)}</button>`).join("")}</div>` : ""}
        <div id="act-form"></div>
        <div class="divider"></div>
        <span class="eyebrow">NEED AN UPDATE?</span>
        <p class="t11">If status is uncertain, check ${esc(r.id)}${r.transferId ? ` and ${esc(r.transferId)}` : ""} before retrying. Do not submit another payment to resolve a delay.</p>
        <a class="btn-line" href="#/activity">View activity log</a>
        <p class="note10">Instruction: <a href="/ui/requests/${esc(r.id)}/iso20022" download>pain.001 ↓</a>${r.proof ? ` · <a href="${esc(r.proof)}" target="_blank" rel="noopener">settlement proof ↗</a>` : ""}${r.escrow?.lockTx ? ` · escrow ${txLink(r.escrow, r.escrow.lockTx)}` : ""}. ${t?.receipt ? "Receipt recorded with the transfer." : "Receipt available only after confirmed settlement."}</p>
      </aside>
    </div>`);
  $("#refresh").onclick = () => route();
  $("#export-audit").onclick = () => download(`route402-audit-${r.id}.json`, JSON.stringify({ request: r.id, transfer: r.transferId ?? null, chainVerified: !!audit.verify?.ok, exportedAt: new Date().toISOString(), entries: mine }, null, 2), "application/json");
  $$("[data-act]").forEach((x) => x.onclick = () => act(r, x.dataset.act, P));
  if (["READY", "EXECUTING"].includes(s) || r.escrow?.state === "LOCKING") POLL = setTimeout(route, 2500);
}
