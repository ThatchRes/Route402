// Agent home (Figma "Route402 · Agent home"). Plain-language requests go through the Fetch.ai concierge, including its paid
// quote and screening tools. Structured context stays on the server; recent transcripts are saved in this browser.
// A prompt never approves or executes a payment. Every amount, fee and rate shown comes from a stored agent quote.
let CHAT = [], CHAT_BUSY = false, CHAT_FOLLOWUP = "", CHAT_INPUT = "";
let CHAT_ID = crypto.randomUUID(), CHAT_REVISION = 0, SAVED_CHATS = [];
const QUOTES = {};   // intentId -> { status: "loading" | "ok" | "error", data?, error? } (read-only, this tab)
try {
  const saved = JSON.parse(localStorage.getItem("r402-conversations") ?? "{}");
  SAVED_CHATS = Array.isArray(saved.chats) ? saved.chats.filter((c) => /^[a-zA-Z0-9_-]{8,80}$/.test(c.id)).slice(0, 20) : [];
  const active = SAVED_CHATS.find((c) => c.id === saved.activeId);
  if (active) { CHAT_ID = active.id; CHAT_REVISION = active.revision ?? 0; CHAT = active.messages ?? []; }
  else if (!saved.activeId) { const legacy = JSON.parse(sessionStorage.getItem("r402-chat") ?? "{}"); if (Array.isArray(legacy.messages)) CHAT = legacy.messages.slice(-60); }
} catch {}
function saveChat() {
  if (CHAT.length) {
    const entry = { id: CHAT_ID, revision: CHAT_REVISION, messages: CHAT.slice(-60), workspace: typeof STATE !== "undefined" && STATE ? `${STATE.company}|${!!STATE.localSimulation}` : SAVED_CHATS.find((c) => c.id === CHAT_ID)?.workspace,
      title: CHAT.find((m) => m.role === "user")?.text?.slice(0, 48) ?? "New chat", updatedAt: Date.now() };
    SAVED_CHATS = [entry, ...SAVED_CHATS.filter((c) => c.id !== CHAT_ID)].slice(0, 20);
  }
  try { localStorage.setItem("r402-conversations", JSON.stringify({ activeId: CHAT_ID, chats: SAVED_CHATS })); } catch {}
  renderChatHistory();
}
const CHAT_EXAMPLES = [
  ["Find suppliers", "Which of my supplier companies use MXN?"],
  ["Plan a payment", "Pay my German suppliers this week"],
  ["Add a supplier", "Add a supplier"],
];
// Follow-ups the conversation planner understands while a draft is open (they fill the composer; nothing is sent automatically)
const DRAFT_SUGGESTIONS = [["Explain these fees", "Explain these fees"], ["Change the deadline", "Change the deadline to "], ["Did it work?", "Did it work?"]];
const ICON = (name, size, cls = "") => `<img class="${cls}" src="assets/${name}.svg" width="${size}" height="${size}" alt="" />`;
const chatTitle = () => SAVED_CHATS.find((c) => c.id === CHAT_ID)?.title ?? CHAT.find((m) => m.role === "user")?.text?.slice(0, 48);

function renderChatHistory() {
  const el = document.querySelector("#chat-history"); if (!el) return;
  const workspace = typeof STATE !== "undefined" && STATE ? `${STATE.company}|${!!STATE.localSimulation}` : null;
  const chats = SAVED_CHATS.filter((c) => !workspace || !c.workspace || c.workspace === workspace);
  el.innerHTML = chats.length ? `<span class="history-label">Recent work</span>${chats.map((c) => `<button data-chat-open="${c.id}" class="${c.id === CHAT_ID ? "active" : ""}" ${CHAT_BUSY ? "disabled" : ""} title="${esc(c.title)}">${esc(c.title)}</button>`).join("")}` : "";
}
async function restoreChatContext() {
  const id = CHAT_ID;
  try {
    const saved = await api(`/conversations/${id}`);
    if (CHAT_ID !== id || CHAT_BUSY) return;
    if (saved.conversationRevision > CHAT_REVISION || (!CHAT.length && saved.turns?.length)) {
      CHAT = saved.turns.flatMap((turn) => [{ role: "user", text: turn.user }, { role: "assistant", answer: {
        status: turn.reply.clarification ? "clarification" : "ok", clarification: turn.reply.clarification,
        preview: turn.reply, conversationId: id, conversationRevision: turn.reply.conversationRevision } }]);
    }
    CHAT_REVISION = saved.conversationRevision; saveChat(); renderChatMessages();
  } catch { /* Keep the readable saved chat; a send will report a connection error. */ }
}
function openChat(id) {
  if (CHAT_BUSY) return;
  const saved = SAVED_CHATS.find((c) => c.id === id); if (!saved) return;
  CHAT_ID = id; CHAT_REVISION = saved.revision ?? 0; CHAT = saved.messages ?? []; CHAT_INPUT = ""; CHAT_FOLLOWUP = "";
  saveChat(); if (location.hash === "#/chat") pageChat($("#page")); else location.hash = "#/chat";
}
function newChat() {
  if (CHAT_BUSY) return;
  saveChat(); CHAT_ID = crypto.randomUUID(); CHAT_REVISION = 0; CHAT = []; CHAT_INPUT = ""; CHAT_FOLLOWUP = ""; saveChat();
  if (location.hash === "#/chat") pageChat($("#page")); else location.hash = "#/chat";
}
document.querySelector("#chat-history")?.addEventListener("click", (e) => { const button = e.target.closest("[data-chat-open]"); if (button) openChat(button.dataset.chatOpen); });
document.addEventListener("click", (e) => { if (e.target.closest("[data-new-chat]")) { e.preventDefault(); e.target.closest("details")?.removeAttribute("open"); newChat(); } });

