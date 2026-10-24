// Route402 workspace, structured as the Figma FinalUI: Overview, Payments (create -> compare -> review -> submitted ->
// tracking), Suppliers (+ details), Activity. Talks only to the router's local /ui/* API.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (s) => Number(String(s ?? "").split(" ")[0]);
const fmt = (n, dp = 2) => Number(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const money = (s, dp = 2) => { if (s == null || s === "") return "-"; const [n, c] = String(s).split(" "); return isNaN(Number(n)) ? esc(s) : `${fmt(n, dp)}${c ? ` ${c}` : ""}`; };
const usd = (x, dp = 0) => `${fmt(x, dp)} USD`;
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "-");
const dayY = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "-");
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-");
const utc = (iso) => (iso ? `${new Date(iso).toISOString().slice(11, 16)} UTC` : "-");
const COUNTRY = { DE: "Germany", CA: "Canada", MX: "Mexico", SG: "Singapore", GB: "United Kingdom", VN: "Vietnam", CN: "China", US: "United States", IN: "India", PL: "Poland" };
const BARS = ["var(--bar1)", "var(--bar2)", "var(--bar3)", "var(--bar4)", "var(--bar5)", "var(--bar6)"];
const RAIL = { stablecoin: "Our stablecoin rail", bank: "Your bank wire", tokenized_deposit: "Tokenized deposit" };
const RAIL_SUB = { stablecoin: "USDC to the supplier's wallet · 24/7", bank: "International wire from your own bank", tokenized_deposit: "Your bank on a tokenized-deposit network" };

