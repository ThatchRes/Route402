// Chat is the front door. Payment records, supplier details and approval controls remain available alongside it.
// Talks only to the router's local /ui/* API.
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
let STATE = null, ME = null, USERS = [], POLICY = null, REQS = [], GROWTH = null;
const nameOf = (id) => (id === "system" ? "Route402" : USERS.find((u) => u.id === id)?.name ?? id);
const billOf = (id) => STATE?.bills.find((b) => b.id === id);
const reqFor = (billId) => REQS.find((r) => r.payable === billId && !["REJECTED", "REFUNDED"].includes(r.status));

// The payment being prepared (survives a reload in this tab; the page works without it)
let DRAFT = {};
try { DRAFT = JSON.parse(sessionStorage.getItem("r402-draft") ?? "{}"); } catch {}
const saveDraft = () => { try { sessionStorage.setItem("r402-draft", JSON.stringify(DRAFT)); } catch {} };

// ------------------------------------------------------------------ shell
const head = (title, sub, extra = "") => `<div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>
  ${extra ? `<div class="snap">${extra}</div>` : ""}</div>
  <div class="notice wide">${STATE?.connected ? "Connected to Capital One. " : "Demo company data. "}No real money moves: supplier payouts are simulated, and the agents pay for quotes with test tokens.</div>`;
const steps = (n) => `<div class="steps3">${["Payment details", "Compare routes", "Review & approve"].map((t, i) =>
  `<div class="${i + 1 === n ? "on" : ""}"><b>${i + 1 < n ? "✓" : `0${i + 1}`}</b>${esc(t)}</div>`).join("")}</div>`;
const foot = () => `<div class="foot2"><span>Route 402 · ${esc(STATE?.company ?? "")}</span><span>All timestamps UTC · Testnet only · <a href="#" data-sources>sources</a></span></div>`;
const pill = (k, t) => `<span class="pill ${k}">${esc(t)}</span>`;
const initials = (name) => String(name ?? "").split(/\s+/).filter(Boolean).map((x) => x[0]).join("").slice(0, 2).toUpperCase();
const PAGE_LABEL = { chat: "Agent", payments: "Payments", suppliers: "Suppliers", activity: "Activity" };
const stamp = (d = new Date()) => `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} · ${d.toISOString().slice(11, 16)} UTC`;
// Workspace header: company / section / (conversation). The mode badge reflects the router's real mode.
function setCrumbs(...parts) {
  const co = STATE?.company?.replace(/ Inc\.?$/, "") ?? "Route402";
  $("#crumbs").textContent = [co, parts.filter(Boolean).join(" / ")].join("   /   ");
}
function shellStatus() {
  if (!STATE) return;
  $("#mode-badge").textContent = STATE.localSimulation ? "SIMULATED DEMO" : STATE.connected ? "TESTNET · BANK CONNECTED" : "TESTNET DEMO";
  $("#side-note").textContent = STATE.localSimulation ? "Local simulation workspace" : "Testnet workspace";
}
const tickClock = () => { $("#clock").textContent = stamp(); };
tickClock(); setInterval(tickClock, 30_000);
function setSide(open) {
  document.body.classList.toggle("side-hidden", !open);
  $("#toggle-side").setAttribute("aria-expanded", String(open)); $("#toggle-side").setAttribute("aria-label", open ? "Hide sidebar" : "Show sidebar");
  try { localStorage.setItem("r402-side", open ? "open" : "hidden"); } catch {}
}
try { if (localStorage.getItem("r402-side") === "hidden") setSide(false); } catch {}
$("#toggle-side").addEventListener("click", () => setSide(document.body.classList.contains("side-hidden")));
const statusText = (s) => ({ NEEDS_CALLBACK: "Call-back needed", AWAITING_APPROVAL: "Awaiting approval", AWAITING_DELIVERY: "Awaiting delivery", READY: "Releasing",
  PAUSED: "Paused", EXECUTING: "Processing", COMPLETED: "Completed", FAILED: "Needs attention", REJECTED: "Rejected", REFUNDED: "Refunded" })[s] ?? s;
const statusKind = (s) => ({ COMPLETED: "ok", FAILED: "bad", REJECTED: "bad", REFUNDED: "draft", EXECUTING: "info", READY: "info", AWAITING_DELIVERY: "info", PAUSED: "warn" })[s] ?? "warn";

function modal(html) { $("#modal-box").innerHTML = html; $("#modal").classList.remove("hidden"); }
const closeModal = () => $("#modal").classList.add("hidden");
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

async function loadAll() {
  const [s, m, r] = await Promise.all([api("/state"), api("/me"), api("/requests").catch(() => [])]);
  STATE = s; ME = m.user; USERS = m.users; POLICY = m.policy; REQS = r;
  api("/growth").then((g) => { GROWTH = g; if (typeof renderPastPayments === "function") renderPastPayments(); }).catch(() => {});
  $("#co-name").textContent = s.company;
  $("#co-sub").textContent = s.connected ? "Manufacturer · bank connected" : "Manufacturer · demo data";
  $("#who").innerHTML = ME ? `<span class="avatar" aria-hidden="true">${esc(initials(ME.name))}</span><span class="id"><b>${esc(ME.name)}</b><span>${esc(ME.title)} · <button class="link" id="signout">Sign out</button></span></span>`
    : `<span class="avatar" aria-hidden="true">–</span><span class="id"><b>Not signed in</b><button class="link strong" id="signin">Sign in →</button></span>`;
  shellStatus();
  $("#signout")?.addEventListener("click", async () => { await api("/logout", {}); await route(); });
  $("#signin")?.addEventListener("click", () => signIn(route));
}