const greeting = () => { const h = new Date().getHours(), first = ME?.name?.split(" ")[0];
  return `Good ${h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"}${first ? `, ${first}` : ""}.`; };

function pageChat(P) {
  P.innerHTML = `<div class="agent-home">
    <section class="intro">
      <div class="intro-text"><p class="eyebrow">YOUR FINANCIAL WORKSPACE</p><h1 id="greeting">${esc(greeting())}</h1><p class="lede">Ask, prepare and track. You stay in control of every payment.</p></div>
      <a class="btn-line" href="#/payments/new">Manual payment ${ICON("plus", 15)}</a>
    </section>
    <div class="agent-cols">
      <section class="convo" aria-label="Conversation with the payment agent">
        <div class="convo-bar"><div class="convo-title">${ICON("message-square", 16)}<span id="convo-title"></span></div>
          <button class="text-btn" id="new-chat" data-new-chat>+ New conversation</button></div>
        <div class="convo-log" id="chat-content" aria-live="polite"></div>
        <div class="composer-wrap"><form class="composer" id="chat-form">
          <label class="sr-only" for="chat-input">Your request to the payment agents</label>
          <textarea id="chat-input" rows="1" maxlength="500" placeholder="Ask about fees, a supplier or a payment…" aria-describedby="chat-input-note"></textarea>
          <div class="composer-bottom"><span class="attach" id="chat-attach">${ICON("paperclip", 16, "clip")}<span id="chat-input-note"></span></span>
          <button type="submit" class="chat-send" id="chat-send" aria-label="Send request to agents">${ICON("arrow-up", 16)}</button></div>
        </form><div class="suggestions" id="chat-suggestions"></div></div>
      </section>
      <aside class="context" id="chat-context-panel" aria-label="In this conversation"></aside>
    </div>
    <p class="app-note" id="chat-context">Route402 · demo</p>
  </div>`;
  const input = $("#chat-input"); input.value = CHAT_INPUT;
  input.addEventListener("input", () => { CHAT_INPUT = input.value; syncChatComposer(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!CHAT_BUSY) $("#chat-form").requestSubmit(); }
  });
  $("#chat-form").onsubmit = (e) => { e.preventDefault(); sendChat(input.value); };
  $("#chat-suggestions").addEventListener("click", (e) => {
    const s = e.target.closest("[data-suggest]"); if (!s) return;
    input.value = s.dataset.suggest; CHAT_INPUT = input.value; syncChatComposer(); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  });
  $("#chat-content").addEventListener("click", (e) => {
    const prepare = e.target.closest("[data-chat-prepare]");
    if (prepare) prepareChat(Number(prepare.dataset.chatPrepare));
    const supplier = e.target.closest("[data-chat-supplier]");
    if (supplier) confirmChatSupplier(Number(supplier.dataset.chatSupplier));
  });
  $("#chat-context-panel").addEventListener("click", (e) => {
    const close = e.target.closest("[data-close-draft]");
    if (close) { const m = CHAT[Number(close.dataset.closeDraft)]; if (m) { m.closed = true; saveChat(); renderChatMessages(); } }
  });
  renderChatMessages(); updateChatContext(); renderChatHistory(); void restoreChatContext();
}