async function api(path, body) {
  const r = await fetch(`/ui${path}`, body !== undefined ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.status && !j.requests) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
let STATE = null, ME = null, USERS = [], POLICY = null, REQS = [];
const nameOf = (id) => (id === "system" ? "Route402" : USERS.find((u) => u.id === id)?.name ?? id);
const billOf = (id) => STATE?.bills.find((b) => b.id === id);
const reqFor = (billId) => REQS.find((r) => r.payable === billId && !["REJECTED", "REFUNDED"].includes(r.status));

// The payment being prepared (survives a reload in this tab; the page works without it)
let DRAFT = {};
try { DRAFT = JSON.parse(sessionStorage.getItem("r402-draft") ?? "{}"); } catch {}
const saveDraft = () => { try { sessionStorage.setItem("r402-draft", JSON.stringify(DRAFT)); } catch {} };

// ------------------------------------------------------------------ shell
const head = (title, sub, extra = "") => `<div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>
  <div class="snap"><span class="chip-tag">TESTNET DEMO</span><small>${new Date().toUTCString().slice(0, 22)} UTC</small>${extra}</div></div>
  <div class="notice wide">${STATE?.connected ? `Connected: ${esc(STATE.source.replace("Nessie customer", "Capital One ·"))} · ` : "Demo company data · "}Testnet money only · Supplier payouts simulated · x402 and escrow transactions are real testnet or local-chain transactions</div>`;
const steps = (n) => `<div class="steps3">${["Payment details", "Compare routes", "Review & approve"].map((t, i) =>
  `<div class="${i + 1 === n ? "on" : ""}"><b>${i + 1 < n ? "✓" : `0${i + 1}`}</b>${esc(t)}</div>`).join("")}</div>`;
const foot = () => `<div class="foot2"><span>Route 402 · ${esc(STATE?.company ?? "")}</span><span>All timestamps UTC · Testnet only · <a href="#" data-sources>sources</a></span></div>`;
const pill = (k, t) => `<span class="pill ${k}">${esc(t)}</span>`;
const statusText = (s) => ({ NEEDS_CALLBACK: "Call-back needed", AWAITING_APPROVAL: "Awaiting approval", AWAITING_DELIVERY: "Awaiting delivery", READY: "Releasing",
  PAUSED: "Paused", EXECUTING: "Processing", COMPLETED: "Completed", FAILED: "Needs attention", REJECTED: "Rejected", REFUNDED: "Refunded" })[s] ?? s;
const statusKind = (s) => ({ COMPLETED: "ok", FAILED: "bad", REJECTED: "bad", REFUNDED: "draft", EXECUTING: "info", READY: "info", AWAITING_DELIVERY: "info", PAUSED: "warn" })[s] ?? "warn";

function modal(html) { $("#modal-box").innerHTML = html; $("#modal").classList.remove("hidden"); }
const closeModal = () => $("#modal").classList.add("hidden");
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

async function loadAll() {
  const [s, m, r] = await Promise.all([api("/state"), api("/me"), api("/requests").catch(() => [])]);
  STATE = s; ME = m.user; USERS = m.users; POLICY = m.policy; REQS = r;
  $("#co-name").textContent = s.company.replace(/ Inc\.?$/, "");
  $("#co-sub").textContent = s.connected ? "Importer · bank connected" : "Importer · demo data";
  $("#who").innerHTML = ME ? `<b>${esc(ME.name.split(" ").map((x) => x[0]).join(""))} · ${esc(ME.name)}</b><span class="small">${esc(ME.title)}</span> · <button class="link" id="signout">Sign out</button>`
    : `<button class="link strong" id="signin">Sign in →</button>`;
  $("#signout")?.addEventListener("click", async () => { await api("/logout", {}); await route(); });
  $("#signin")?.addEventListener("click", () => signIn(route));
}

// ------------------------------------------------------------------ router
let POLL = null;
async function route() {
  clearTimeout(POLL);
  const [, page = "overview", a, b] = (location.hash || "#/overview").split(/[/?]/);
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  $$("#nav a").forEach((x) => x.classList.toggle("active", x.dataset.nav === page));
  try { await loadAll(); } catch (e) { $("#page").innerHTML = `<div class="alert bad">Router not reachable: ${esc(e.message)}</div>`; return; }
  const P = $("#page");
  if (page === "payments" && a === "new") return pageCreate(P, q);
  if (page === "payments" && a === "compare") return pageCompare(P);
  if (page === "payments" && a === "review") return pageReview(P);
  if (page === "payments" && a === "submitted") return pageSubmitted(P, b);
  if (page === "payments" && a) return pageTracking(P, a);
  if (page === "payments") return pagePayments(P);
  if (page === "suppliers" && a) return pageSupplier(P, a);
  if (page === "suppliers") return pageSuppliers(P);
  if (page === "activity") return pageActivity(P);
  return pageOverview(P);
}
window.addEventListener("hashchange", route);
document.addEventListener("click", (e) => { if (e.target.closest("[data-sources]")) { e.preventDefault(); showSources(); } });
setInterval(() => $$("[data-exp]").forEach((el) => {   // quote countdowns
  const s = Math.round((Date.parse(el.dataset.exp) - Date.now()) / 1000);
  el.textContent = s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left` : "expired";
  el.classList.toggle("expired", s <= 0);
}), 1000);

// ------------------------------------------------------------------ OVERVIEW (Figma "Payment workspace")
const usdOf = (b) => { const c = STATE.run.market?.corridors?.find((x) => x.pair.endsWith(`/${b.ccy}`)); return b.ccy === "USD" ? num(b.amount) : c ? num(b.amount) / Number(c.mid) : num(b.amount); };
const billStatus = (b) => {
  const r = reqFor(b.id);
  if (b.paid?.status === "COMPLETED" || r?.status === "COMPLETED") return ["ok", "Completed"];
  if (r) return [statusKind(r.status), statusText(r.status)];
  if (b.check === "BLOCK") return ["bad", "Fix bank details"];
  if (b.detailsChanged) return ["warn", "Bank details changed"];
  if (b.plan === "wallet only") return ["ok", "Pay from balance"];
  return ["ok", "Ready to pay"];
};
function pageOverview(P) {
  const s = STATE, run = s.run, bills = s.bills, vals = bills.map(usdOf), max = Math.max(...vals, 1);
  const xb = bills.filter((b) => b.ccy !== "USD" || b.country !== "US").length;
  P.innerHTML = `${head("Payment workspace", "Find a supplier. See your options. Choose the tradeoff.")}
  <section class="card"><div class="card-h"><span class="label">At a glance</span><span class="small muted">rates: ${esc(s.market.mode)} · ${when(s.market.loadedAt)}</span></div>
    <div class="glance">${[["Supplier payments", bills.length, `${xb} cross-border`], ["Cross-border volume", usd(num(run.crossBorderVolume)), "valued at mid-market"],
      ["Measured savings", usd(num(run.companyKeeps)), `${run.percent.keptOfFxVolume} after our fee, vs your bank`, "accent"], ["Stopped before sending", bills.filter((b) => b.check !== "OK").length, "bad or changed bank details"]]
      .map(([k, v, sub, cls]) => `<div><div class="label">${k}</div><div class="big ${cls ?? ""}">${esc(v)}</div><div class="small muted">${esc(sub)}</div></div>`).join("")}</div></section>
  <section class="card budget"><div class="budget-l"><span class="label">Payment budgets</span><h2>Where your budget goes</h2><p class="muted small">A clear view across ${bills.length} suppliers.</p>
      <div class="big">$${fmt(vals.reduce((a, b) => a + b, 0), 0)}</div><div class="small muted">Total USD at mid-market · before fees</div></div>
    <div class="budget-r"><div class="chart">${bills.map((b, i) => `<div class="col" title="${esc(b.supplier)}"><div class="val">$${vals[i] >= 1e6 ? `${(vals[i] / 1e6).toFixed(2)}M` : `${Math.round(vals[i] / 1000)}k`}</div>
      <div class="bar" style="height:${Math.max(2, (vals[i] / max) * 190)}px;background:${BARS[i % BARS.length]}"></div></div>`).join("")}</div>
      <div class="xlabels">${bills.map((b) => `<div>${esc(b.country)}<small>${esc(b.supplier.split(" ")[0])}</small></div>`).join("")}</div></div></section>
  <div class="work">
    <section><div class="list-h"><div><h2>Your supplier payments</h2><div class="small muted">${bills.length} bills · amounts in invoice currency</div></div><a class="btn primary sm" href="#/payments/new">New payment</a></div>
      <input class="search" id="search" placeholder="Search suppliers, invoices or countries" /><div class="paycards" id="cards"></div></section>
    <section>${safetyCard()}${fxCard()}${needsCard()}</section>
  </div>
  ${tokenizedCard()}${foot()}`;
  const cards = () => { const q = $("#search").value.trim().toLowerCase();
    const list = bills.filter((b) => !q || `${b.supplier} ${b.id} ${b.country} ${COUNTRY[b.country] ?? ""} ${b.ccy}`.toLowerCase().includes(q));
    $("#cards").innerHTML = list.map((b) => { const [k, t] = billStatus(b), r = reqFor(b.id);
      return `<a class="paycard" href="${r ? `#/payments/${r.id}` : b.check === "BLOCK" ? `#/suppliers/${b.id}` : `#/payments/new?bill=${b.id}`}" style="text-decoration:none">
        <div class="top"><span class="mono-chip">${esc(b.country)}</span><div><div class="name">${esc(b.supplier)}</div><div class="ref">${esc(b.id)}</div></div></div>
        <div class="where">${esc(COUNTRY[b.country] ?? b.country)} · ${esc(b.ccy)} · due ${day(b.dueUtc)}</div>
        <div class="amt">${money(b.amount)} <small>${esc(b.ccy)}</small></div>
        <div class="foot">${pill(k, t)}<span class="go">${r ? "Track →" : b.check === "BLOCK" ? "Fix details →" : "Compare →"}</span></div></a>`; }).join("")
      || `<div class="panel2 state"><span class="label accent">Empty search result</span><h2>No matching suppliers</h2><p>Try another search. Your ${bills.length} saved bills have not been removed.</p></div>`; };
  $("#search").addEventListener("input", cards); cards(); bindNeeds();
}
function safetyCard() {
  const u = STATE.usdc, p = u.peg, e = STATE.escrow, share = u.capUsd ? Math.min(100, (u.inFlightUsd / u.capUsd) * 100) : 0;
  return `<div class="card"><div class="card-h"><h2>Rail safety</h2>${pill(p.status === "ok" ? "ok" : p.status === "paused" ? "bad" : "warn", p.status === "ok" ? "USDC route open" : p.status === "paused" ? "USDC route paused" : "Price unknown")}</div>
    <div class="peg"><span class="small muted">USDC price${p.test ? " (test override)" : ""}</span><b>${p.price ? p.price.toFixed(4) : "-"} USD</b></div>
    <p class="small muted">${p.reason ? esc(p.reason) : `Within the ${p.bandPct}% band your policy allows.`} ${(p.sources ?? []).filter((x) => x.error).map((x) => `${esc(x.name)}: unavailable`).join("; ")}</p>
    <div class="peg" style="margin-top:12px"><span class="small muted">In flight or in escrow with Circle (USDC)</span><b>${usd(u.inFlightUsd)} of ${usd(u.capUsd)}</b></div>
    <div class="meter"><i class="${share > 90 ? "bad" : share > 70 ? "warn" : ""}" style="width:${share}%"></i></div>
    <div class="peg" style="margin-top:10px"><span class="small muted">Release-on-delivery escrow</span><b>${e.ready ? esc(e.chain) : "not reachable"}</b></div>
    <p class="small muted">${e.ready ? `Contract ${esc(String(e.contract).slice(0, 10))}… · locks ${esc(e.lockUsdc)} test USDC per payment` : esc(e.note ?? "")}</p></div>`;
}
function fxCard() {
  const rows = STATE.fxRisk ?? [], lim = POLICY.fxRiskLimitUsd;
  return `<div class="card"><div class="card-h"><h2>FX exposure on open bills</h2><span class="small muted">limit ${usd(lim)}</span></div>
    ${rows.length ? `<table class="tbl compact"><thead><tr><th>Currency</th><th>To buy</th><th>Days</th><th>95% move</th></tr></thead><tbody>${rows.map((r) => `<tr><td><b>${esc(r.ccy)}</b></td><td>${usd(r.exposureUsd)}</td><td>${r.days}</td>
      <td>${r.status === "no-history" ? `<span class="muted small">not computed</span>` : `${usd(r.riskUsd)} ${r.status === "over-limit" ? pill("warn", "over limit") : ""}<div class="note">${r.movePct.toFixed(2)}% move</div>`}</td></tr>`).join("")}</tbody></table>
      <p class="note" style="margin-top:8px">${rows.some((r) => r.status === "no-history") ? "Rate history unavailable here, so risk is not computed. Online, it uses about 120 days of ECB reference rates." : "From the daily volatility of ECB reference rates. It sizes risk; it is not a forecast."}
      ${rows.some((r) => r.status === "over-limit") ? " Over the limit: consider converting earlier or asking your bank for a forward on that currency." : ""}</p>`
      : `<p class="muted small">Nothing left to buy in foreign currency: open bills are covered by existing balances or paid in USD.</p>`}</div>`;
}
function needsCard() {
  const open = REQS.filter((r) => r.actions && Object.values(r.actions).some((a) => a.allowed));
  return `<div class="card"><div class="card-h"><h2>Needs you</h2></div>${ME ? (open.length ? open.map((r) => `<a class="check" href="#/payments/${r.id}" style="text-decoration:none;color:inherit">${pill("warn", statusText(r.status))}<div><b>${esc(r.supplier)}</b> · ${usd(r.debitUsd)}<div class="note">${esc(r.payable)}</div></div></a>`).join("")
    : `<p class="muted small">Nothing waiting on you.</p>`) : `<p class="muted small">Sign in to see what's waiting on you.</p><button class="btn sm" id="needs-signin">Sign in</button>`}</div>`;
}
const bindNeeds = () => $("#needs-signin")?.addEventListener("click", () => signIn(route));
function tokenizedCard() {
  const s = STATE, bills = s.bills, complete = bills.filter((b) => b.ready?.complete).length;
  const p = (st) => st === "planned" ? pill("draft", "When your bank joins") : st === "live" ? pill("ok", "Today · testnet") : pill("ok", "Today");
  return `<section class="card future"><span class="label accent">Built for what's next</span><h2>Ready for tokenized deposits</h2>
    <p class="lead">Banks are building shared ledgers where deposits settle 24/7 and money can be locked until a condition is met. Route402 keeps suppliers, approvals, conditions and records separate from the rail. When your bank opens one of these networks, you switch a rail on. Release on delivery already runs this way today, as a USDC escrow on our rail.</p>
    <div class="flow"><div class="box"><span class="label">Set up once</span><ul><li>Supplier records in ISO 20022 fields</li><li>Approval policy, roles and limits</li><li>Release conditions: who sets, proves, halts, disputes</li><li>Tamper-evident audit log</li></ul></div><div class="arrow">→</div>
      <div class="box r402"><span class="label">Route402 at release</span><ul><li>Same approval, any rail</li><li>Picks the rail by all-in cost, speed or risk</li><li>Hands over the same pain.001 message and condition</li></ul></div><div class="arrow">→</div>
      <div class="box">${(s.rails ?? []).map((x) => `<div class="rail"><div><b>${esc(x.label)}</b><small>${esc(x.conditional)}</small></div>${p(x.status)}</div>`).join("")}</div></div>
    <div class="ready"><div><span class="label">Supplier records complete</span><div class="big">${complete} of ${bills.length}</div><div class="small muted">have every field a rail needs</div></div>
      <div><span class="label">Portable conditions</span><div class="big">${REQS.filter((r) => r.condition).length}</div><div class="small muted">release-on-delivery records</div></div>
      <div><span class="label">Escrows on-chain</span><div class="big">${REQS.filter((r) => r.escrow && ["LOCKED", "RELEASED", "REFUNDED"].includes(r.escrow.state)).length}</div><div class="small muted">${esc(STATE.escrow.chain ?? "escrow not reachable")}</div></div></div>
    <div class="scroll"><table class="tbl"><thead><tr><th>Network</th><th>Where it stands</th></tr></thead><tbody>${(s.tokenizedNetworks ?? []).map((n) => `<tr><td><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.name)}</a></td><td>${esc(n.status)}</td></tr>`).join("")}</tbody></table></div>
    <p class="note" style="margin-top:10px">Not built: no tokenized-deposit network is connected, and no Quant Overledger API is used or imitated.</p></section>`;
}

// ------------------------------------------------------------------ PAYMENTS list
function pagePayments(P) {
  const started = new Set(REQS.filter((r) => !["REJECTED", "REFUNDED"].includes(r.status)).map((r) => r.payable));
  const open = STATE.bills.filter((b) => !started.has(b.id) && b.paid?.status !== "COMPLETED");
  P.innerHTML = `${head("Payments", "Every supplier payment, from draft to settlement.")}
    <div class="actionbar"><div class="mid"><b>${REQS.length} payment request(s) · ${open.length} open bill(s) not started</b><span>Prepared by one person, approved by another. Nothing moves until your controls are met.</span></div><a class="btn primary" href="#/payments/new">New payment</a></div>
    <div class="panel2 scroll"><span class="label accent">Payment requests</span>${REQS.length ? `<table class="tbl" style="margin-top:8px"><thead><tr><th>Reference</th><th>Supplier</th><th>Debit</th><th>Route</th><th>Status</th><th>Next step</th></tr></thead><tbody>
      ${REQS.map((r) => `<tr class="click" data-go="#/payments/${r.id}"><td><b>${esc(r.payable)}</b><div class="note mono">${esc(r.id)}</div></td><td>${esc(r.supplier)}</td><td>${usd(r.debitUsd, 2)}</td>
        <td>${esc(RAIL[r.provider] ?? r.provider)}${r.escrow ? `<div class="note">escrow ${esc(r.escrow.state.toLowerCase())}</div>` : ""}</td><td>${pill(statusKind(r.status), statusText(r.status))}</td><td class="note">${esc(nextStep(r))}</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted" style="margin-top:8px">No payment requests yet.</p>`}</div>
    <div class="panel2 scroll"><span class="label accent">Open bills</span><table class="tbl" style="margin-top:8px"><thead><tr><th>Invoice</th><th>Supplier</th><th>Amount</th><th>Due</th><th>Check</th><th></th></tr></thead><tbody>
      ${open.map((b) => `<tr><td><b>${esc(b.id)}</b></td><td>${esc(b.supplier)}</td><td>${money(`${b.amount} ${b.ccy}`)}</td><td>${day(b.dueUtc)}</td><td>${checkPill(b)}</td>
        <td>${b.check === "BLOCK" ? `<a href="#/suppliers/${b.id}">Fix details</a>` : `<a class="btn sm" href="#/payments/new?bill=${b.id}">Start</a>`}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">Every bill has a payment request.</td></tr>`}</tbody></table></div>${foot()}`;
  $$("[data-go]").forEach((tr) => tr.onclick = () => (location.hash = tr.dataset.go));
}
const checkPill = (b) => b.check === "BLOCK" ? pill("bad", "Blocked") : b.detailsChanged ? pill("warn", "Details changed") : b.check === "REVIEW" ? pill("warn", "Review") : pill("ok", "Verified");
function nextStep(r) {
  return ({ NEEDS_CALLBACK: "Someone other than the preparer calls the supplier on a number on file", AWAITING_APPROVAL: `${r.approvalsRequired - r.approvals.length} more approval(s)`,
    AWAITING_DELIVERY: r.escrow?.state === "LOCKED" ? "Funds in escrow: confirm delivery to release" : "Confirm delivery to release", READY: "Releasing", PAUSED: r.note ?? "Re-check",
    EXECUTING: "Settling", COMPLETED: "Done", FAILED: "Check the reference before any retry", REJECTED: "-", REFUNDED: "-" })[r.status] ?? "";
}

// ------------------------------------------------------------------ STEP 1: payment details
function pageCreate(P, q) {
  const startable = STATE.bills.filter((b) => b.check !== "BLOCK" && !reqFor(b.id) && b.paid?.status !== "COMPLETED");
  if (q.get("bill") && q.get("bill") !== DRAFT.billId) DRAFT = { billId: q.get("bill") };
  const d = DRAFT, b = billOf(d.billId);
  P.innerHTML = `${head("Create payment", "Choose the supplier and what this payment must achieve.")}${steps(1)}
  <div class="duo wide-left"><div class="panel2"><form class="form" id="f" novalidate>
      <div class="field2" id="ff-bill"><label for="bill">Saved supplier and invoice</label><select id="bill"><option value="">Choose a saved supplier</option>
        ${startable.map((x) => `<option value="${esc(x.id)}" ${x.id === d.billId ? "selected" : ""}>${esc(x.supplier)} · ${esc(x.id)} · ${money(`${x.amount} ${x.ccy}`)}</option>`).join("")}</select><span class="e"></span></div>
      <div class="field2"><label>Amount</label><div class="radio">
        <label class="${d.mode !== "budget" ? "on" : ""}"><input type="radio" name="mode" value="invoice" ${d.mode !== "budget" ? "checked" : ""}/> <span><b>Supplier receives the invoice amount</b><div class="note">Best for bills: you pay whatever the route costs; the supplier gets exactly the invoice.</div></span></label>
        <label class="${d.mode === "budget" ? "on" : ""}"><input type="radio" name="mode" value="budget" ${d.mode === "budget" ? "checked" : ""}/> <span><b>Send a fixed budget (USD)</b><div class="note">You fix the debit; the supplier receives what is left after fees and conversion.</div></span></label></div></div>
      <div class="field2 ${d.mode === "budget" ? "" : "hidden"}" id="ff-usd"><label for="usd">Total source debit · USD (fees included)</label><input id="usd" inputmode="decimal" value="${esc(d.budgetUsd ?? "")}" placeholder="0.00" /><span class="e"></span></div>
      <div class="field2"><label>From</label><input value="${esc(STATE.connected ? "Operating account (Capital One)" : "USD operating account (demo)")}" disabled /></div>
      <div class="field2" id="ff-purpose"><label for="purpose">Purpose</label><input id="purpose" value="${esc(d.purpose ?? "Invoice payment")}" placeholder="Enter purpose" /><span class="e"></span></div>
      <div class="field2" id="ff-due"><label for="due">Requested delivery</label><input id="due" type="date" value="${esc((d.due ?? b?.dueUtc ?? "").slice(0, 10))}" /><span class="h">Defaults to the invoice due date.</span><span class="e"></span></div>
      <label class="confirm"><input type="checkbox" id="deliver" ${d.deliver ? "checked" : ""}/> <span><b>Release only after delivery is confirmed</b> (bill of lading or goods receipt). On our stablecoin rail the money is locked in an on-chain escrow at approval: the supplier can see it is committed, and it is released on delivery or returned after ${POLICY.escrowDeadlineDays} days.</span></label>
    </form></div>
    <div class="panel2" id="sum">${createSummary(b)}</div></div>
  <div class="actionbar"><a class="btn" href="#/payments">← Back to payments</a><div class="mid"><b>Next: compare routes</b><span>Agents buy a paid quote from each rail and screen the supplier. Nothing is sent.</span></div><button class="btn primary" id="go">Continue to route comparison</button></div>${foot()}`;
  $("#bill").onchange = () => { DRAFT = { ...DRAFT, billId: $("#bill").value, due: undefined }; saveDraft(); pageCreate(P, new URLSearchParams()); };
  $$("[name=mode]").forEach((r) => r.onchange = () => { DRAFT.mode = r.value; saveDraft(); pageCreate(P, new URLSearchParams()); });
  $("#go").onclick = () => {
    const errs = {}, mode = $("[name=mode]:checked").value, usdV = Number($("#usd").value);
    if (!$("#bill").value) errs.bill = "Select a supplier to continue.";
    if (mode === "budget" && !(usdV > 0)) errs.usd = "Enter an amount greater than 0.00 USD.";
    if (!$("#purpose").value.trim()) errs.purpose = "Purpose is required.";
    if (!$("#due").value) errs.due = "Choose a requested delivery date.";
    $$(".field2").forEach((f) => { f.classList.remove("err"); const e = $(".e", f); if (e) e.textContent = ""; });
    for (const [k, m] of Object.entries(errs)) { const f = $(`#ff-${k}`); f?.classList.add("err"); if (f) $(".e", f).textContent = m; }
    if (Object.keys(errs).length) return;
    DRAFT = { billId: $("#bill").value, mode, budgetUsd: mode === "budget" ? usdV : undefined, purpose: $("#purpose").value.trim(), due: new Date(`${$("#due").value}T20:00:00Z`).toISOString(), deliver: $("#deliver").checked };
    saveDraft(); location.hash = "#/payments/compare";
  };
}
function createSummary(b) {
  if (!b) return `<span class="label accent">Supplier</span><p class="muted" style="margin-top:8px">Choose a saved supplier to see their details.</p>`;
  return `<span class="label accent">Saved supplier</span><h2 style="margin:6px 0">${esc(b.supplier)}</h2><div class="small muted">${esc(b.id)} · ${esc(COUNTRY[b.country] ?? b.country)} · ${esc(b.ccy)}</div>
    <div class="grid2x" style="margin-top:14px"><div class="kv2"><div class="k">INVOICE AMOUNT</div><div class="v">${money(`${b.amount} ${b.ccy}`)}</div></div><div class="kv2"><div class="k">DUE</div><div class="v">${dayY(b.dueUtc)}</div></div>
      <div class="kv2"><div class="k">PRE-SEND CHECK</div><div class="v">${checkPill(b)}</div></div><div class="kv2"><div class="k">ACCEPTS USDC</div><div class="v">${b.acceptsUsdc ? "Yes" : "No"}</div></div></div>
    ${b.issues.length ? `<div class="alert ${b.detailsChanged ? "warn" : "info"}">${esc(b.issues[0])}</div>` : ""}
    ${b.plan === "wallet only" ? `<div class="alert ok">This bill can be paid from the ${esc(b.ccy)} you already hold: no conversion is needed.</div>` : ""}
    ${b.ready && !b.ready.complete ? `<p class="note" style="margin-top:8px">Supplier record missing for some rails: ${esc(b.ready.missing.join(", "))}.</p>` : ""}`;
}

// ------------------------------------------------------------------ STEP 2: compare routes
let SORT = "cost";
async function pageCompare(P) {
  const d = DRAFT, b = billOf(d.billId);
  if (!b) { location.hash = "#/payments/new"; return; }
  const key = `${d.billId}|${d.mode}|${d.budgetUsd}|${d.due}`;
  if (DRAFT.key !== key) { DRAFT = { ...d, key, routes: null, agent: null, agentErr: null, selected: null }; saveDraft(); }
  renderCompare(P);
  if (!DRAFT.routes) {
    const qs = `?due=${encodeURIComponent(DRAFT.due)}${DRAFT.mode === "budget" ? `&mode=budget&usd=${DRAFT.budgetUsd}` : ""}`;
    try { DRAFT.routes = await api(`/routes/${encodeURIComponent(b.id)}${qs}`); saveDraft(); } catch (e) { DRAFT.routesErr = e.message; }
    renderCompare(P);
  }
  if (!DRAFT.agent && !DRAFT.agentErr) runAgents(P);
}
async function runAgents(P) {
  DRAFT.agentBusy = true; renderCompare(P);
  try {
    const a = await api("/review", { payable: DRAFT.billId, mode: DRAFT.mode, usd: DRAFT.budgetUsd, due: DRAFT.due, policy: SORT === "speed" ? "fastest" : "cheapest" });
    if (a.status === "error") throw new Error(a.error);
    DRAFT.agent = { ...a, decision: a.decisions?.[0] }; DRAFT.agentErr = null;
    if (!DRAFT.selected && DRAFT.agent.decision?.chosen) DRAFT.selected = DRAFT.agent.decision.chosen;
  } catch (e) { DRAFT.agentErr = e.message; }
  DRAFT.agentBusy = false; saveDraft();
  if (location.hash.startsWith("#/payments/compare")) renderCompare(P);
}
function ranked() {
  const R = DRAFT.routes; if (!R) return [];
  const ok = R.routes.filter((r) => r.status === "OK"), budget = DRAFT.mode === "budget";
  const k = { cost: (r) => r.economics.allInUsd, recipient: (r) => (budget ? -num(r.supplierGets) : num(r.youPay)), speed: (r) => Date.parse(r.arrivalUtc) };
  return [...ok.sort((a, c) => k[SORT](a) - k[SORT](c)), ...R.routes.filter((r) => r.status !== "OK")];
}
function renderCompare(P) {
  const d = DRAFT, b = billOf(d.billId), R = d.routes, list = ranked(), ok = list.filter((r) => r.status === "OK");
  const agentPick = d.agent?.decision?.chosen, rec = ok.find((r) => r.provider === agentPick) ?? ok[0];
  if (!d.selected && rec) d.selected = rec.provider;
  const sel = ok.find((r) => r.provider === d.selected), budget = d.mode === "budget";
  const card = (r) => {
    if (r.provider === "tokenized_deposit") return `<div class="rcard off"><div class="lbl">NOT AVAILABLE YET</div><div class="nm">${RAIL.tokenized_deposit}</div><div class="st">${pill("draft", "Planned")}<span>no quote</span></div>
      <div class="cmp">${esc(r.reason)}</div><hr/><div class="kv2"><div class="k">SETTLEMENT</div><div class="v">Designed for 24/7</div></div><div class="kv2"><div class="k">RELEASE CONDITION</div><div class="v">Locked and released on the ledger</div></div>
      <div class="rel">When your bank joins a network, this route turns on and your approvals, conditions and supplier records carry over.</div></div>`;
    if (r.status !== "OK") return `<div class="rcard off"><div class="lbl">${r.provider === "stablecoin" && /paused|cap/i.test(r.reason ?? "") ? "PAUSED BY YOUR SAFETY POLICY" : "NO QUOTE"}</div><div class="nm">${RAIL[r.provider]}</div>
      <div class="st">${pill(/paused|cap/i.test(r.reason ?? "") ? "warn" : "draft", /paused|cap/i.test(r.reason ?? "") ? "Paused" : "Unavailable")}</div><div class="cmp warn">${esc(r.reason)}</div></div>`;
    const e = r.economics, x = r.breakdown, isSel = r.provider === d.selected, isRec = r === rec;
    const opt = d.agent?.decision?.options?.find((o) => o.provider === r.provider);
    const vsRec = rec && r !== rec ? (budget ? num(r.supplierGets) - num(rec.supplierGets) : e.allInUsd - rec.economics.allInUsd) : 0;
    return `<div class="rcard ${isSel ? "sel" : ""}"><div class="lbl">${isRec ? "RECOMMENDED FOR THIS PAYMENT" : opt?.intentId ? "PAID QUOTE · X402" : "ROUTER QUOTE"}</div><div class="nm">${RAIL[r.provider]}</div>
      <div class="st">${isSel ? pill("ok", "✓ Selected") : pill("draft", "Available")}<span>Expires ${utc(r.expiresAt)} · <span data-exp="${esc(r.expiresAt)}"></span></span></div>
      <div class="fig"><div class="k">${budget ? "NET RECIPIENT AMOUNT" : "TOTAL SOURCE DEBIT · FEES INCLUDED"}</div><div class="v">${money(budget ? r.supplierGets : r.youPay)}</div></div>
      <div class="cmp ${isRec ? "good" : ""}">${isRec ? (SORT === "speed" ? "Fastest arrival among available routes." : "Lowest all-in cost within your requested delivery.") : budget ? `${fmt(Math.abs(vsRec))} ${esc(b.ccy)} ${vsRec < 0 ? "less" : "more"} for the supplier than the recommended route.` : `${usd(Math.abs(vsRec), 2)} ${vsRec > 0 ? "more" : "less"} all-in than the recommended route.`}</div><hr/>
      <div class="row2"><span>Transfer fee</span><b>${usd(x.transferFeeUsd, 2)}</b></div>${x.payoutFeeUsd ? `<div class="row2"><span>Payout fee</span><b>${usd(x.payoutFeeUsd, 2)}</b></div>` : ""}
      <div class="row2"><span>Conversion cost vs mid-market</span><b>${usd(x.conversionCostUsd, 2)}</b></div><div class="row2 total"><span>Total fees · included</span><b>${usd(e.pricedUsd, 2)}</b></div>
      <div class="row2"><span>Converted principal</span><b>${usd(x.convertedPrincipalUsd, 2)}</b></div><hr/>
      <div class="kv2"><div class="k">EXECUTABLE RATE</div><div class="v">${b.ccy === "USD" ? "No conversion (USD)" : `1 USD = ${Number(r.fxRate).toFixed(4)} ${esc(b.ccy)}`}</div></div>
      <div class="kv2"><div class="k">ESTIMATED SETTLEMENT</div><div class="v">${e.transitDays < 0.05 ? "Minutes · 24/7" : `${dayY(r.arrivalUtc)} (${e.transitDays.toFixed(1)} days)`}</div></div>
      <div class="cmp ${e.meetsDeadline ? "" : "warn"}">${e.meetsDeadline ? `Send by ${when(e.sendBy)} · meets requested delivery` : "May exceed the requested delivery date"}</div><hr/>
      <div class="row2"><span>Cost of sending early</span><b>${usd(e.sendingEarlyUsd, 2)}</b></div><div class="note">${e.transitDays.toFixed(1)} days in transit × your ${e.costOfCashPct}% cost of cash</div>
      <div class="row2 total"><span>All-in cost</span><b>${usd(e.allInUsd, 2)}</b></div><hr/>
      <div class="elig">✓ Eligible · ${r.provider === "stablecoin" ? "supplier accepts USDC" : "saved receiving details"}${opt ? ` · agent risk ${opt.risk}/5` : ""}</div>
      <div class="rel">Historical reliability: not available. No verified provider performance history.</div>
      ${isSel ? `<button class="btn primary select" disabled>✓ ${RAIL[r.provider]} selected</button>` : `<button class="btn select" data-pick="${r.provider}">Select route</button>`}</div>`;
  };
  const maxAll = Math.max(...ok.map((r) => r.economics.allInUsd), 1);
  const agentLine = d.agentBusy ? `<span class="spinner"></span>Agents are buying quotes and screening the supplier (x402)…`
    : d.agentErr ? `<span class="pill bad">Agents unavailable</span> ${esc(d.agentErr)} <button class="btn sm" id="retry-agents">Retry</button>`
    : d.agent ? `Agents bought ${d.agent.paidCalls?.length ?? 0} paid calls (${esc(d.agent.spentUsdc)} test USDC) · decision: <b>${esc(d.agent.decision?.decision ?? "-")}</b>${d.agent.decision?.decision === "review" ? " · call-back required after submission" : ""}` : "";
  P.innerHTML = `${head("Compare payment routes", "The same payment. A clearer view of every tradeoff.")}${steps(2)}
  <div class="panel2"><div class="summary"><div><div class="k">SAVED SUPPLIER · ${esc(b.id)}</div><div class="v">${esc(b.supplier)}</div></div>
      <div><div class="k">${budget ? "TOTAL SOURCE DEBIT · FEES INCLUDED" : "SUPPLIER RECEIVES"}</div><div class="v big2">${budget ? usd(d.budgetUsd, 2) : money(`${b.amount} ${b.ccy}`)}</div></div>
      <div><div class="k">FROM</div><div class="v">${esc(R?.sourceAccount ?? "USD operating account")}</div></div><div><div class="k">TO · REQUESTED DELIVERY</div><div class="v">${esc(b.ccy)} · ${esc(COUNTRY[b.country] ?? b.country)} · ${dayY(d.due)}</div></div></div>
    <p class="note" style="margin-top:8px">${esc(d.purpose)} · receiving account ${esc(R?.bill?.maskedAccount ?? "")}${d.deliver ? " · release on delivery" : ""}</p></div>
  <div class="ctrl"><div><h2>Choose what matters for this payment</h2><div class="small muted">${R ? `${ok.length} priced route(s) + tokenized status · captured ${utc(ok[0]?.capturedAt)} · valid until ${utc(ok[0]?.expiresAt)}` : "Loading quotes"}</div></div>
    <div class="sort">Sort by ${[["cost", "All-in cost"], ["recipient", budget ? "Recipient amount" : "Debit"], ["speed", "Speed"]].map(([k, t]) => `<button data-sort="${k}" class="${SORT === k ? "on" : ""}">${SORT === k ? "✓ " : ""}${t}</button>`).join("")}</div></div>
  <div class="notice wide" style="background:#fff">${agentLine || "&nbsp;"}</div>
  ${d.routesErr ? `<div class="alert bad">${esc(d.routesErr)}</div>` : !R ? `<div class="rcards">${[1, 2, 3].map(() => `<div class="skel"><i></i><i></i></div>`).join("")}</div>` : `<div class="rcards">${list.map(card).join("")}</div>`}
  ${R && sel ? `<div class="duo"><div class="panel2"><span class="label accent">Payment-specific recommendation</span><h2 style="margin:6px 0">Why this route?</h2>
      <p>${esc(RAIL[rec.provider])} ${SORT === "speed" ? "arrives first" : "has the lowest all-in cost"} for this payment: ${usd(rec.economics.allInUsd, 2)} including fees, conversion and the cost of sending early${rec.economics.meetsDeadline ? `, and it arrives by ${dayY(d.due)}` : ""}. It is recommended for this payment, not universally best.</p>
      ${d.agent?.decision?.reasons?.length ? `<ul class="reasons">${d.agent.decision.reasons.filter((x) => !x.startsWith("compared:")).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <div class="alert ok">Delivery is an estimate, not a guarantee. Your bank's cost uses its measured markup over mid-market; our rail uses sourced fees only.</div></div>
    <div class="panel2"><span class="label accent">Selected route · expanded breakdown</span><h2 style="margin:6px 0">Every dollar accounted for</h2>
      <div class="feebars"><span class="label accent">All-in cost · fees and spread + cost of sending early</span>${ok.map((r) => `<div class="fb"><span>${esc(RAIL[r.provider].replace("Our ", "").replace("Your ", ""))}</span>
        <div class="track"><div class="fill ${r.provider === d.selected ? "sel" : ""}" style="width:${(r.economics.pricedUsd / maxAll) * 100}%"></div><div class="fill early" style="left:${(r.economics.pricedUsd / maxAll) * 100}%;width:${(r.economics.sendingEarlyUsd / maxAll) * 100}%"></div></div><b>${usd(r.economics.allInUsd, 2)}</b></div>`).join("")}</div>
      <div class="formula2">${budget ? `(${fmt(d.budgetUsd)} − ${fmt(sel.economics.pricedUsd - sel.breakdown.conversionCostUsd)}) × ${Number(sel.fxRate).toFixed(4)} ≈ ${money(sel.supplierGets)}` : `${money(sel.youPay)} = ${money(`${b.amount} ${b.ccy}`)}${b.ccy === "USD" ? "" : ` ÷ ${Number(sel.fxRate).toFixed(4)}`} + ${fmt(sel.breakdown.transferFeeUsd + sel.breakdown.payoutFeeUsd)} fees`}</div>
      <p class="note">All-in ${usd(sel.economics.allInUsd, 2)} = ${usd(sel.economics.pricedUsd, 2)} fees and conversion vs mid-market + ${usd(sel.economics.sendingEarlyUsd, 2)} for ${sel.economics.transitDays.toFixed(1)} days of your cash in transit. No failure rate is assumed.</p></div></div>` : ""}
  <div class="actionbar"><a class="btn" href="#/payments/new">← Back to payment details</a>
    <div class="mid"><b>${sel ? `${RAIL[sel.provider]} selected · ${budget ? `${money(sel.supplierGets)} estimated` : `${money(sel.youPay)} debit`}` : "Select a route"}</b><span>Selection does not execute a payment. Review and deliberate approval come next.</span></div>
    <button class="btn primary" id="cont" ${canContinue() ? "" : "disabled"}>Continue to review →</button></div>${foot()}`;
  $$("[data-pick]").forEach((x) => x.onclick = () => { DRAFT.selected = x.dataset.pick; saveDraft(); renderCompare(P); });
  $$("[data-sort]").forEach((x) => x.onclick = () => { SORT = x.dataset.sort; renderCompare(P); });
  $("#retry-agents")?.addEventListener("click", () => { DRAFT.agentErr = null; runAgents(P); });
  $("#cont")?.addEventListener("click", () => { location.hash = "#/payments/review"; });
}
function chosenDecision() {
  const dec = DRAFT.agent?.decision; if (!dec || !["approve", "review"].includes(dec.decision)) return null;
  const opt = dec.options?.find((o) => o.provider === DRAFT.selected && o.intentId);
  const intentId = DRAFT.selected === dec.chosen ? dec.intentId : opt?.intentId;
  if (!intentId) return null;
  return { ...dec, chosen: DRAFT.selected, intentId, routeIds: opt?.routeIds ?? dec.routeIds,
    reasons: DRAFT.selected === dec.chosen ? dec.reasons : [`preparer chose ${RAIL[DRAFT.selected]} over the agent's pick (${RAIL[dec.chosen]})`, ...dec.reasons] };
}
const canContinue = () => !!chosenDecision() && DRAFT.routes?.routes?.some((r) => r.provider === DRAFT.selected && r.status === "OK");

// ------------------------------------------------------------------ STEP 3: review and approve
function pageReview(P) {
  const d = DRAFT, b = billOf(d.billId), r = d.routes?.routes?.find((x) => x.provider === d.selected && x.status === "OK"), dec = chosenDecision();
  if (!b || !r || !dec) { location.hash = "#/payments/compare"; return; }
  const expired = Date.now() > Date.parse(r.expiresAt), e = r.economics, x = r.breakdown, budget = d.mode === "budget";
  const twoApprovals = num(r.youPay) > POLICY.dualApprovalOverUsd, escrow = d.deliver && r.provider === "stablecoin";
  P.innerHTML = `${head("Review and approve", "One final check before this payment goes to your approvers.")}${steps(3)}
  ${expired ? `<div class="panel2 state"><span class="label accent">Blocked approval · ${utc(new Date().toISOString())}</span><h2>Quote expired</h2>${pill("warn", "Expired")}
      <p class="small muted" style="margin:8px 0">Captured ${utc(r.capturedAt)}; expired ${utc(r.expiresAt)}. Refresh and review the new quote before submitting. Your payment details are kept.</p>
      <button class="btn primary" id="refresh">Refresh quotes</button></div>`
    : `<div class="notice wide">Quote valid for <b data-exp="${esc(r.expiresAt)}"></b> · captured ${utc(r.capturedAt)} · expires ${utc(r.expiresAt)}. Submitting is unavailable after expiry until a new quote is reviewed.</div>`}
  <div class="duo wide-left"><div>
    <div class="panel2"><span class="label accent">Supplier &amp; payment</span><h2 style="margin:6px 0 10px">${esc(b.supplier)}</h2>
      <div class="flowbox"><div class="ends"><div><div class="label">Source debit</div><div class="v">${money(r.youPay)}</div></div><div><div class="label">${budget ? "Estimated recipient" : "Supplier receives"}</div><div class="v">${money(r.supplierGets)}</div></div></div>
        <div class="convline" style="justify-content:flex-start;gap:12px"><span class="mono-chip">${esc(b.country)}</span><div style="flex:1"><b>${esc(b.supplier)}</b><div class="note">${esc(b.id)} · ${esc(d.purpose)}</div></div><span class="pill draft">${utc(new Date().toISOString())}</span></div>
        <div class="row2"><span>Transfer fee</span><b>${usd(x.transferFeeUsd, 2)}</b></div><div class="row2"><span>Conversion cost vs mid-market</span><b>${usd(x.conversionCostUsd, 2)}</b></div>
        <div class="row2"><span>Total fees · included</span><b>${usd(e.pricedUsd, 2)}</b></div><div class="row2"><span>Converted principal</span><b>${usd(x.convertedPrincipalUsd, 2)}</b></div>
        <div class="label">Conversion</div><div class="convline"><span>${usd(x.convertedPrincipalUsd, 2)}</span><i>→</i><span>${b.ccy === "USD" ? "no conversion" : `1 USD = ${Number(r.fxRate).toFixed(4)} ${esc(b.ccy)}`}</span><b>${money(r.supplierGets)}</b></div></div>
      <div class="grid2x" style="margin-top:14px">
        <div class="kv2"><div class="k">DESTINATION</div><div class="v">${esc(COUNTRY[b.country] ?? b.country)} · ${esc(b.ccy)}</div></div><div class="kv2"><div class="k">RECEIVING DETAILS</div><div class="v">${esc(d.routes.bill.maskedAccount)}</div></div>
        <div class="kv2"><div class="k">SOURCE ACCOUNT</div><div class="v">${esc(d.routes.sourceAccount)}</div></div><div class="kv2"><div class="k">PURPOSE</div><div class="v">${esc(d.purpose)}</div></div>
        <div class="kv2"><div class="k">REQUESTED DELIVERY</div><div class="v">${dayY(d.due)}</div></div><div class="kv2"><div class="k">QUOTE CAPTURE</div><div class="v">${utc(r.capturedAt)}</div></div></div></div>
    <div class="rcard sel"><div class="lbl">SELECTED ROUTE</div><div class="nm">${RAIL[r.provider]}</div><div>${pill("ok", d.agent.decision.chosen === r.provider ? "Recommended for this payment" : "Chosen by you")} ${pill("ok", r.provider === "stablecoin" ? "Supplier accepts USDC" : "Saved receiving details")}</div>
      <div class="grid2x"><div class="kv2"><div class="k">ESTIMATED ARRIVAL</div><div class="v">${e.transitDays < 0.05 ? "Minutes · 24/7" : `${dayY(r.arrivalUtc)} · ${e.transitDays.toFixed(1)} days`}</div></div><div class="kv2"><div class="k">ALL-IN COST</div><div class="v">${usd(e.allInUsd, 2)}</div></div></div>
      <p class="small">Delivery is not guaranteed; verified historical reliability is not available.</p><a class="btn select" href="#/payments/compare">← Change route</a></div></div>
    <div><div class="panel2"><span class="label accent">Quote snapshot · ${utc(r.capturedAt)}</span><h2 style="margin:6px 0">Confirm the full cost</h2>
      <div class="row2"><span>Total fees · included</span><b>${usd(e.pricedUsd, 2)}</b></div><div class="row2"><span>Cost of sending early</span><b>${usd(e.sendingEarlyUsd, 2)}</b></div><div class="row2 total"><span>All-in cost</span><b>${usd(e.allInUsd, 2)}</b></div>
      <div class="label" style="margin-top:12px">${budget ? "Estimated recipient amount" : "Total source debit"}</div><div class="formula2" style="font-size:34px">${money(budget ? r.supplierGets : r.youPay)}</div>
      <p class="note">What happens after you submit:</p><ul class="reasons">
        ${dec.decision === "review" ? "<li>Bank details changed: someone other than you calls the supplier on a number already on file.</li>" : ""}
        <li>${twoApprovals ? `Two different approvers (over ${usd(POLICY.dualApprovalOverUsd)})` : "One approver other than you"}.</li>
        ${d.deliver ? `<li>${escrow ? `Funds lock in an on-chain escrow (${esc(STATE.escrow.chain ?? "escrow")}) at approval, and release when receiving confirms delivery.` : "Release waits until receiving confirms delivery."}</li>` : ""}
        ${r.provider === "stablecoin" ? `<li>The USDC route re-checks the peg (±${POLICY.depegBandPct}%) and the issuer cap right before sending.</li>` : ""}</ul>
      <label class="confirm" style="margin:12px 0"><input type="checkbox" id="ok" /> <span>I have checked the supplier, invoice, fees and delivery estimate. I understand this sends testnet money and a simulated payout only.</span></label>
      <button class="btn primary" id="submit" ${expired ? "disabled" : ""}>Submit for approval</button><div id="sub-err"></div>
      <p class="note" style="margin-top:8px">Viewing this screen or choosing a route never submits a payment. Only a deliberate submission starts the approval.</p></div>
      <p class="note">${ME ? `Preparer: ${esc(ME.name)} · ${esc(ME.title)}. Recorded in the audit history.` : "Sign in to submit."}</p></div></div>
  <div><a class="btn" href="#/payments/compare">← Back to route comparison</a></div>${foot()}`;
  $("#refresh")?.addEventListener("click", () => { DRAFT.key = null; saveDraft(); location.hash = "#/payments/compare"; });
  $("#submit")?.addEventListener("click", async () => {
    if (!ME) return signIn(() => pageReview(P));
    if (!$("#ok").checked) { $("#sub-err").innerHTML = `<div class="alert warn">Tick the confirmation first.</div>`; return; }
    try {
      const out = await api("/requests", { decisions: [chosenDecision()], releaseOnDelivery: d.deliver ? [b.id] : [], confirmed: true, purpose: d.purpose, mode: d.mode });
      const one = out.requests?.[0]; if (!one?.requestId) throw new Error(one?.skipped ?? out.error ?? "not submitted");
      DRAFT = {}; saveDraft(); location.hash = `#/payments/submitted/${one.requestId}`;
    } catch (err) { $("#sub-err").innerHTML = `<div class="alert bad">${esc(err.message)}</div>`; }
  });
}

// ------------------------------------------------------------------ submitted
function pageSubmitted(P, id) {
  const r = REQS.find((x) => x.id === id); if (!r) { location.hash = "#/payments"; return; }
  P.innerHTML = `${head("Payment submitted", "Waiting for your approvers. Nothing has been sent yet.")}
  <div class="duo"><div class="panel2"><span class="label accent">Submission details</span><h2 style="margin:6px 0">${esc(r.supplier)}</h2>${pill(statusKind(r.status), statusText(r.status))}
      <div class="grid2x" style="margin-top:14px"><div class="kv2"><div class="k">PAYMENT REQUEST</div><div class="v mono">${esc(r.id)}</div></div><div class="kv2"><div class="k">INVOICE</div><div class="v">${esc(r.payable)}</div></div>
        <div class="kv2"><div class="k">ISO 20022 MESSAGE ID</div><div class="v mono">${esc(r.msgId ?? "-")}</div></div><div class="kv2"><div class="k">DEBIT</div><div class="v">${usd(r.debitUsd, 2)}</div></div></div>
      <div class="actions" style="margin-top:14px"><a class="btn primary" href="#/payments/${r.id}">Track payment</a><a class="btn" href="/ui/requests/${esc(r.id)}/iso20022" download>ISO 20022 file ↓</a><a class="btn ghost" href="#/payments">Back to payments</a></div></div>
    <div class="panel2"><span class="label accent">Payment context</span><h2 style="margin:6px 0">What happens next</h2><ul class="reasons">
      ${r.status === "NEEDS_CALLBACK" ? "<li>Call-back: an approver phones the supplier on a number already on file to confirm the new bank details.</li>" : ""}
      <li>${r.approvalsRequired} approval(s) from people other than ${esc(nameOf(r.preparedBy))}.</li>
      ${r.releaseOnDelivery ? `<li>${r.provider === "stablecoin" ? "Funds lock in escrow at approval; " : ""}release waits for receiving to confirm delivery.</li>` : ""}
      <li>Every step is written to the tamper-evident audit log.</li></ul></div></div>${foot()}`;
}

// ------------------------------------------------------------------ tracking
function pageTracking(P, id) {
  const r = REQS.find((x) => x.id === id); if (!r) { P.innerHTML = `${head("Payment", "")}<div class="alert bad">No such payment request.</div>`; return; }
  const s = r.status, ev = (t, cls, m) => `<div class="ev ${cls}"><div class="dot"></div><div><b>${t}</b><div class="m">${m ?? ""}</div></div></div>`;
  const evs = [ev("Prepared", "done", `${esc(nameOf(r.preparedBy))} · ${when(r.preparedAt)} · ${esc(r.purpose ?? "")}`)];
  if (r.detailsChanged) evs.push(ev("Call-back verified", r.callback ? "done" : s === "NEEDS_CALLBACK" ? "now" : "", r.callback ? `${esc(nameOf(r.callback.by))} · ${esc(r.callback.contact)} on ${esc(r.callback.phoneOnFile)}` : "verify the new bank details on a number already on file"));
  evs.push(ev(`Approved ${r.approvals.length}/${r.approvalsRequired}`, r.approvals.length >= r.approvalsRequired ? "done" : s === "AWAITING_APPROVAL" ? "now" : "", r.approvals.map((a) => `${esc(nameOf(a.by))} · ${when(a.at)}`).join("<br>")));
  if (r.escrow) evs.push(ev("Funds locked in escrow", ["LOCKED", "RELEASED", "REFUNDED"].includes(r.escrow.state) ? "done" : r.escrow.state === "FAILED" ? "bad" : "now",
    r.escrow.state === "FAILED" ? esc(r.escrow.error) : `${r.escrow.amountUsdc} test USDC · ${esc(r.escrow.chain)} · refundable after ${dayY(r.escrow.deadline)}${r.escrow.lockTx ? ` · ${txLink(r.escrow, r.escrow.lockTx)}` : ""}`));
  if (r.releaseOnDelivery) evs.push(ev("Delivery confirmed", r.delivery ? "done" : s === "AWAITING_DELIVERY" ? "now" : "", r.delivery ? `${esc(r.delivery.documentRef)} · ${esc(nameOf(r.delivery.by))} · ${when(r.delivery.at)}` : "bill of lading or goods receipt"));
  if (r.escrow?.state === "RELEASED") evs.push(ev("Escrow released to the supplier", "done", txLink(r.escrow, r.escrow.releaseTx)));
  if (r.escrow?.state === "REFUNDED") evs.push(ev("Escrow refunded to the company", "done", txLink(r.escrow, r.escrow.refundTx)));
  evs.push(ev("Sent", ["EXECUTING", "COMPLETED", "FAILED"].includes(s) ? "done" : ["READY", "PAUSED"].includes(s) ? "now" : "", r.transferId ? `<span class="mono">${esc(r.transferId)}</span>` : ""));
  evs.push(ev(s === "FAILED" ? "Needs attention" : "Completed", s === "COMPLETED" ? "done" : s === "FAILED" ? "bad" : s === "EXECUTING" ? "now" : "", r.proof ? `<a href="${esc(r.proof)}" target="_blank" rel="noopener">settlement proof ↗</a>` : ""));
  const A = r.actions ?? {}, btn = (k, label, cls = "primary") => A[k]?.allowed ? `<button class="btn sm ${cls}" data-act="${k}">${label}</button>` : "";
  const block = ME ? Object.entries(A).find(([k, v]) => !v.allowed && ["approve", "callback", "confirmDelivery"].includes(k) && !/not awaiting|no call-back|not waiting/.test(v.why ?? ""))?.[1]?.why : "Sign in to act on this payment.";
  P.innerHTML = `${head("Payment tracking", `${r.payable} · ${r.supplier}`)}
  <div class="duo wide-left"><div class="panel2"><div class="ctrl" style="margin:0 0 10px"><div>${pill(statusKind(s), statusText(s))} <span class="small muted">${esc(nextStep(r))}</span></div><span class="small muted mono">${esc(r.id)}</span></div>
      ${state(r)}<div class="tl">${evs.join("")}</div>
      <div class="actions">${btn("callback", "Record call-back")}${btn("approve", "Approve")}${btn("confirmDelivery", "Confirm delivery")}${btn("recheck", "Re-check and release")}${btn("refund", "Refund escrow", "")}${btn("reject", "Reject", "danger")}
        ${block && !["COMPLETED", "EXECUTING", "READY", "REJECTED", "REFUNDED", "FAILED"].includes(s) ? `<span class="why2">${esc(block)}</span>` : ""}</div><div id="act-form"></div></div>
    <div class="panel2"><span class="label accent">Payment details</span><h2 style="margin:6px 0">${usd(r.debitUsd, 2)}</h2><div class="small muted">${money(`${r.amount} ${r.ccy}`)} to ${esc(r.supplier)} · ${esc(RAIL[r.provider] ?? r.provider)}</div>
      <div class="grid2x" style="margin-top:12px"><div class="kv2"><div class="k">SUPPLIER RECEIVES</div><div class="v">${money(r.recipientGets)}</div></div><div class="kv2"><div class="k">ESTIMATED ARRIVAL</div><div class="v">${when(r.arrivalUtc)}</div></div>
        <div class="kv2"><div class="k">PURPOSE</div><div class="v">${esc(r.purpose ?? "-")}</div></div><div class="kv2"><div class="k">MESSAGE</div><div class="v"><a href="/ui/requests/${esc(r.id)}/iso20022" download>pain.001 ↓</a></div></div></div>
      ${r.condition ? `<div class="alert info"><b>Release condition</b>: ${esc(r.condition.proof.evidence.replaceAll("_", " "))}, confirmed by someone other than the preparer; haltable by ${esc(r.condition.haltableBy.join(" or "))}. ${r.escrow?.state === "LOCKED" || r.escrow?.state === "RELEASED" ? "Enforced on-chain by the escrow contract." : "Enforced by Route402 before sending."}</div>` : ""}
      <details class="sources" style="margin-top:10px"><summary>Why the agent chose this route</summary><ul>${(r.agentReasons ?? []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details></div></div>${foot()}`;
  $$("[data-act]").forEach((x) => x.onclick = () => act(r, x.dataset.act, P));
  if (["READY", "EXECUTING"].includes(s) || r.escrow?.state === "LOCKING") POLL = setTimeout(route, 2500);
}
const txLink = (e, tx) => (e.explorer && tx ? `<a href="${esc(e.explorer.replace(/0x[0-9a-f]+$/i, tx))}" target="_blank" rel="noopener">${esc(tx.slice(0, 12))}… ↗</a>` : `<span class="mono">${esc((tx ?? "").slice(0, 14))}…</span>`);
function state(r) {   // Figma supporting states, shown when they apply
  if (r.status === "PAUSED") return `<div class="alert warn"><b>Paused by your safety policy.</b> ${esc(r.note ?? "")}</div>`;
  if (r.status === "FAILED") return `<div class="alert bad"><b>Check ${esc(r.payable)} / ${esc(r.transferId ?? r.id)} before any retry.</b> ${esc(r.note ?? "")} If the status is uncertain, do not submit again: a new request for this bill is blocked until this one is resolved.</div>`;
  if (r.status === "REFUNDED") return `<div class="alert info">${esc(r.note ?? "Refunded.")}</div>`;
  if (r.note) return `<div class="alert info">${esc(r.note)}</div>`;
  if (r.detailsChanged && !r.callback) return `<div class="alert warn">${esc(r.detailsNote ?? "Bank details changed since the last payment.")} Call on a number from your vendor master, not one from the change request.</div>`;
  return "";
}
async function act(r, kind, P) {
  if (!ME) return signIn(route);
  const f = $("#act-form"), send = async (p, body) => { try { await api(`/requests/${r.id}/${p}`, body); await route(); } catch (e) { f.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; } };
  if (kind === "approve") return send("approve", {});
  if (kind === "recheck") return send("recheck", {});
  if (kind === "refund") return send("refund", {});
  const form = (fields, label, p, map, cls = "primary") => { f.innerHTML = `<div class="inline-form">${fields.map(([k, ph]) => `<input id="f-${k}" placeholder="${esc(ph)}" />`).join("")}<button class="btn sm ${cls}" id="f-go">${label}</button></div>`; $("#f-go").onclick = () => send(p, map()); };
  if (kind === "callback") form([["phone", "Number dialled (from your vendor master)"], ["who", "Who confirmed the new details"]], "Details confirmed", "callback", () => ({ phoneOnFile: $("#f-phone").value, contact: $("#f-who").value }));
  if (kind === "confirmDelivery") form([["doc", "Bill of lading or goods-receipt number"]], r.escrow?.state === "LOCKED" ? "Goods received: release escrow" : "Goods received: release", "delivery", () => ({ documentRef: $("#f-doc").value }));
  if (kind === "reject") form([["why", "Reason"]], "Reject payment", "reject", () => ({ why: $("#f-why").value }), "danger");
}

// ------------------------------------------------------------------ suppliers
let SUPF = { q: "", ccy: "", status: "" };
function pageSuppliers(P) {
  const bills = STATE.bills, ccys = [...new Set(bills.map((b) => b.ccy))];
  const list = bills.filter((b) => (!SUPF.q || `${b.supplier} ${b.id} ${COUNTRY[b.country] ?? b.country}`.toLowerCase().includes(SUPF.q.toLowerCase()))
    && (!SUPF.ccy || b.ccy === SUPF.ccy) && (!SUPF.status || (SUPF.status === "ok" ? b.check === "OK" : b.check !== "OK")));
  P.innerHTML = `${head("Suppliers", "Bank details are checked before every payment and compared with the last details you paid.")}
  <div class="stats4">${[["Suppliers", bills.length], ["Verified", bills.filter((b) => b.check === "OK").length], ["Need attention", bills.filter((b) => b.check !== "OK").length], ["Accept USDC", bills.filter((b) => b.acceptsUsdc).length]]
    .map(([k, v]) => `<div><div class="label">${k}</div><div class="big" style="font-size:30px">${v}</div></div>`).join("")}</div>
  <div class="panel2"><span class="label accent">Your supplier directory</span>
    <div class="filters"><input class="search" id="sq" style="margin:0;max-width:320px" placeholder="Search suppliers" value="${esc(SUPF.q)}" />
      ${["", ...ccys].map((c) => `<button data-ccy="${c}" class="${SUPF.ccy === c ? "on" : ""}">${c ? `Currency · ${c}` : "All currencies"}</button>`).join("")}
      ${[["", "Any status"], ["ok", "Verified"], ["attn", "Needs attention"]].map(([k, t]) => `<button data-st="${k}" class="${SUPF.status === k ? "on" : ""}">${t}</button>`).join("")}</div>
    ${list.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Supplier</th><th>Country</th><th>Paid in</th><th>Check</th><th>Open bill</th></tr></thead><tbody>
      ${list.map((b) => `<tr class="click" data-go="#/suppliers/${b.id}"><td><b>${esc(b.supplier)}</b><div class="note">${esc(b.id)}</div></td><td>${esc(COUNTRY[b.country] ?? b.country)}</td><td>${esc(b.ccy)}${b.acceptsUsdc ? `<div class="note">accepts USDC</div>` : ""}</td><td>${checkPill(b)}</td><td>${money(`${b.amount} ${b.ccy}`)}<div class="note">due ${day(b.dueUtc)}</div></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="state"><h2>Nothing matches these filters</h2><p>Try another search or clear the filters. Your ${bills.length} saved suppliers have not been removed.</p><div class="actions"><button class="btn primary" id="clear">Clear filters</button></div><p class="note">0 results</p></div>`}</div>${foot()}`;
  $("#sq").addEventListener("change", (e) => { SUPF.q = e.target.value; pageSuppliers(P); });
  $$("[data-ccy]").forEach((x) => x.onclick = () => { SUPF.ccy = x.dataset.ccy; pageSuppliers(P); });
  $$("[data-st]").forEach((x) => x.onclick = () => { SUPF.status = x.dataset.st; pageSuppliers(P); });
  $("#clear")?.addEventListener("click", () => { SUPF = { q: "", ccy: "", status: "" }; pageSuppliers(P); });
  $$("[data-go]").forEach((tr) => tr.onclick = () => (location.hash = tr.dataset.go));
}
function pageSupplier(P, id) {
  const b = billOf(id); if (!b) { location.hash = "#/suppliers"; return; }
  const reqs = REQS.filter((r) => r.supplier === b.supplier || r.payable === b.id), tx = STATE.transfers.filter((t) => t.supplier === b.supplier || t.reference === b.id);
  P.innerHTML = `${head(b.supplier, `${COUNTRY[b.country] ?? b.country} · paid in ${b.ccy}`)}
  <div class="actions" style="margin-bottom:14px"><a class="btn" href="#/suppliers">← All suppliers</a></div>
  <div class="duo"><div class="panel2"><span class="label accent">Supplier profile</span><div class="top" style="display:flex;gap:12px;align-items:center;margin:10px 0"><span class="mono-chip">${esc(b.country)}</span><div><h2>${esc(b.supplier)}</h2><div class="small muted">${esc(COUNTRY[b.country] ?? b.country)}</div></div></div>
      <div class="grid2x"><div class="kv2"><div class="k">PRE-SEND CHECK</div><div class="v">${checkPill(b)}</div></div><div class="kv2"><div class="k">ACCEPTS USDC</div><div class="v">${b.acceptsUsdc ? "Yes · 24/7, no intermediary banks" : "No · paid through your bank"}</div></div>
        <div class="kv2"><div class="k">RECORD COMPLETE FOR ALL RAILS</div><div class="v">${b.ready?.complete ? "Yes" : `Missing: ${esc((b.ready?.missing ?? []).join(", "))}`}</div></div><div class="kv2"><div class="k">ROUTE IN THE PLAN</div><div class="v">${esc(b.plan ?? "-")}</div></div></div>
      ${b.issues.length ? `<div class="alert ${b.check === "BLOCK" ? "bad" : "warn"}">${b.issues.map(esc).join("<br>")}</div>` : `<p class="note" style="margin-top:10px">Account format and checksum pass; details match the last payment.</p>`}
      ${b.detailsChanged ? `<div class="alert warn">Changed bank details are the most common setup for payment fraud against companies. Payments are held until someone other than the preparer calls the supplier on a number already on file.</div>` : ""}</div>
    <div class="panel2"><span class="label accent">Supplier payment context</span><h2 style="margin:6px 0">Open bill</h2><div class="row2"><span>${esc(b.id)}</span><b>${money(`${b.amount} ${b.ccy}`)}</b></div><div class="row2"><span>Due</span><b>${dayY(b.dueUtc)}</b></div>
      <div class="actions" style="margin-top:12px">${b.check === "BLOCK" ? `<span class="why2">Fix the bank details in your accounting system and re-import before paying.</span>` : reqFor(b.id) ? `<a class="btn" href="#/payments/${reqFor(b.id).id}">Track payment</a>` : `<a class="btn primary" href="#/payments/new?bill=${b.id}">Start payment</a>`}</div></div></div>
  <div class="panel2 scroll"><span class="label accent">Recent transactions</span>${reqs.length || tx.length ? `<table class="tbl" style="margin-top:8px"><thead><tr><th>Reference</th><th>Debit</th><th>Status</th><th>When</th></tr></thead><tbody>
    ${reqs.map((r) => `<tr class="click" data-go="#/payments/${r.id}"><td>${esc(r.payable)}<div class="note mono">${esc(r.id)}</div></td><td>${usd(r.debitUsd, 2)}</td><td>${pill(statusKind(r.status), statusText(r.status))}</td><td>${when(r.preparedAt)}</td></tr>`).join("")}
    ${tx.filter((t) => !reqs.some((r) => r.transferId === t.transferId)).map((t) => `<tr><td>${esc(t.reference ?? "-")}<div class="note mono">${esc(t.transferId)}</div></td><td>${money(t.debit)}</td><td>${pill(t.status === "COMPLETED" ? "ok" : "warn", t.status)}</td><td>-</td></tr>`).join("")}</tbody></table>`
    : `<p class="muted" style="margin-top:8px">No payments to this supplier yet.</p>`}</div>${foot()}`;
  $$("[data-go]").forEach((tr) => tr.onclick = () => (location.hash = tr.dataset.go));
}

// ------------------------------------------------------------------ activity
async function pageActivity(P) {
  const [a, c] = await Promise.all([api("/audit"), api("/calls").catch(() => ({}))]);
  P.innerHTML = `${head("Activity", "Every sign-in, preparation, call-back, approval, escrow step and release, in order.")}
  <div class="duo wide-left"><div class="panel2 scroll"><div class="ctrl" style="margin-top:0"><span class="label accent">Payment events</span>${a.verify.ok ? pill("ok", `Log intact · ${a.verify.entries} entries verified`) : pill("bad", `Log altered at entry ${a.verify.brokenAt}`)}</div>
      <table class="tbl compact"><thead><tr><th>#</th><th>When</th><th>Who</th><th>Event</th><th>Detail</th></tr></thead><tbody>${a.entries.map((e) => `<tr><td class="mono">${e.seq}</td><td>${when(e.at)}</td><td>${esc(nameOf(e.actor))}</td><td><b>${esc(e.action.replaceAll("_", " "))}</b></td>
        <td class="note">${esc(e.detail)}<div class="mono">#${esc(e.hash.slice(0, 12))}</div></td></tr>`).join("") || `<tr><td colspan="5" class="muted">No activity yet</td></tr>`}</tbody></table></div>
    <div><div class="panel2"><span class="label accent">Reading the audit trail</span><h2 style="margin:6px 0">How to trust this log</h2><ul class="reasons">
        <li>Each entry stores the fingerprint (SHA-256) of the entry before it. Changing or deleting any past entry breaks every fingerprint after it, and the badge turns red.</li>
        <li>"Route402" entries are automatic: re-quotes, safety pauses, escrow locks and releases, settlement.</li><li>Escrow and x402 entries carry transaction hashes you can check on the chain they name.</li>
        <li>Known limit: whoever controls this server could rewrite the whole chain consistently. Anchoring the latest fingerprint on a public chain would close that gap.</li></ul></div>
      <div class="panel2 scroll"><span class="label accent">Data the agents paid for (x402)</span><p class="small muted">${esc(c.spentUsdc ? `${c.spentUsdc} of ${c.capUsdc} test USDC` : c.note ?? "")}</p>
        <table class="tbl compact"><tbody>${(c.calls ?? []).slice(-15).reverse().map((x) => `<tr><td>${new Date(x.at).toLocaleTimeString()}</td><td>${esc(x.service)}</td><td>${x.transaction ? `<a class="mono" href="https://sepolia.basescan.org/tx/${esc(x.transaction)}" target="_blank" rel="noopener">${esc(x.transaction.slice(0, 10))}… ↗</a>` : esc(x.status)}</td></tr>`).join("") || `<tr><td class="muted">No paid calls yet</td></tr>`}</tbody></table></div></div></div>${foot()}`;
}

// ------------------------------------------------------------------ modals: sign-in, policy, connect, sources
function signIn(then) {
  modal(`<h2>Sign in</h2><p class="muted">Choose who you are. Every action is recorded under your name.</p>
    <div class="users">${USERS.map((u) => `<button data-u="${u.id}"><span class="mono-chip">${esc(u.name.split(" ").map((x) => x[0]).join(""))}</span>
      <span><b>${esc(u.name)}</b><div class="note">${esc(u.title)} · ${esc(u.roles.join(", "))}${u.approvalLimitUsd ? ` · limit ${usd(u.approvalLimitUsd)}` : u.roles.includes("approver") ? " · no limit" : ""}</div></span></button>`).join("")}</div>
    <div style="text-align:right"><button class="btn ghost" id="m-x">Cancel</button></div>`);
  $("#m-x").onclick = closeModal;
  $$(".users button").forEach((bt) => bt.onclick = async () => {
    const u = USERS.find((x) => x.id === bt.dataset.u), c = await api("/login/code", { userId: u.id });
    modal(`<h2>Verify it's you</h2><div class="dots"><span class="on"></span><span class="on"></span></div><p>We sent a 6-digit code to ${esc(c.sentTo)}.</p>
      <input class="code" id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" /><p class="note">Demo: your code is <b class="mono">${esc(c.demoCode)}</b>. In production it comes from an authenticator app or a hardware key.</p>
      <div id="code-err"></div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button class="btn ghost" id="m-x">Cancel</button><button class="btn primary" id="m-go">Verify</button></div>`);
    $("#m-x").onclick = closeModal; $("#code").focus();
    const go = async () => { try { await api("/login", { userId: u.id, code: $("#code").value }); closeModal(); await loadAll(); then ? then() : route(); } catch (e) { $("#code-err").innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; } };
    $("#m-go").onclick = go; $("#code").onkeydown = (e) => { if (e.key === "Enter") go(); };
  });
}
$("#open-policy").addEventListener("click", () => {
  const p = POLICY, admin = ME?.roles.includes("admin"), dis = admin ? "" : "disabled";
  const nf = (k, label, step = "1") => `<div class="field"><label class="label">${label}</label><input type="number" step="${step}" name="${k}" value="${p[k]}" ${dis} /></div>`;
  modal(`<h2>Policy &amp; people</h2><p class="muted small">Company settings, not market data. Only an admin can change them; every change is logged.</p>
    <form id="pol" style="margin-top:14px">${nf("dualApprovalOverUsd", "Two approvers above (USD)")}
      <div class="field"><label><input type="checkbox" name="requireCallbackOnDetailsChange" ${p.requireCallbackOnDetailsChange ? "checked" : ""} ${dis} /> Require a call-back when a supplier's bank details change</label></div>
      ${nf("requoteTolerancePct", "Re-approve if an expired quote moves more than (%)", "0.1")}${nf("depegBandPct", "Pause the USDC route if its price is further than (%) from 1.00", "0.1")}
      <div class="field"><label><input type="checkbox" name="depegFailClosed" ${p.depegFailClosed ? "checked" : ""} ${dis} /> Also pause it when no live USDC price can be read</label></div>
      ${nf("issuerCapUsd", "Most in flight or in escrow with one stablecoin issuer (USD)")}${nf("escrowDeadlineDays", "Escrow refundable after (days)")}${nf("fxRiskLimitUsd", "Flag a currency when its 95% FX move on open bills exceeds (USD)")}
      ${admin ? `<button class="btn primary sm">Save policy</button>` : `<p class="note">${ME ? "Only an admin can change the policy." : "Sign in as an admin to change it."}</p>`}<div id="pol-out"></div></form>
    <table class="tbl" style="margin-top:16px"><thead><tr><th>Person</th><th>Role</th><th>Limit</th></tr></thead><tbody>${USERS.map((u) => `<tr><td><b>${esc(u.name)}</b><div class="note">${esc(u.title)}</div></td><td>${esc(u.roles.join(", "))}</td>
      <td>${u.roles.includes("approver") ? (u.approvalLimitUsd ? usd(u.approvalLimitUsd) : "No limit") : "Cannot approve"}</td></tr>`).join("")}</tbody></table>
    <div style="text-align:right;margin-top:14px"><button class="btn ghost" id="m-x">Close</button></div>`);
  $("#m-x").onclick = closeModal;
  $("#pol").onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target), body = {};
    for (const k of ["dualApprovalOverUsd", "requoteTolerancePct", "depegBandPct", "issuerCapUsd", "escrowDeadlineDays", "fxRiskLimitUsd"]) body[k] = Number(f.get(k));
    body.requireCallbackOnDetailsChange = f.get("requireCallbackOnDetailsChange") === "on"; body.depegFailClosed = f.get("depegFailClosed") === "on";
    try { POLICY = await api("/policy", body); $("#pol-out").innerHTML = `<div class="alert ok">Saved and logged.</div>`; } catch (err) { $("#pol-out").innerHTML = `<div class="alert bad">${esc(err.message)}</div>`; } };
});
$("#open-connect").addEventListener("click", () => {
  modal(`<h2>Connect your bank</h2><div class="dots"><span class="on"></span><span></span><span></span></div>
    <p>Route402 will be able to:</p><ul class="perm"><li>Read account balances</li><li>Read bills and incoming deposits</li><li>Record payments your approvers release</li></ul>
    <p class="muted small">It cannot move money on its own. Works with any bank your bank can wire to, including smaller banks (often reached through intermediary banks). Demo source: Capital One Nessie sandbox (live API), or an accounting CSV.</p>
    <label class="label">Capital One customer ID (optional; blank = demo company)</label><input id="cust-id" style="width:100%;padding:10px;border:1px solid var(--line);border-radius:10px;margin:6px 0 14px" />
    <div style="display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap"><label class="btn sm">Upload CSV<input type="file" id="csv" accept=".csv,text/csv" hidden /></label>
      <span><button class="btn ghost" id="m-x">Cancel</button> <button class="btn primary" id="m-go">Allow and connect</button></span></div><div id="c-out"></div>`);
  $("#m-x").onclick = closeModal;
  $("#csv").onchange = async (e) => { const f = e.target.files[0]; if (!f) return;
    const r = await api("/connect", { provider: "csv", csv: await f.text() }).catch((err) => ({ ok: false, error: err.message }));
    $("#c-out").innerHTML = r.ok ? `<div class="alert ok">Imported ${r.imported.payables} bills and ${r.imported.receivables} deposits.</div>` : `<div class="alert bad">${esc(r.error)}</div>`; route(); };
  $("#m-go").onclick = async () => {
    modal(`<h2>Connecting</h2><div class="dots"><span class="on"></span><span class="on"></span><span></span></div><p><span class="spinner"></span>Importing accounts, bills and deposits…</p>`);
    try { const r = await api("/connect", { provider: "nessie", customerId: undefined }); if (!r.ok) throw new Error(r.error);
      modal(`<h2>Connected</h2><div class="dots"><span class="on"></span><span class="on"></span><span class="on"></span></div><p><b>${esc(r.source)}</b></p>
        <ul class="perm"><li>${r.imported.accounts} accounts · USD available ${money(r.usdAvailable, 0)}</li><li>${r.imported.payables} bills</li><li>${r.imported.receivables} deposits</li></ul><div style="text-align:right"><button class="btn primary" id="m-done">Done</button></div>`);
      $("#m-done").onclick = () => { closeModal(); DRAFT = {}; saveDraft(); location.hash = "#/overview"; route(); };
    } catch (err) { modal(`<h2>Could not connect</h2><div class="alert bad">${esc(err.message)}</div><div style="text-align:right;margin-top:12px"><button class="btn" id="m-x">Close</button></div>`); $("#m-x").onclick = closeModal; }
  };
});
function showSources() {
  modal(`<h2>Sources and what is simulated</h2><ul class="perm small">${Object.values(STATE.sources).map((x) => `<li>${esc(x)}</li>`).join("")}${(STATE.market.sources ?? []).map((x) => `<li>${esc(x)}</li>`).join("")}
    <li>USDC price: Coinbase and Kraken public tickers (cautious reading of the two).</li><li>FX risk: European Central Bank reference rates via Frankfurter.</li>
    <li>Simulated: supplier payouts of the full amount. Real: x402 payments on Base Sepolia, escrow transactions on ${esc(STATE.escrow.chain ?? "the escrow chain")}.</li></ul><div style="text-align:right"><button class="btn" id="m-x">Close</button></div>`);
  $("#m-x").onclick = closeModal;
}

route();