// ------------------------------------------------------------------ router
let POLL = null;
async function route() {
  clearTimeout(POLL);
  const [, page = "chat", a, b] = (location.hash || "#/chat").split(/[/?]/);
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const current = page === "overview" ? "chat" : page;
  $$(".side [data-nav]").forEach((x) => { x.classList.toggle("active", x.dataset.nav === current); x.toggleAttribute("aria-current", x.dataset.nav === current); });
  document.body.classList.toggle("chat-mode", page === "chat" || page === "overview");
  setCrumbs(PAGE_LABEL[current] ?? "Agent");
  if (page === "chat" || page === "overview") {
    pageChat($("#page"));
    loadAll().then(updateChatContext).catch(() => updateChatContext(false));
    return;
  }
  // Switching pages is instant once data has loaded: render from what is already here, then refresh in the background and
  // re-render only if something changed (and not while the person is typing in a field on this page).
  const hash = location.hash, render = () => renderPage($("#page"), page, a, b, q);
  if (!STATE) {
    try { await loadAll(); } catch (e) { $("#page").innerHTML = `<div class="alert bad">Router not reachable: ${esc(e.message)}</div>`; return; }
    return render();
  }
  const before = JSON.stringify([STATE, REQS, ME, POLICY]);
  render();
  loadAll().then(() => {
    if (location.hash !== hash || JSON.stringify([STATE, REQS, ME, POLICY]) === before) return;
    if ($("#page").contains(document.activeElement) && document.activeElement.matches("input, textarea, select")) return;
    render();
  }).catch(() => {});
}
function renderPage(P, page, a, b, q) {
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
// Payments can also be made outside this tab (another tab, or ASI:One): refresh the chat page's payment list and savings card.
const onChat = () => /^#\/(chat|overview)?$/.test(location.hash || "#/chat");
const refreshChatData = () => { if (onChat() && document.visibilityState === "visible") loadAll().catch(() => {}); };
document.addEventListener("visibilitychange", refreshChatData);
setInterval(refreshChatData, 20_000);
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
    <div id="portfolio"></div><div id="acct-summary"></div>
    <div class="actionbar"><div class="mid"><b>${REQS.length} payment request(s) · ${open.length} open bill(s) not started</b><span>Prepared by one person, approved by another. Nothing moves until your controls are met.</span></div><a class="btn primary" href="#/payments/new">New payment</a></div>
    <div class="panel2 scroll"><span class="label accent">Payment requests</span>${REQS.length ? `<table class="tbl" style="margin-top:8px"><thead><tr><th>Reference</th><th>Supplier</th><th>Debit</th><th>Route</th><th>Status</th><th>Next step</th></tr></thead><tbody>
      ${REQS.map((r) => `<tr class="click" data-go="#/payments/${r.id}"><td><b>${esc(r.payable)}</b><div class="note mono">${esc(r.id)}</div></td><td>${esc(r.supplier)}</td><td>${usd(r.debitUsd, 2)}</td>
        <td>${esc(RAIL[r.provider] ?? r.provider)}${r.escrow ? `<div class="note">escrow ${esc(r.escrow.state.toLowerCase())}</div>` : ""}</td><td>${pill(statusKind(r.status), statusText(r.status))}</td><td class="note">${esc(nextStep(r))}</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted" style="margin-top:8px">No payment requests yet.</p>`}</div>
    <div class="panel2 scroll"><span class="label accent">Open bills</span><table class="tbl" style="margin-top:8px"><thead><tr><th>Invoice</th><th>Supplier</th><th>Amount</th><th>Due</th><th>Check</th><th></th></tr></thead><tbody>
      ${open.map((b) => `<tr><td><b>${esc(b.id)}</b></td><td>${esc(b.supplier)}</td><td>${money(`${b.amount} ${b.ccy}`)}</td><td>${day(b.dueUtc)}</td><td>${checkPill(b)}</td>
        <td>${b.check === "BLOCK" ? `<a href="#/suppliers/${b.id}">Fix details</a>` : `<a class="btn sm" href="#/payments/new?bill=${b.id}">Start</a>`}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">Every bill has a payment request.</td></tr>`}</tbody></table></div>${foot()}`;
  $$("[data-go]").forEach((tr) => tr.onclick = () => (location.hash = tr.dataset.go));
  accountingSummary();
  // savings across all payments: paid so far plus open bills projected (the payment pages show one payment each)
  Promise.all([api("/growth").catch(() => null), api("/impact").catch(() => null)]).then(([g, imp]) => {
    GROWTH = g ?? GROWTH; const el = $("#portfolio"); if (el && location.hash.startsWith("#/payments")) el.innerHTML = portfolioPanel(g, imp);
  });
}
const checkPill = (b) => b.check === "BLOCK" ? pill("bad", "Blocked") : b.detailsChanged ? pill("warn", "Details changed") : b.check === "REVIEW" ? pill("warn", "Review") : pill("ok", "Verified");
function nextStep(r) {
  return ({ NEEDS_CALLBACK: "Someone other than the preparer calls the supplier on a number on file", AWAITING_APPROVAL: `${r.approvalsRequired - r.approvals.length} more approval(s)`,
    AWAITING_DELIVERY: r.escrow?.state === "LOCKED" ? "Funds in escrow: confirm delivery to release" : "Confirm delivery to release", READY: "Releasing", PAUSED: r.note ?? "Re-check",
    EXECUTING: "Settling", COMPLETED: "Done", FAILED: "Check the reference before any retry", REJECTED: "-", REFUNDED: "-" })[r.status] ?? "";
}

// ------------------------------------------------------------------ STEP 1: payment details -> pageCreate in screens.js (Figma "Manual payment")

// ------------------------------------------------------------------ STEP 2: compare routes
let SORT = "cost";
async function pageCompare(P) {
  const d = DRAFT, b = billOf(d.billId);
  SORT = d.routingObjective === "fastest" ? "speed" : d.routingObjective === "cheapest" ? "recipient" : "cost";
  if (!b) { location.hash = "#/payments/new"; return; }
  const key = quoteKey(d);
  if (DRAFT.key !== key) { DRAFT = { ...d, key, routes: null, agent: null, agentErr: null, selected: null }; saveDraft(); }
  renderCompare(P);
  if (!DRAFT.routes) {
    const qs = `?due=${encodeURIComponent(DRAFT.due)}&objective=${DRAFT.routingObjective ?? "balanced"}${DRAFT.mode === "budget" ? `&mode=budget&usd=${DRAFT.budgetUsd}` : ""}`;
    try { const routes = await api(`/routes/${encodeURIComponent(b.id)}${qs}`); if (DRAFT.key !== key) return; DRAFT.routes = routes; saveDraft(); }
    catch (e) { if (DRAFT.key !== key) return; DRAFT.routesErr = e.message; }
    renderCompare(P);
  }
  if (!DRAFT.agent && !DRAFT.agentErr) runAgents(P);
}
// Agents for the draft (paid quotes + supplier screen); shared by the compare step and the Manual payment page
async function runAgents(P, render = renderCompare, page = "#/payments/compare") {
  const requestKey = DRAFT.key;
  DRAFT.agentBusy = true; render(P);
  try {
    const a = await api("/review", { payable: DRAFT.billId, mode: DRAFT.mode, usd: DRAFT.budgetUsd, due: DRAFT.due, policy: DRAFT.routingObjective ?? "balanced" });
    if (DRAFT.key !== requestKey) return;
    if (a.status === "error") throw new Error(a.error);
    DRAFT.agent = { ...a, decision: a.decisions?.[0] }; DRAFT.agentErr = null;
    if (!DRAFT.selected && DRAFT.agent.decision?.chosen) DRAFT.selected = DRAFT.agent.decision.chosen;
  } catch (e) { if (DRAFT.key !== requestKey) return; DRAFT.agentErr = e.message; }
  DRAFT.agentBusy = false; saveDraft();
  if (location.hash.startsWith(page)) render(P);
}
function ranked() {
  const R = DRAFT.routes; if (!R) return [];
  const ok = R.routes.filter((r) => r.status === "OK"), budget = DRAFT.mode === "budget";
  const k = { cost: (r) => r.economics.allInUsd, recipient: (r) => (budget ? -num(r.supplierGets) : num(r.youPay)), speed: (r) => Date.parse(r.arrivalUtc) };
  return [...ok.sort((a, c) => SORT === "recipient" ? k[SORT](a) - k[SORT](c) : compareRouteOptions(a, c, SORT === "speed" ? "fastest" : "balanced")), ...R.routes.filter((r) => r.status !== "OK")];
}
function renderCompare(P) {
  const d = DRAFT, b = billOf(d.billId), R = d.routes, list = ranked(), ok = list.filter((r) => r.status === "OK");
  const agentPick = d.agent?.decision?.chosen, rec = ok.find((r) => r.provider === agentPick) ?? ok[0];
  if (!d.selected && rec) d.selected = rec.provider;
  const sel = ok.find((r) => r.provider === d.selected), budget = d.mode === "budget";
  const card = (r) => {
    if (r.provider === "tokenized_deposit" && r.status !== "OK") return `<div class="rcard off"><div class="lbl">NOT SWITCHED ON</div><div class="nm">${RAIL.tokenized_deposit}</div><div class="st">${pill("draft", "Off")}<span>no quote</span></div>
      <div class="cmp">${esc(r.reason)}</div><hr/><div class="kv2"><div class="k">SETTLEMENT</div><div class="v">Designed for 24/7</div></div><div class="kv2"><div class="k">RELEASE CONDITION</div><div class="v">Locked and released on the ledger</div></div>
      <div class="rel">When your bank joins a network, this route turns on and your approvals, conditions and supplier records carry over.</div></div>`;
    if (r.status !== "OK") return `<div class="rcard off"><div class="lbl">${r.provider === "stablecoin" && /paused|cap/i.test(r.reason ?? "") ? "PAUSED BY YOUR SAFETY POLICY" : "NO QUOTE"}</div><div class="nm">${RAIL[r.provider]}</div>
      <div class="st">${pill(/paused|cap/i.test(r.reason ?? "") ? "warn" : "draft", /paused|cap/i.test(r.reason ?? "") ? "Paused" : "Unavailable")}</div><div class="cmp warn">${esc(r.reason)}</div></div>`;
    const e = r.economics, x = r.breakdown, isSel = r.provider === d.selected, isRec = r === rec;
    const opt = d.agent?.decision?.options?.find((o) => o.provider === r.provider);
    const vsRec = rec && r !== rec ? (budget ? num(r.supplierGets) - num(rec.supplierGets) : e.allInUsd - rec.economics.allInUsd) : 0;
    const passed = (r.compliance ?? []).filter((c) => c.status === "pass").length;
    return `<div class="rcard ${isSel ? "sel" : ""}"><div class="lbl">${isRec ? "RECOMMENDED FOR THIS PAYMENT" : opt?.intentId ? "PAID QUOTE · X402" : "ROUTER QUOTE"}</div><div class="nm">${r.provider === "tokenized_deposit" ? esc(r.routeLabel ?? RAIL.tokenized_deposit) : RAIL[r.provider]}</div>
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
      <div class="elig">✓ Eligible · ${r.provider === "stablecoin" ? "supplier accepts USDC" : r.provider === "tokenized_deposit" ? "bank deposit on your bank's ledger, 24/7" : "saved receiving details"}${opt ? ` · agent risk ${opt.risk}/5` : ""}</div>
      ${passed ? `<div class="elig" title="${esc((r.compliance ?? []).map((c) => `${c.label}: ${c.detail}`).join(" · "))}">✓ Compliance: ${passed} check${passed === 1 ? "" : "s"} passed</div>` : ""}
      ${exposureNote(r)}
      ${e.platformFeeUsd ? `<div class="row2"><span>Route402 fee (included in comparison)</span><b>${usd(e.platformFeeUsd, 2)}</b></div>` : ""}
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
  $$("[data-sort]").forEach((x) => x.onclick = () => { SORT = x.dataset.sort;
    DRAFT.routingObjective = SORT === "speed" ? "fastest" : SORT === "recipient" ? "cheapest" : "balanced";
    DRAFT.key = null; DRAFT.agentBusy = false; saveDraft(); pageCompare(P); });
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

// ------------------------------------------------------------------ STEP 3: review -> pageReview in screens.js (Figma "Review & approve")

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

// ------------------------------------------------------------------ tracking -> pageTracking / pageApprove in screens.js (Figma "Payment tracking", "Review & approve")
const txLink = (e, tx) => (e.explorer && tx ? `<a href="${esc(e.explorer.replace(/0x[0-9a-f]+$/i, tx))}" target="_blank" rel="noopener">${esc(tx.slice(0, 12))}… ↗</a>` : `<span class="mono">${esc((tx ?? "").slice(0, 14))}…</span>`);

async function act(r, kind, P) {
  if (!ME) return signIn(route);
  const f = $("#act-form"), send = async (p, body) => { try { await api(`/requests/${r.id}/${p}`, body); await route(); } catch (e) { f.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; } };
  if (kind === "approve") return send("approve", { alertsReviewed: !!$("#ok-alerts")?.checked });
  if (kind === "recheck") return send("recheck", {});
  if (kind === "refund") return send("refund", {});
  const form = (fields, label, p, map, cls = "primary") => { f.innerHTML = `<div class="inline-form">${fields.map(([k, ph]) => `<input id="f-${k}" placeholder="${esc(ph)}" />`).join("")}<button class="btn sm ${cls}" id="f-go">${label}</button></div>`; $("#f-go").onclick = () => send(p, map()); };
  if (kind === "callback") form([["phone", "Number dialled (from your vendor master)"], ["who", "Who confirmed the new details"]], "Details confirmed", "callback", () => ({ phoneOnFile: $("#f-phone").value, contact: $("#f-who").value }));
  if (kind === "confirmDelivery") form([["doc", "Bill of lading or goods-receipt number"]], r.escrow?.state === "LOCKED" ? "Goods received: release escrow" : "Goods received: release", "delivery", () => ({ documentRef: $("#f-doc").value }));
  if (kind === "presentDocuments") {
    const plats = STATE.documents?.platforms ?? [], insp = r.documentary?.terms?.documents?.includes("inspection_certificate");
    f.innerHTML = `<div class="inline-form docs-form"><input id="f-ebl" placeholder="eBL number, e.g. EBL-1A2B3C4D" /><select id="f-plat">${plats.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("")}</select>
      <input id="f-inv" placeholder="Commercial invoice number" value="${esc(r.reference)}" />${insp ? `<input id="f-insp" placeholder="Inspection certificate number" />` : ""}
      <button class="btn sm primary" id="f-go">Check documents</button><button class="btn sm ghost" id="f-demo" title="Demo only: a simulated carrier issues the eBL and endorses title to you">Simulate carrier eBL</button></div>`;
    $("#f-demo").onclick = async () => { try { const e = await api(`/requests/${r.id}/ebl-demo`, { platform: $("#f-plat").value }); $("#f-ebl").value = e.ref; if (e.inspectionRef && $("#f-insp")) $("#f-insp").value = e.inspectionRef; } catch (err) { f.insertAdjacentHTML("beforeend", `<div class="alert bad">${esc(err.message)}</div>`); } };
    $("#f-go").onclick = () => send("documents", { eblRef: $("#f-ebl").value, platform: $("#f-plat").value, invoiceRef: $("#f-inv").value, inspectionRef: $("#f-insp")?.value });
    return;
  }
  if (kind === "reject") form([["why", "Reason"]], "Reject payment", "reject", () => ({ why: $("#f-why").value }), "danger");
}

// ------------------------------------------------------------------ suppliers -> pageSuppliers in screens.js (Figma "Recipients")

// ------------------------------------------------------------------ activity
async function pageActivity(P) {
  const [a, c] = await Promise.all([api("/audit"), api("/calls").catch(() => ({}))]);
  P.innerHTML = `${head("Activity", "Every sign-in, preparation, call-back, approval, escrow step and release, in order.")}
  <div class="duo wide-left"><div class="panel2 scroll"><div class="ctrl" style="margin-top:0"><span class="label accent">Payment events</span>${a.verify.ok ? pill("ok", `Log intact · ${a.verify.entries} entries verified`) : pill("bad", `Log altered at entry ${a.verify.brokenAt}`)}</div>
      <table class="tbl compact"><thead><tr><th>#</th><th>When</th><th>Who</th><th>Event</th><th>Detail</th></tr></thead><tbody>${a.entries.map((e) => `<tr><td class="mono">${e.seq}</td><td>${when(e.at)}</td><td>${esc(nameOf(e.actor))}</td><td><b>${esc(e.action.replaceAll("_", " "))}</b></td>
        <td class="note">${esc(e.detail)}<div class="mono">#${esc(e.hash.slice(0, 12))}</div></td></tr>`).join("") || `<tr><td colspan="5" class="muted">No activity yet</td></tr>`}</tbody></table></div>
    <div>${alertsPanel()}<div class="panel2"><span class="label accent">Reading the audit trail</span><h2 style="margin:6px 0">How to trust this log</h2><ul class="reasons">
        <li>Each entry stores the fingerprint (SHA-256) of the entry before it. Changing or deleting any past entry breaks every fingerprint after it, and the badge turns red.</li>
        <li>"Route402" entries are automatic: re-quotes, safety pauses, escrow locks and releases, settlement.</li><li>Escrow and x402 entries carry transaction hashes you can check on the chain they name.</li>
        <li>Known limit: whoever controls this server could rewrite the whole chain consistently. Anchoring the latest fingerprint on a public chain would close that gap.</li></ul></div>
      <div class="panel2 scroll"><span class="label accent">Data the agents paid for (x402)</span><p class="small muted">${esc(c.spentUsdc ? `${c.spentUsdc} of ${c.capUsdc} test USDC` : c.note ?? "")}</p>
        <table class="tbl compact"><tbody>${(c.calls ?? []).slice(-15).reverse().map((x) => `<tr><td>${new Date(x.at).toLocaleTimeString()}</td><td>${esc(x.service)}</td><td>${x.transaction ? `<a class="mono" href="https://sepolia.basescan.org/tx/${esc(x.transaction)}" target="_blank" rel="noopener">${esc(x.transaction.slice(0, 10))}… ↗</a>` : esc(x.status)}</td></tr>`).join("") || `<tr><td class="muted">No paid calls yet</td></tr>`}</tbody></table></div></div></div>${foot()}`;
}

// Monitoring alerts across payment requests: review alerts the approver has not yet acknowledged come first
function alertsPanel() {
  const rows = REQS.filter((r) => r.alerts?.length).map((r) => ({ r, open: !r.alertsReviewed && r.alerts.some((a) => a.severity === "review") && !["REJECTED", "FAILED"].includes(r.status) }))
    .sort((a, b) => b.open - a.open).slice(0, 12);
  return `<div class="panel2 scroll"><span class="label accent">Monitoring alerts</span>
    <p class="small muted">Raised when a payment is prepared: new payee or country, changed bank details, repeated payments, amounts just under a threshold. An approver reviews each one; suspicious-activity reports go through the licensed partner.</p>
    <table class="tbl compact"><tbody>${rows.map(({ r, open }) => `<tr><td>${open ? pill("warn", "To review") : pill("ok", r.alertsReviewed ? "Reviewed" : "Noted")}</td>
      <td><a href="#/payments/${esc(r.id)}"><b>${esc(r.supplier)}</b></a><div class="note">${esc(r.alerts.map((a) => a.detail).join(" · "))}</div></td></tr>`).join("") || `<tr><td class="muted">No alerts</td></tr>`}</tbody></table></div>`;
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
      ${policyIssuerCaps(dis)}${nf("escrowDeadlineDays", "Escrow refundable after (days)")}${nf("fxRiskLimitUsd", "Flag a currency when its 95% FX move on open bills exceeds (USD)")}
      ${nf("lcFeePct", "Your bank's letter-of-credit fee (%), to compare document-checked payments against", "0.05")}
      ${policyTokenized(dis)}${policyCompliance(dis)}${policyAccounting(dis)}
      ${admin ? `<button class="btn primary sm">Save policy</button>` : `<p class="note">${ME ? "Only an admin can change the policy." : "Sign in as an admin to change it."}</p>`}<div id="pol-out"></div></form>
    <table class="tbl" style="margin-top:16px"><thead><tr><th>Person</th><th>Role</th><th>Limit</th></tr></thead><tbody>${USERS.map((u) => `<tr><td><b>${esc(u.name)}</b><div class="note">${esc(u.title)}</div></td><td>${esc(u.roles.join(", "))}</td>
      <td>${u.roles.includes("approver") ? (u.approvalLimitUsd ? usd(u.approvalLimitUsd) : "No limit") : "Cannot approve"}</td></tr>`).join("")}</tbody></table>
    <div style="text-align:right;margin-top:14px"><button class="btn ghost" id="m-x">Close</button></div>`);
  $("#m-x").onclick = closeModal;
  $("#kyb-save")?.addEventListener("click", async () => {
    const v = (n) => $(`[name="${n}"]`)?.value ?? "";
    try { await api("/kyb", { status: v("k_status"), provider: v("k_provider"), caseRef: v("k_case"), legalName: v("k_name"), registrationNumber: v("k_reg"), country: v("k_country"),
        street: v("k_street"), city: v("k_city"), postcode: v("k_post"), verifiedAt: v("k_date"), beneficialOwnersVerified: $("[name=k_ubo]").checked });
      await loadAll(); $("#kyb-out").innerHTML = `<div class="alert ok">KYB result recorded and logged.</div>`;
    } catch (err) { $("#kyb-out").innerHTML = `<div class="alert bad">${esc(err.message)}</div>`; }
  });
  $("#issuer-default").oninput = (e) => {
    $$("[data-issuer-cap]").forEach((input) => { input.placeholder = `Default: ${e.target.value}`; });
  };
  $("#pol").onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target), body = {};
    for (const k of ["dualApprovalOverUsd", "requoteTolerancePct", "depegBandPct", "issuerCapUsd", "escrowDeadlineDays", "fxRiskLimitUsd", "lcFeePct"]) body[k] = Number(f.get(k));
    body.issuerCapsUsd = {};
    e.target.querySelectorAll("[data-issuer-cap]").forEach((input) => {
      if (input.value.trim() !== "") body.issuerCapsUsd[input.dataset.issuerCap] = Number(input.value);
    });
    body.adaptiveExposure = { enabled: f.get("ax_enabled") === "on", issuerTreasuryPct: Number(f.get("ax_issuerTreasuryPct")),
      totalTreasuryPct: Number(f.get("ax_totalTreasuryPct")), liquidityUsePct: Number(f.get("ax_liquidityUsePct")), baseHours: Number(f.get("ax_baseHours")) };
    body.requireCallbackOnDetailsChange = f.get("requireCallbackOnDetailsChange") === "on"; body.depegFailClosed = f.get("depegFailClosed") === "on";
    body.tokenized = f.get("tk_network") ? { network: f.get("tk_network"), currencies: f.get("tk_currencies"), countries: f.get("tk_countries"), fxMarginBps: f.get("tk_fx"),
      feeUsd: f.get("tk_fee"), settlementMinutes: f.get("tk_minutes"), tariffSource: f.get("tk_source") } : null;
    body.compliance = { geniusEnforceFrom: f.get("c_from"), geniusPermittedTokens: f.get("c_tokens"), blockedCountries: f.get("c_blocked"),
      travelRuleThresholdUsd: Number(f.get("c_travel")), micaForEea: f.get("c_mica") === "on", requireWalletScreening: f.get("c_screen") === "on",
      requireNameScreening: f.get("c_names") === "on", requirePartnerAgreements: f.get("c_partners") === "on", requireKyb: f.get("c_kyb") === "on",
      partnerAgreements: Object.fromEntries([...e.target.querySelectorAll("[data-ramp]")].map((i) => [i.dataset.ramp, i.value.trim()]).filter(([, v]) => v)) };
    const acc = (k) => ({ code: f.get(`a_${k}_code`), name: f.get(`a_${k}_name`) });
    body.accounting = { chart: { cash: acc("cash"), ap: acc("ap"), bankFees: acc("bankFees"), fxGainLoss: acc("fxGainLoss") }, apMeasurement: f.get("a_measure"),
      variance: Object.fromEntries(["feeToleranceUsd", "fxDeviationBps", "beneficiaryTolerancePct", "unexplainedToleranceUsd", "settlementGraceHours"].map((k) => [k, Number(f.get(`v_${k}`))])) };
    try { POLICY = await api("/policy", body); await loadAll(); $("#pol-out").innerHTML = `<div class="alert ok">Saved and logged.</div>`; } catch (err) { $("#pol-out").innerHTML = `<div class="alert bad">${esc(err.message)}</div>`; } };
});
function policyIssuerCaps(dis) {
  const p = POLICY, groups = {};
  for (const [coin, info] of Object.entries(STATE?.compliance?.stablecoins ?? {})) (groups[info.issuer] ??= []).push(coin);
  return `<fieldset class="pol-sec issuer-caps"><legend>Stablecoin issuer limits</legend>
    <p class="note">Limit the money in flight or in escrow with each issuer. Coins from the same issuer share one limit.</p>
    <div class="field"><label class="label" for="issuer-default">Default limit per issuer (USD)</label>
      <input id="issuer-default" type="number" name="issuerCapUsd" min="0" max="${Number.MAX_SAFE_INTEGER}" step="0.01" required value="${p.issuerCapUsd}" ${dis} /></div>
    <details><summary>Set individual issuer limits</summary>
      <p class="note">Leave blank to use the default. Enter 0 to block new exposure. These limits are your company's risk settings.</p>
      <div class="issuer-cap-table"><table class="tbl compact"><thead><tr><th>Issuer / coins</th><th>Custom limit (USD)</th><th>In flight (USD)</th></tr></thead><tbody>
      ${Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([issuer, coins]) => `<tr>
        <td><b>${esc(issuer)}</b><div class="note">${esc(coins.join(", "))}</div></td>
        <td><input type="number" data-issuer-cap="${esc(issuer)}" aria-label="${esc(issuer)} custom limit in USD" min="0" max="${Number.MAX_SAFE_INTEGER}" step="0.01"
          value="${esc(p.issuerCapsUsd?.[issuer] ?? "")}" placeholder="Default: ${esc(p.issuerCapUsd)}" ${dis} /></td>
        <td>${fmt(STATE?.usdc?.byIssuer?.[issuer] ?? 0, 2)}</td></tr>`).join("")}
      </tbody></table></div></details>
    ${policyAdaptiveExposure(dis)}
    <p class="note">Routes use each issuer's remaining room. New limits apply to the next quote and release check.</p></fieldset>`;
}
function policyAdaptiveExposure(dis) {
  const p = POLICY.adaptiveExposure ?? { enabled: false, issuerTreasuryPct: 50, totalTreasuryPct: 75, liquidityUsePct: 80, baseHours: 24 };
  return `<details class="adaptive-policy"><summary>Adjust limits for each transfer</summary>
    <label class="note"><input type="checkbox" name="ax_enabled" ${p.enabled ? "checked" : ""} ${dis} /> Use adaptive exposure budgets</label>
    <p class="note">The issuer limits above remain hard ceilings. Budgets also account for treasury balance, committed transfers, settlement time and shared venue depth. These are company rules, not issuer safety ratings.</p>
    <div class="pol-grid">${[["issuerTreasuryPct", "Treasury share per issuer (%)", 100], ["totalTreasuryPct", "Treasury share across all stablecoins (%)", 100],
      ["liquidityUsePct", "Use at most this share of venue depth (%)", 100], ["baseHours", "Base settlement window (hours)", 168]].map(([key, label, max]) => `<div class="field"><label class="label" for="ax-${key}">${esc(label)}</label>
      <input id="ax-${key}" type="number" name="ax_${key}" min="1" max="${max}" step="1" required value="${p[key]}" ${dis} /></div>`).join("")}</div>
    <p class="note">A transfer taking twice the base window uses twice the exposure budget. Long escrow locks use their full lock window. Scheduled and unresolved transfers keep their budgets until resolved.</p></details>`;
}
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
// Policy sections: the bank's tokenized-deposit tariff, and the compliance rules the router enforces
function policyTokenized(dis) {
  const t = STATE?.tokenized ?? {}, c = t.config ?? {}, input = (n, v, ph, w = "") => `<input name="${n}" value="${esc(v ?? "")}" placeholder="${esc(ph)}" ${dis} style="${w}" />`;
  return `<fieldset class="pol-sec"><legend>Tokenized deposits at your bank</legend>
    <p class="note">A deposit token is an ordinary deposit at your bank that moves on its ledger 24/7. Turn it on with the tariff your bank gives you; Route402 never guesses a price.</p>
    <div class="field"><label class="label">Network</label><select name="tk_network" ${dis}><option value="">Off</option>${(t.catalog ?? []).map((n) => `<option value="${n.id}" ${c.network === n.id ? "selected" : ""}>${esc(n.label)} · ${esc(n.operator)}</option>`).join("")}</select></div>
    <div class="pol-grid">${[["tk_currencies", (c.currencies ?? []).join(", "), "Currencies, e.g. USD, EUR, GBP"], ["tk_countries", (c.countries ?? []).join(", "), "Supplier countries, e.g. DE, GB"],
      ["tk_fx", c.fxMarginBps, "FX margin (bps)"], ["tk_fee", c.feeUsd, "Fee per payment (USD)"], ["tk_minutes", c.settlementMinutes, "Settlement (minutes)"]].map(([n, v, ph]) => `<div class="field"><label class="label">${esc(ph)}</label>${input(n, v, ph)}</div>`).join("")}</div>
    <div class="field"><label class="label">Where the tariff comes from</label>${input("tk_source", c.tariffSource, "e.g. bank fee schedule, Oct 2026", "width:100%")}</div>
    ${(t.catalog ?? []).map((n) => `<p class="note">• <a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.label)}</a>: ${esc(n.status)}</p>`).join("")}</fieldset>`;
}
// Chart-of-accounts mapping and variance thresholds for payment accounting records (company/accounting.ts)
function policyAccounting(dis) {
  const A = POLICY.accounting ?? { chart: { cash: { code: "1010", name: "Operating cash" }, ap: { code: "2010", name: "Accounts payable" }, bankFees: { code: "6150", name: "Bank and transfer fees" },
    fxGainLoss: { code: "7910", name: "Realized FX gain/loss" } }, apMeasurement: "carrying_value", configured: false,
    variance: { feeToleranceUsd: 0, fxDeviationBps: 10, beneficiaryTolerancePct: 0.1, unexplainedToleranceUsd: 0.05, settlementGraceHours: 24 } };
  const row = (k, label) => `<div class="field"><label class="label">${esc(label)}</label><div class="acct-acc"><input name="a_${k}_code" value="${esc(A.chart[k].code)}" maxlength="20" aria-label="${esc(label)} code" ${dis} /><input name="a_${k}_name" value="${esc(A.chart[k].name)}" maxlength="80" aria-label="${esc(label)} name" ${dis} /></div></div>`;
  const v = (k, label, step) => `<div class="field"><label class="label">${esc(label)}</label><input type="number" min="0" step="${step}" name="v_${k}" value="${esc(A.variance[k])}" ${dis} /></div>`;
  return `<fieldset class="pol-sec"><legend>Payment accounting</legend>
    <p class="note">${A.configured ? `Mapping confirmed by ${esc(nameOf(A.configuredBy))} ${esc(when(A.configuredAt))}.` : "These account codes are illustrative. Saving the policy confirms them as your mapping."} Journal entries are accounting-ready for export; nothing is posted to your ledger.</p>
    <div class="pol-grid">${row("cash", "Cash account")}${row("ap", "Accounts payable")}${row("bankFees", "Bank and transfer fees")}${row("fxGainLoss", "Realized FX gain/loss")}</div>
    <div class="field"><label class="label">Foreign-currency bills are settled against</label><select name="a_measure" ${dis}>
      <option value="carrying_value" ${A.apMeasurement === "carrying_value" ? "selected" : ""}>Their booked AP carrying amount (realized FX gain/loss computed)</option>
      <option value="settlement_value" ${A.apMeasurement === "settlement_value" ? "selected" : ""}>Their value at payment (bill recognized at payment; no realized FX)</option></select></div>
    <div class="pol-grid">${v("feeToleranceUsd", "Flag fees above quote by more than (USD)", "0.01")}${v("fxDeviationBps", "Flag rate deviations above (bps)", "1")}
      ${v("beneficiaryTolerancePct", "Flag supplier amount differences above (%)", "0.01")}${v("unexplainedToleranceUsd", "Treat differences up to this as rounding (USD)", "0.01")}
      ${v("settlementGraceHours", "Flag no credit this long after estimated arrival (hours)", "1")}</div></fieldset>`;
}
// The partner of record runs KYB; an admin records its result here (Route402 never marks a company verified by itself)
function kybFields(dis) {
  const k = STATE?.compliance?.kyb ?? {}, p = STATE?.compliance?.policy ?? {}, a = k.address ?? {};
  const inp = (n, v, ph, extra = "") => `<div class="field"><label class="label">${esc(ph)}</label><input name="${n}" value="${esc(v ?? "")}" placeholder="${esc(ph)}" ${extra} ${dis} /></div>`;
  return `<div class="pol-sec" style="margin-top:10px"><b>Company verification (KYB)</b>
    <p class="note">${k.status ? `${esc(k.status === "verified" ? "Verified" : k.status === "pending" ? "Pending" : "Rejected")} by ${esc(k.provider)} · case ${esc(k.caseRef)} · recorded by ${esc(nameOf(k.recordedBy))} ${esc(when(k.recordedAt))}` : "No KYB result recorded. The licensed partner of record verifies the company, its beneficial owners and signers; record its result here."}</p>
    <div class="field"><label><input type="checkbox" name="c_kyb" ${p.requireKyb ? "checked" : ""} ${dis} /> Block new payment requests until a verified KYB result is recorded</label></div>
    <div class="pol-grid">
      <div class="field"><label class="label">Partner's result</label><select name="k_status" ${dis}>${["", "verified", "pending", "rejected"].map((x) => `<option value="${x}" ${k.status === x ? "selected" : ""}>${x || "Choose…"}</option>`).join("")}</select></div>
      ${inp("k_provider", k.provider, "KYB partner")}${inp("k_case", k.caseRef, "Partner case reference")}${inp("k_name", k.legalName, "Legal name")}
      ${inp("k_reg", k.registrationNumber, "Registration number (EIN or company no.)")}${inp("k_country", k.country, "Country of registration (2 letters)", 'maxlength="2"')}
      ${inp("k_street", a.street, "Registered street address")}${inp("k_city", a.city, "Town / city")}${inp("k_post", a.postcode, "Postcode")}
      <div class="field"><label class="label">Verified on</label><input type="date" name="k_date" value="${esc(k.verifiedAt ?? "")}" ${dis} /></div></div>
    <div class="field"><label><input type="checkbox" name="k_ubo" ${k.beneficialOwnersVerified ? "checked" : ""} ${dis} /> The partner verified the beneficial owners (25%+ owners and one controlling person)</label></div>
    ${dis ? "" : `<button type="button" class="btn sm" id="kyb-save">Record KYB result</button>`}<div id="kyb-out"></div></div>`;
}
function policyCompliance(dis) {
  const scr = STATE?.compliance?.screening ?? { mode: "none" };
  const p = STATE?.compliance?.policy ?? {}, input = (n, v, ph) => `<input name="${n}" value="${esc(v ?? "")}" placeholder="${esc(ph)}" ${dis} />`;
  return `<fieldset class="pol-sec"><legend>Compliance rules</legend>
    <p class="note">Checked before a route is quoted and again before money moves. These are company settings, not legal advice: have counsel confirm them.</p>
    <div class="pol-grid">
      <div class="field"><label class="label">GENIUS Act issuer rule applies from</label><input type="date" name="c_from" value="${esc(p.geniusEnforceFrom ?? "")}" ${dis} /></div>
      <div class="field"><label class="label">Stablecoins confirmed from permitted issuers</label>${input("c_tokens", (p.geniusPermittedTokens ?? []).join(", "), "e.g. USDC, EURC (once approved)")}</div>
      <div class="field"><label class="label">Sanctioned countries (no routes)</label>${input("c_blocked", (p.blockedCountries ?? []).join(", "), "CU, IR, KP")}</div>
      <div class="field"><label class="label">Travel Rule threshold (USD)</label>${input("c_travel", p.travelRuleThresholdUsd, "3000")}</div></div>
    <div class="field"><label><input type="checkbox" name="c_mica" ${p.micaForEea !== false ? "checked" : ""} ${dis} /> EU/EEA suppliers: only MiCA-authorized e-money tokens</label></div>
    <div class="field"><label><input type="checkbox" name="c_screen" ${p.requireWalletScreening !== false ? "checked" : ""} ${dis} /> Never pay a supplier wallet that could not be sanctions-screened</label></div>
    <div class="field"><label><input type="checkbox" name="c_names" ${p.requireNameScreening ? "checked" : ""} ${dis} /> Hold any payment whose supplier name could not be sanctions-screened</label>
      <p class="note">${scr.mode === "list" ? `Screening against ${fmt(scr.names, 0)} listed names loaded from the company's sanctions list files.` : scr.mode === "service" ? "Screening through the OpenSanctions match service." : "No sanctions list is loaded: set SANCTIONS_LIST_PATH to OFAC's SDN.CSV (and ALT.CSV, CONS_PRIM.CSV) or OPENSANCTIONS_API_KEY. Until then every payment shows “not screened”."}</p></div>
    <div class="field"><label><input type="checkbox" name="c_partners" ${p.requirePartnerAgreements ? "checked" : ""} ${dis} /> Use a stablecoin payout only through an operator we have a signed agreement with</label></div>
    <div class="pol-grid">${(STATE?.compliance?.offramps ?? []).map((o) => `<div class="field"><label class="label">${esc(o.label)}</label><input data-ramp="${esc(o.id)}" value="${esc(p.partnerAgreements?.[o.id] ?? "")}" placeholder="Licensed operator and agreement ref" maxlength="120" ${dis} /></div>`).join("")}</div>
    ${kybFields(dis)}
    <p class="note"><a href="/ui/compliance/tax-report.csv" download>Download the digital-asset tax report (CSV) ↓</a> · fields for Form 1099-DA and CARF/DAC8 reporting</p></fieldset>`;
}
function showSources() {
  modal(`<h2>Sources and what is simulated</h2><ul class="perm small">${Object.values(STATE.sources).map((x) => `<li>${esc(x)}</li>`).join("")}${(STATE.market.sources ?? []).map((x) => `<li>${esc(x)}</li>`).join("")}
    <li>USDC price: Coinbase and Kraken public tickers (cautious reading of the two).</li><li>FX risk: European Central Bank reference rates via Frankfurter.</li>
    <li>Simulated: supplier payouts of the full amount. Real: x402 payments on Base Sepolia, escrow transactions on ${esc(STATE.escrow.chain ?? "the escrow chain")}.</li></ul><div style="text-align:right"><button class="btn" id="m-x">Close</button></div>`);
  $("#m-x").onclick = closeModal;
}

route();