function updateChatContext(available = true) {
  const el = $("#chat-context"); if (!el) return;
  const previous = SAVED_CHATS.find((c) => c.id === CHAT_ID)?.workspace;
  if (STATE && previous && previous !== `${STATE.company}|${!!STATE.localSimulation}` && !CHAT_BUSY) {
    CHAT_ID = crypto.randomUUID(); CHAT_REVISION = 0; CHAT = []; CHAT_INPUT = ""; CHAT_FOLLOWUP = ""; pageChat($("#page")); return;
  }
  el.textContent = !available ? "Company data unavailable · you can still ask" : workspaceNote();
  const g = $("#greeting"); if (g) g.textContent = greeting();
  setCrumbs("Agent", chatTitle()); renderChatMessages();
}
function syncChatComposer() {
  const input = $("#chat-input"), send = $("#chat-send"); if (!input || !send) return;
  send.disabled = CHAT_BUSY || !input.value.trim();
  send.innerHTML = CHAT_BUSY ? `<span class="spinner" aria-hidden="true"></span>` : ICON("arrow-up", 16);
  send.setAttribute("aria-label", CHAT_BUSY ? "Agents are working" : "Send request to agents");
  input.setAttribute("aria-busy", String(CHAT_BUSY));
  const nc = $("#new-chat"); if (nc) nc.disabled = CHAT_BUSY;
  const draft = activeDraft(), name = draft && draftName(draft.d, QUOTES[draft.d.intentId]?.data);
  $("#chat-attach").classList.toggle("on", !!draft && !CHAT_FOLLOWUP);
  $("#chat-input-note").textContent = CHAT_FOLLOWUP ? "Reply with the missing detail, or type a new request"
    : draft ? `${name} draft attached` : "Follow up naturally · Enter to send";
  renderChatHistory();
}

// ------------------------------------------------------------------ messages
const timeOf = (ms) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "");
function renderChatMessages() {
  const content = $("#chat-content"); if (!content) return;
  const title = chatTitle(); $("#convo-title").textContent = title ?? "New conversation";
  const mine = initials(ME?.name) || "–";
  content.innerHTML = CHAT.length ? CHAT.map((m, i) => m.role === "user"
    ? `<article class="msg user"><div class="msg-author"><span class="ini">${esc(m.by ?? (m.at ? "" : mine))}</span><b>You</b>${m.at ? `<time>${esc(timeOf(m.at))}</time>` : ""}</div><p class="msg-text">${esc(m.text)}</p></article>`
    : `<article class="msg agent"><div class="msg-author">${ICON("sparkles-agent", 16)}<b>Route402 Agent</b>${m.answer?.decisions?.length ? `<span class="badge">${quotesKind(m.answer)}</span>` : ""}${m.at ? `<time>${esc(timeOf(m.at))}</time>` : ""}</div>
      <div class="msg-body">${m.error ? `<p class="chat-error" role="alert">${esc(m.error)}</p><p class="msg-note">Your request wasn't completed. You can send it again.</p>` : chatAnswer(m.answer, i)}</div></article>`).join("")
    : `<p class="msg-empty">Ask the agent to plan a payment, find a supplier or check a transfer. Payments need your company's approval before any money moves.</p>`;
  if (CHAT_BUSY) content.insertAdjacentHTML("beforeend", `<article class="msg agent"><div class="msg-author">${ICON("sparkles-agent", 16)}<b>Route402 Agent</b></div><div class="msg-body chat-working" role="status"><span class="spinner" aria-hidden="true"></span> Your agents are reviewing the request…<small>Quote and supplier checks can take a few minutes.</small></div></article>`);
  const sug = $("#chat-suggestions");
  if (sug) sug.innerHTML = (activeDraft() ? DRAFT_SUGGESTIONS : CHAT_EXAMPLES).map(([label, prompt]) => `<button type="button" data-suggest="${esc(prompt)}">${esc(label)}</button>`).join("");
  renderContext(); syncChatComposer();
}
const quotesKind = (a) => (STATE?.localSimulation || (a.paidCalls?.length && a.paidCalls.every((c) => c.mock)) ? "Simulated quotes" : "Testnet quotes");

async function sendChat(text) {
  text = text.trim(); if (!text || CHAT_BUSY) return;
  // The server resolves this turn against structured context; never concatenate old instructions or trust browser answers.
  const request = text;
  if (request.length > 500) {
    CHAT.push({ role: "assistant", error: "Please shorten this message to 500 characters.", at: Date.now() }); saveChat(); renderChatMessages(); return;
  }
  CHAT.push({ role: "user", text, at: Date.now(), by: initials(ME?.name) || undefined }); CHAT_INPUT = ""; CHAT_BUSY = true;
  $("#chat-input").value = ""; saveChat(); renderChatMessages(); setCrumbs("Agent", chatTitle());
  try {
    const answer = await api("/ask", { text: request, conversationId: CHAT_ID, conversationRevision: CHAT_REVISION });
    if (!answer || !["ok", "clarification", "blocked"].includes(answer.status)) throw new Error(answer?.error || "The agents returned an incomplete response. Please try again.");
    CHAT_FOLLOWUP = answer.status === "clarification" ? request : "";
    if (answer.conversationId === CHAT_ID && Number.isInteger(answer.conversationRevision)) CHAT_REVISION = answer.conversationRevision;
    CHAT.push({ role: "assistant", answer, at: Date.now() });
  } catch (e) {
    CHAT.push({ role: "assistant", error: e.message, at: Date.now() });
    if (!CHAT_INPUT) CHAT_INPUT = text;
    // A timed-out agent call may already have stored the draft. Synchronize its revision without retrying paid tools.
    try { const saved = await api(`/conversations/${CHAT_ID}`); if (Number.isInteger(saved.conversationRevision)) CHAT_REVISION = saved.conversationRevision; } catch {}
  } finally {
    CHAT_BUSY = false; saveChat(); renderChatMessages();
    const input = $("#chat-input"); if (input) { input.value = CHAT_INPUT; syncChatComposer(); input.focus(); }
    const nc = $("#new-chat"); if (nc) nc.disabled = false;
  }
}

// ------------------------------------------------------------------ agent quotes (read-only terms of quotes the agents returned)
function quote(intentId) {
  if (!intentId) return null;
  if (!QUOTES[intentId]) {
    QUOTES[intentId] = { status: "loading" };
    api(`/quotes/${encodeURIComponent(intentId)}`)
      .then((data) => { QUOTES[intentId] = { status: "ok", data }; })
      .catch((e) => { QUOTES[intentId] = { status: "error", error: e.message }; })
      .finally(() => { if (location.hash.startsWith("#/chat") || !location.hash) renderChatMessages(); });
  }
  return QUOTES[intentId];
}
const draftName = (d, q) => q?.recipient?.name ?? billOf(d.payable)?.supplier ?? d.payable;
// Match on the payable reference: a request keeps it, while its intent can be re-quoted at release (same as reqFor)
const requestFor = (d) => reqFor(d.payable);
const whenUtc = (iso) => (iso ? `${new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} · ${utc(iso)}` : "-");
const dayUtc = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "-");
const nonZero = (s) => Number(num(s)) !== 0;
const maskOf = (q) => maskedFor(q.recipient.name, q.recipient.maskedAccount);
const feesText = (q) => q.legs.map((l) => [`${money(l.fundingFee)} transfer`, nonZero(l.payoutFee) ? `${money(l.payoutFee)} payout` : null].filter(Boolean).join(" + ")).join(" · ");
const fxText = (q) => q.legs.filter((l) => Number(l.fxRate) !== 1 || !l.funded.endsWith(q.recipient.ccy)).map((l) => `${money(l.funded)} × ${fxFmt(l.fxRate)}`).join(" · ");
const window_ = (q) => `${whenUtc(q.capturedAt).replace(" UTC", "")}–${utc(q.expiresAt)}`;
// The latest answer in the current revision whose agent plan can still be prepared (or is already being tracked)
function activeDraft() {
  for (let i = CHAT.length - 1; i >= 0; i--) {
    const a = CHAT[i].answer; if (!a?.decisions?.length) continue;
    if (CHAT[i].closed || a.conversationRevision !== CHAT_REVISION) return null;
    const ds = a.decisions.filter((d) => d.intentId && ["approve", "review"].includes(d.decision));
    return ds.length ? { index: i, d: ds[0], count: ds.length } : null;
  }
  return null;
}

function chatTable(headers, rows) {
  if (!rows.length) return "";
  return `<div class="chat-table-wrap"><table class="chat-table"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v) => `<td>${esc(v ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function chatAnswer(a, index) {
  if (!a) return "<p class='msg-text'>No response available. Please ask again.</p>";
  if (a.status === "clarification" || a.status === "blocked") return `${a.status === "blocked" ? "<h3 class='msg-title'>Let's resolve this first</h3>" : ""}<p class="msg-text">${esc(a.clarification || "Please add more detail to your request.")}</p>`;
  const p = a.preview ?? {}, view = p.preview ?? {}, decisions = a.decisions ?? [];
  const current = a.conversationId === CHAT_ID && a.conversationRevision === CHAT_REVISION && !CHAT[index]?.closed;
  let html = `<h3 class="msg-title">${esc(a.title || p.title || "Here's what I found")}</h3>`;
  if (p.message) html += `<p class="msg-text">${esc(p.message)}</p>`;
  if (p.suppliers) html += chatTable(["Supplier company", "Country", "Currencies", "Linked bills", "Receiving details"], p.suppliers.map((s) => [s.name, s.country, s.currencies.join(", "), s.billIds.length, `${s.check} · ${s.maskedAccount}`]));
  if (p.transfers) html += chatTable(["Transfer", "Supplier", "Amount", "Status", "Deadline"], p.transfers.map((t) => [t.id, t.supplier, t.amount, t.status, t.deadlineStatus ?? "Awaiting evidence"]));
  if (p.reviewResults) html += chatTable(["Payment", "Agent decision", "Explanation"], p.reviewResults.map((r) => [r.supplier ?? r.payable, r.decision, (r.reasons ?? []).join("; ")]));
  if (p.action?.type === "add_supplier") {
    html += chatTable(["Supplier", "Country", "Currency"], [[p.supplierDraft.name, p.supplierDraft.country, p.supplierDraft.currency]]);
    html += `<button class="btn primary sm" data-chat-supplier="${index}" ${a.conversationRevision !== CHAT_REVISION ? "disabled" : ""}>Review & save supplier</button>`;
  }
  if (!decisions.length) {
    const facts = [["You pay", view.youPay], ["Supplier receives", view.theyGet], ["You receive", view.youGet], ["Savings vs your bank", view.youSave ?? p.companyKeeps], ["Estimated arrival", view.arrives ? when(view.arrives) : null]].filter(([, value]) => value != null);
    if (facts.length) html += `<dl class="chat-facts">${facts.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>`;
  }
  if (view.status && view.status !== "OK") html += `<p class="msg-text">${esc(view.reason || (view.missing ?? []).join("; ") || view.status)}</p>`;
  if (!decisions.length && view.timing?.deadlineUtc) html += `<p class="chat-deadline">Recipient deadline: <b>${esc(when(view.timing.deadlineUtc))}</b>${view.timing.latestStartUtc ? ` · Start by ${esc(when(view.timing.latestStartUtc))}` : ""}</p>`;
  if (view.savingsStatus || p.savings) html += `<p class="msg-note">Projected savings before agent review and execution. Held payments are not payment commitments.</p>`;
  if (p.savings) html += chatTable(["Savings by lever", "Amount"], Object.entries(p.savings).map(([key, value]) => [key.replace(/([A-Z])/g, " $1"), value]));
  if (p.results) html += chatTable(["Supplier", "Bank details", "Notes"], p.results.map((r) => [r.supplier, r.status, (r.issues ?? []).join("; ") || "Checks passed"]));
  if (p.byCurrency) html += chatTable(["Currency", "Owed", "Confirmed incoming", "Expected"], Object.entries(p.byCurrency).map(([ccy, r]) => [ccy, fmt(r.owe), fmt(r.incoming), fmt(r.expected)]));
  if (view.lines?.length && decisions.length > 1) html += `<p class="msg-text">${view.lines.length} bill${view.lines.length === 1 ? "" : "s"} in this plan${view.companyKeeps ? ` · ${esc(view.companyKeeps)} savings after fees` : ""}.</p>`;
  const actionable = decisions.filter((d) => ["approve", "review"].includes(d.decision) && d.intentId);
  html += decisions.map((d) => proposal(d, a, index, current, decisions.length === 1)).join("");
  if (actionable.length && decisions.length > 1) html += reviewAction(a, index, current, actionable, `Review ${actionable.length} payment${actionable.length === 1 ? "" : "s"}`);
  if (!decisions.length && view.lines?.length) html += chatTable(["Invoice", "Plan", "Amount to convert"], view.lines.map((r) => [r.payable, r.status || r.route || "See plan", r.convertedAmount ? `${r.convertedAmount} ${r.ccy}` : "Paid from balance"]));
  if (p.tip) html += `<p class="msg-text">${esc(p.tip)}</p>`;
  if (a.paidCalls?.length || a.hops?.length) html += `<details class="chat-details"><summary>Agent activity${a.paidCalls?.length ? ` · ${a.paidCalls.length} tool calls · ${esc(a.spentUsdc)} test USDC${a.paidCalls.every((c) => c.mock) ? " · local simulation" : ""}` : ""}</summary>
    <ol>${(a.hops ?? []).map((h) => `<li><b>${esc(h.from)} → ${esc(h.to)}</b> · ${esc(h.message)}</li>`).join("")}</ol>
    ${(a.paidCalls ?? []).map((c) => {
      const href = typeof c.explorer === "string" && /^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-f]+$/i.test(c.explorer) ? c.explorer : null;
      return `<p>${esc(c.service)} · ${esc(c.priceUsdc)} test USDC ${c.mock ? "(mock)" : href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">View transaction ↗</a>` : ""}</p>`;
    }).join("")}</details>`;
  return html;
}

// Review action: the existing prepare-for-approval flow (creates payment requests; nothing moves until approvals are met)
function reviewAction(a, index, current, actionable, label = "Review payment") {
  const tracked = actionable.map(requestFor).filter(Boolean);
  if (tracked.length === actionable.length) return `<div class="review-row">${tracked.map((r) => `<a class="btn-solid" href="#/payments/${esc(r.id)}">Track payment ${ICON("arrow-right-white", 15)}</a>`).join("")}<span class="msg-note">Payment request ${esc(tracked.map((r) => r.id).join(", "))} · ${esc(statusText(tracked[0].status))}</span></div>`;
  if (CHAT[index]?.closed) return `<div class="review-row"><span class="msg-note">Draft closed. Ask again to plan this payment.</span></div>`;
  const stale = a.conversationRevision !== CHAT_REVISION;
  return `<div class="review-row"><button class="btn-solid" data-chat-prepare="${index}" ${current ? "" : "disabled"}>${stale ? "Plan changed · ask for a fresh preview" : esc(label)} ${stale ? "" : ICON("arrow-right-white", 15)}</button>
    <span class="msg-note">Draft only. Nothing is submitted until you approve.</span></div>`;
}

const BADGE = { approve: ["", "Recommended"], review: ["warn", "Needs review"], hold: ["warn", "On hold"] };
function proposal(d, a, index, current, withAction) {
  const opt = d.options?.find((o) => o.provider === d.chosen) ?? {}, [kind, badge] = BADGE[d.decision] ?? BADGE.hold;
  const qs = quote(d.intentId), q = qs?.data, name = draftName(d, q);
  const head = `<div class="proposal-head"><b>${esc(opt.label ?? (d.chosen ? RAIL[d.chosen] ?? d.chosen : name))}</b><span class="badge ${kind}">${esc(badge)}</span></div>`;
  const reasons = (d.reasons ?? []).filter((r) => !r.startsWith("compared:"));
  if (!d.intentId) return `<section class="proposal held">${head}<p class="msg-text">${esc(name)}</p><ul class="reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></section>`;
  const amount = (label, value) => `<div class="amt"><span>${esc(label)}</span><b>${q ? money(value) : qs?.status === "error" ? "—" : `<i class="skel-line"></i>`}</b></div>`;
  const rows = q ? [["Fees included", feesText(q)], ["Conversion", fxText(q)], ["Estimated arrival", `${whenUtc(q.arrivalUtc)}${q.plan === "split" ? ` · split across ${q.legs.length} routes` : ""}`]].filter(([, v]) => v) : [];
  const timing = d.timing ?? {}, note = [q && q.recipient.maskedAccount !== "no account on file" ? `Saved ${q.recipient.ccy} details ${maskOf(q)}` : null,
    timing.deadlineUtc ? `Requested delivery: ${dayUtc(timing.deadlineUtc)}` : null, timing.latestStartUtc ? `Start by ${whenUtc(timing.latestStartUtc)}` : null].filter(Boolean).join(" · ");
  const alts = (d.options ?? []).filter((o) => o.provider !== d.chosen);
  return `<section class="proposal">${head}
    <div class="amounts">${amount("TOTAL DEBIT · FEES INCLUDED", q?.sourceDebit)}${ICON("arrow-right", 18, "arrow")}${amount(`${name.toUpperCase()} RECEIVES · QUOTED`, q?.recipientNet)}</div>
    ${qs?.status === "error" ? `<p class="msg-note">Quote details unavailable: ${esc(qs.error)}</p>` : ""}
    <div class="divider"></div>
    ${rows.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}
    ${note ? `<p class="proposal-note">${esc(note)}</p>` : ""}
    ${(d.needs ?? []).length ? `<p class="proposal-note warn">Needs: ${esc(d.needs.join("; "))}</p>` : ""}
    ${withAction ? reviewAction(a, index, current, [d]) : ""}
  </section>
  ${alts.length ? `<div class="alts">${alts.map((o) => alternative(o, d, q)).join("")}</div>` : ""}
  ${q ? `<p class="msg-note">${q.amountType === "SOURCE_FIXED" ? `All routes use the same ${esc(money(q.sourceDebit))} total debit.` : `All routes deliver ${esc(money(q.recipientNet))} to ${esc(name)}.`} Quotes are ${q.simulation ? "simulated" : "testnet"} and held until ${esc(utc(q.expiresAt))}. No verified reliability history is available.</p>` : ""}
  ${reasons.length ? `<details class="chat-details"><summary>Why the agent chose this route</summary><ul class="reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>` : ""}`;
}
function alternative(o, d, chosenQ) {
  const qs = o.intentId && (o.eligible || o.requiresCostApproval) ? quote(o.intentId) : null, q = qs?.data;
  let title = o.label && o.label !== o.provider ? o.label : RAIL[o.provider] ?? o.provider, line = o.why ?? "", small = "";
  if (q) {
    const fixedSource = q.amountType === "SOURCE_FIXED", main = fixedSource ? q.recipientNet : q.sourceDebit;
    title += ` · ${money(main)}`;
    if (chosenQ) {
      const delta = num(main) - num(fixedSource ? chosenQ.recipientNet : chosenQ.sourceDebit), ccy = String(main).split(" ")[1];
      const diff = Math.abs(delta) < 0.005 ? "same amount" : fixedSource ? `${fmt(Math.abs(delta))} ${ccy} ${delta < 0 ? "less" : "more"} for the supplier` : `${fmt(Math.abs(delta))} ${ccy} ${delta > 0 ? "more" : "less"} to pay`;
      line = [`Arrives ${whenUtc(q.arrivalUtc)}`, diff, o.why].filter(Boolean).join(" · ");
    }
    small = [feesText(q) && `${feesText(q)} fees`, fxText(q)].filter(Boolean).join(" · ");
  } else if (o.arrivalUtc) line = [`Arrives ${whenUtc(o.arrivalUtc)}`, o.why].filter(Boolean).join(" · ");
  const bill = billOf(d.payable);
  return `<details class="alt"><summary>${ICON("chevron-right", 14, "chev")}<div class="tradeoff"><b>${esc(title)}</b>${line ? `<span>${esc(line)}</span>` : ""}${small ? `<small>${esc(small)}</small>` : ""}</div></summary>
    <div class="alt-more">${o.riskWhy ? `<p>Risk ${esc(o.risk)}/5 · ${esc(o.riskWhy)}</p>` : ""}${o.costBps != null ? `<p>${(o.costBps / 100).toFixed(2)}% above mid-market</p>` : ""}
    ${bill ? `<a href="#/payments/new?bill=${esc(bill.id)}">Compare routes for ${esc(bill.id)} and choose a different one →</a>` : `<p>To use a different route, ask the agent with a fastest or cheapest preference.</p>`}</div></details>`;
}

// ------------------------------------------------------------------ "In this conversation" panel (the active draft only)
function renderContext() {
  const el = $("#chat-context-panel"); if (!el) return;
  const draft = activeDraft();
  const head = `<div class="ctx-head"><span class="eyebrow">IN THIS CONVERSATION</span><details class="menu"><summary aria-label="More actions">${ICON("more-horizontal", 16)}</summary>
    <div class="menu-pop"><a href="#/payments">All payments</a><a href="#/payments/new">Manual payment</a><button type="button" data-new-chat>New conversation</button></div></details></div>`;
  if (!draft) { el.innerHTML = `${head}<p class="ctx-empty">No payment draft yet. Ask the agent to plan a payment, or start a manual payment.</p>`; return; }
  const { d, index, count } = draft, q = quote(d.intentId)?.data, req = requestFor(d), name = draftName(d, q), bill = billOf(d.payable);
  const detail = (k, v, sub = "") => `<div class="ctx-detail"><span>${esc(k)}</span><b title="${esc(v.replace(/<[^>]+>/g, ""))}">${v}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
  const prev = (STATE?.transfers ?? []).find((t) => t.supplier === name && t.reference !== d.payable && t.transferId !== req?.transferId);
  el.innerHTML = `${head}
    <span class="badge ${req ? (statusKind(req.status) === "ok" ? "" : "warn") : ""}">${esc(req ? statusText(req.status) : "Unsubmitted draft")}</span>
    ${detail("Reference", req ? `<a href="#/payments/${esc(req.id)}">${esc(req.id)}</a>` : esc(q?.reference ?? d.payable))}
    ${detail("Recipient", esc(name), q ? [COUNTRY[q.recipient.country] ?? q.recipient.country, q.recipient.ccy, maskOf(q)].filter(Boolean).join(" · ") : "")}
    ${bill ? detail("Invoice", esc(bill.id), `${money(`${bill.amount} ${bill.ccy}`)} · due ${dayY(bill.dueUtc)}`) : ""}
    ${q ? detail("Source", esc(q.sourceAccount)) : ""}
    ${count > 1 ? `<p class="ctx-note">+ ${count - 1} more payment${count > 2 ? "s" : ""} in this plan</p>` : ""}
    <div class="divider"></div>
    <div class="ctx-block"><span class="eyebrow">QUOTE WINDOW</span>${q ? `<p>${esc(window_(q))} · <span data-exp="${esc(q.expiresAt)}">${leftText(q.expiresAt)}</span></p><small>Ask again for a fresh quote after expiry.</small>` : `<small>Loading quote…</small>`}</div>
    <div class="divider"></div>
    <div class="ctx-block"><span class="eyebrow">PREVIOUS PAYMENT</span>${prev ? `<p class="clip"><b title="${esc(prev.reference)}">${esc(prev.reference)}</b> · <b>${esc(statusText(prev.status))}</b></p><small>${money(prev.debit)} → ${money(prev.credit)}</small><small class="xs">${esc(prev.transferId)}${reqFor(prev.reference) ? ` · ${esc(reqFor(prev.reference).id)}` : ""}</small>` : `<small>No earlier transfer to ${esc(name)} in this workspace.</small>`}</div>
    ${req ? "" : `<div class="divider"></div><button type="button" class="text-btn" data-close-draft="${index}">Close unsubmitted draft</button>
    <small class="xs">Closes this draft only. It does not cancel an in-flight payment or move money.</small>`}`;
}

function prepareChat(index) {
  const answer = CHAT[index]?.answer; if (!answer) return;
  if (answer.conversationId !== CHAT_ID || answer.conversationRevision !== CHAT_REVISION) return;
  if (!ME) { signIn(() => prepareChat(index)); return; }
  modal(`<h2>Prepare this payment plan?</h2><p>Create requests for eligible payments. Start immediately after approval; recheck the deadline before sending. Your company's approval controls apply.</p><label class="confirm"><input type="checkbox" id="chat-reroute"/> Allow another quoted route to the same supplier if it meets the deadline and stays within the approved debit cap.</label><label class="confirm"><input type="checkbox" id="chat-confirm"/> I checked the supplier, invoice, fees and delivery estimate, including any cost exception needing approval.</label><div id="chat-prepare-error" role="alert"></div><div class="actions"><button class="btn ghost" id="chat-cancel">Cancel</button><button class="btn primary" id="chat-prepare-submit" disabled>Prepare for approval</button></div>`);
  $("#chat-cancel").onclick = closeModal;
  $("#chat-confirm").onchange = (e) => { $("#chat-prepare-submit").disabled = !e.target.checked; };
  $("#chat-prepare-submit").onclick = async (e) => {
    const button = e.currentTarget; button.disabled = true;
    try {
      const result = await api("/requests", { confirmed: true, conversationId: CHAT_ID, conversationRevision: CHAT_REVISION,
        allowReroute: $("#chat-reroute").checked, decisions: answer.decisions, purpose: answer.title || "Payment planned in chat" });
      const requests = result.requests ?? [], created = requests.filter((r) => r.requestId);
      if (!created.length) throw new Error(requests.map((r) => r.skipped).join("; ") || result.error || "No payment requests were created.");
      closeModal(); location.hash = created.length === 1 ? `#/payments/${created[0].requestId}` : "#/payments";
    } catch (error) { $("#chat-prepare-error").textContent = error.message; button.disabled = false; }
  };
}

function confirmChatSupplier(index) {
  const answer = CHAT[index]?.answer, draft = answer?.preview?.supplierDraft;
  if (!draft || answer.conversationId !== CHAT_ID || answer.conversationRevision !== CHAT_REVISION) return;
  if (!ME) { signIn(() => confirmChatSupplier(index)); return; }
  const fields = [["accountNumber", draft.country === "MX" ? "CLABE (18 digits)" : "Receiving account number"], ["iban", "IBAN, where required"],
    ["routing", "US routing number, if applicable"], ["swift", "SWIFT / BIC, if applicable"], ["usdcWallet", "USDC wallet (optional)"]];
  modal(`<h2>Save ${esc(draft.name)}</h2><p>${esc(draft.country)} · ${esc(draft.currency)}. Receiving details are validated before saving.</p><form id="chat-supplier-form">
    ${fields.map(([key, label]) => `<div class="field"><label for="supplier-${key}">${esc(label)}</label><input id="supplier-${key}" name="${key}" maxlength="100" autocomplete="off" /></div>`).join("")}
    <label class="confirm"><input type="checkbox" id="supplier-confirm" required/> I checked this supplier’s identity and receiving details.</label>
    <p class="note">Saving a supplier creates no invoice and sends no payment.</p><div id="supplier-error" role="alert"></div>
    <div class="actions"><button type="button" class="btn ghost" id="supplier-cancel">Cancel</button><button class="btn primary" id="supplier-save">Save supplier</button></div></form>`);
  $("#supplier-cancel").onclick = closeModal;
  $("#chat-supplier-form").onsubmit = async (e) => {
    e.preventDefault(); const button = $("#supplier-save"); button.disabled = true;
    const details = Object.fromEntries(new FormData(e.target));
    try {
      const result = await api("/suppliers", { confirmed: $("#supplier-confirm").checked, conversationId: CHAT_ID,
        conversationRevision: answer.conversationRevision, details });
      CHAT_REVISION = result.conversationRevision; CHAT.push({ role: "assistant", answer: result, at: Date.now() }); saveChat(); closeModal(); renderChatMessages();
      await loadAll(); updateChatContext();
    } catch (error) { $("#supplier-error").textContent = error.message; button.disabled = false; }
  };
}
