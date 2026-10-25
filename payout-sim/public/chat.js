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
  ["Plan a payment", "Pay my German suppliers this week"],
  ["Find suppliers", "Which of my supplier companies use MXN?"],
  ["See what you owe", "What do we owe our suppliers?"],
  ["Fastest route", "Pay all my suppliers by Friday, fastest route"],
  ["Check a payment", "What happened to my last payment?"],
  ["Add a supplier", "Add a supplier"],
];
// Agent home: idle (choose chat or manual input, past payments beside it) -> chat (past payments slide away to a pull tab,
// the composer widens, prompts fill the middle). The tab slides the panel back out; the chat reflows into the narrower space.
let CHAT_OPEN = false, PANEL_OPEN = true;
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
  CHAT_OPEN = CHAT_OPEN || CHAT.length > 0 || !!CHAT_INPUT;
  PANEL_OPEN = !CHAT_OPEN;
  const started = CHAT.length > 0;
  P.innerHTML = `<div class="agent-page${CHAT_OPEN ? " is-chat" : ""}${started ? " has-msgs" : ""}${PANEL_OPEN ? "" : " panel-closed"}" id="agent">
    <div class="agent-main">
      <div class="agent-scroll" id="agent-scroll"><div class="agent-col">
        <div class="convo-bar"><div class="convo-title">${ICON("message-square", 15)}<span id="convo-title"></span></div>
          <button class="text-btn" id="new-chat" data-new-chat>+ New conversation</button></div>
        <section class="hero" aria-label="Start">
          <span class="hero-icon" aria-hidden="true">${ICON("sparkles-agent", 24)}</span>
          <div class="hero-swap">
            <div class="hero-idle"><p class="hero-hi" id="greeting">${esc(greeting())}</p><h1>How do you want to pay today?</h1>
              <p class="hero-sub">Chat with the agent, or enter the payment yourself. Either way, nothing moves until your company approves it.</p>
              <div class="choices">
                <button type="button" class="choice" data-open-chat>${ICON("message-square", 16)}<span><b>Chat with the agent</b><small>Describe it in plain words. The agent compares routes and buys quotes.</small></span></button>
                <a class="choice" href="#/payments/new">${ICON("sliders-horizontal", 16)}<span><b>Manual input</b><small>Pick a saved supplier and invoice, then fill in each field.</small></span></a>
              </div></div>
            <div class="hero-chat"><p class="hero-hi">Ask about suppliers, fees or a payment</p><h1>What should we work on?</h1>
              <p class="hero-sub">Pick a prompt to send it, or write your own below.</p>
              <ul class="prompt-list" id="hero-prompts"></ul></div>
          </div>
        </section>
        <div class="convo-log" id="chat-content" aria-live="polite"></div>
      </div></div>
      <div class="dock"><div class="agent-col">
        <div class="suggest-row" id="chat-suggestions"></div>
        <div class="dock-row">
          <form class="composer" id="chat-form">
            <label class="sr-only" for="chat-input">Your request to the payment agents</label>
            <textarea id="chat-input" rows="1" maxlength="500" placeholder="Ask the agent to plan a payment…" aria-describedby="chat-input-note"></textarea>
            <div class="composer-foot"><div><div class="composer-bottom">
              <span class="attach" id="chat-attach">${ICON("paperclip", 14, "clip")}<span id="chat-input-note"></span></span>
              <button type="button" class="foot-link" id="close-draft" hidden>Close draft</button>
              <a class="foot-link" href="#/payments/new">Manual input</a>
              <button type="submit" class="chat-send" id="chat-send" aria-label="Send request to agents">${ICON("arrow-up", 16)}</button>
            </div></div></div>
          </form>
          <a class="manual-btn" id="manual-btn" href="#/payments/new">${ICON("plus", 14)}Manual input</a>
        </div>
        <p class="app-note" id="chat-context">Route402 · demo</p>
      </div></div>
    </div>
    <aside class="agent-panel" aria-label="Past payments">
      <button type="button" class="panel-grip" id="panel-toggle" aria-controls="past-payments"><span></span></button>
      <div class="panel-body" id="past-payments"></div>
    </aside>
  </div>`;
  const root = $("#agent"), input = $("#chat-input"); input.value = CHAT_INPUT;
  input.addEventListener("focus", openChatUi);
  input.addEventListener("input", () => { CHAT_INPUT = input.value; syncChatComposer(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!CHAT_BUSY) $("#chat-form").requestSubmit(); }
    if (e.key === "Escape" && !CHAT.length && !input.value) { input.blur(); closeChatUi(); }
  });
  $("#chat-form").onsubmit = (e) => { e.preventDefault(); sendChat(input.value); };
  // Clicking away from an empty, unstarted chat folds it back to the idle look
  root.addEventListener("pointerdown", (e) => {
    if (CHAT_OPEN && !CHAT.length && !input.value.trim() && !e.target.closest(".composer, .prompt-list, [data-open-chat], .agent-panel")) closeChatUi();
  });
  root.addEventListener("click", (e) => {
    const s = e.target.closest("[data-suggest]");
    // A complete prompt sends right away; an open-ended one ("Change the deadline to …") goes in the box to finish
    if (s && !s.dataset.suggest.endsWith(" ")) { if (!CHAT_BUSY) { openChatUi(); sendChat(s.dataset.suggest); } return; }
    if (s) { openChatUi(); input.value = s.dataset.suggest; CHAT_INPUT = input.value; syncChatComposer(); input.focus(); input.setSelectionRange(input.value.length, input.value.length); return; }
    if (e.target.closest("[data-open-chat]")) { openChatUi(); input.focus(); return; }
    if (e.target.closest("#panel-toggle")) { PANEL_OPEN = !PANEL_OPEN; syncPanel(); return; }
    // Closes the unsubmitted draft only; it never cancels an in-flight payment or moves money
    if (e.target.closest("#close-draft")) { const d = activeDraft(); if (d) { CHAT[d.index].closed = true; saveChat(); renderChatMessages(); } }
  });
  syncHero(); syncPanel();
  $("#chat-content").addEventListener("click", (e) => {
    const prepare = e.target.closest("[data-chat-prepare]");
    if (prepare) prepareChat(Number(prepare.dataset.chatPrepare));
    const supplier = e.target.closest("[data-chat-supplier]");
    if (supplier) confirmChatSupplier(Number(supplier.dataset.chatSupplier));
  });
  renderChatMessages(); updateChatContext(); renderChatHistory(); scrollChat(false); void restoreChatContext();
}

function syncHero() {
  const idle = $(".hero-idle"), chat = $(".hero-chat"), manual = $("#manual-btn"); if (!idle) return;
  idle.inert = CHAT_OPEN; chat.inert = !CHAT_OPEN;
  manual.tabIndex = CHAT_OPEN ? -1 : 0; manual.toggleAttribute("aria-hidden", CHAT_OPEN);
}
function openChatUi() { if (CHAT_OPEN) return; CHAT_OPEN = true; PANEL_OPEN = false; $("#agent")?.classList.add("is-chat"); syncHero(); syncPanel(); }
function closeChatUi() { if (!CHAT_OPEN || CHAT.length) return; CHAT_OPEN = false; PANEL_OPEN = true; CHAT_INPUT = ""; $("#agent")?.classList.remove("is-chat"); syncHero(); syncPanel(); }

// Past payments panel: open beside the idle page, slid away to a pull tab while chatting
function syncPanel() {
  const root = $("#agent"); if (!root) return;
  root.classList.toggle("panel-closed", !PANEL_OPEN);
  const t = $("#panel-toggle"); t.setAttribute("aria-expanded", String(PANEL_OPEN)); t.setAttribute("aria-label", PANEL_OPEN ? "Hide past payments" : "Show past payments");
  $("#past-payments").inert = !PANEL_OPEN;
}
const promptItems = () => [...(activeDraft() ? DRAFT_SUGGESTIONS : []), ...CHAT_EXAMPLES].map(([label, prompt], i) =>
  `<li style="--i:${i}"><button type="button" data-suggest="${esc(prompt)}"><span>${label === prompt.trim() ? "" : esc(label)}</span>${esc(prompt.trim())}${prompt.endsWith(" ") ? " …" : ""}</button></li>`).join("");
// Once the conversation has started, a few short follow-ups sit above the box
const suggestRow = () => (activeDraft() ? DRAFT_SUGGESTIONS : CHAT_EXAMPLES.slice(0, 3)).map(([label, prompt]) => `<button type="button" data-suggest="${esc(prompt)}">${esc(label)}</button>`).join("");

function impactCard() {
  // Same numbers as the Payments page: paid so far, plus open bills projected on their best routes (GET /ui/growth).
  // Treasury levers from the payment run (early-pay discounts, bad details caught) are listed separately, never added in.
  const g = typeof GROWTH !== "undefined" ? GROWTH : null, run = STATE?.run; if (!g) return "";
  const T = g.totals, s = run?.savings ?? {}, blocked = (run?.lines ?? []).filter((l) => /BLOCKED/.test(l.status ?? "")).length;
  const row = (big, text) => `<div class="imp-row"><b>${esc(big)}</b><span>${esc(text)}</span></div>`;
  return `<section class="impact-card" aria-label="Savings vs your bank"><span class="imp-label">Savings vs your bank wire</span>
    <div class="imp-big">$${fmt(T.realizedUsd + T.projectedUsd, 0)}</div>
    <p class="imp-sub">${g.realized.length
      ? `$${fmt(T.realizedUsd, 0)} saved on ${plural(g.realized.length, "paid payment")} + $${fmt(T.projectedUsd, 0)} projected on ${plural(g.projected.length, "open bill")}, after our fee`
      : g.projected.length ? `Projected on ${plural(g.projected.length, "open bill")} once paid on their best routes, after our fee. Nothing paid through Route402 yet.`
      : "No open bills to project and nothing paid through Route402 yet."}</p>
    ${T.avgDaysFaster > 0.04 ? row(`${T.avgDaysFaster.toFixed(1)} days sooner`, `on average, for the ${T.fasterBills} of ${g.projected.length} open bills that arrive before a bank wire would`) : ""}
    ${s.earlyPayDiscounts && num(s.earlyPayDiscounts) > 0 ? row(`+ ${money(s.earlyPayDiscounts, 0)}`, "early-payment discounts the faster routes make reachable (not included above)") : ""}
    ${blocked ? row(`${blocked} caught`, `payment${blocked === 1 ? "" : "s"} with bad bank details stopped before sending`) : ""}
    <a class="imp-link" href="#/payments">See the growth chart →</a>
  </section>`;
}
function renderPastPayments() {
  const el = $("#past-payments"); if (!el) return;
  if (!STATE) { el.innerHTML = `<p class="panel-sub">Loading payments…</p>`; return; }
  const rows = [...REQS].sort((a, b) => String(b.preparedAt).localeCompare(String(a.preparedAt))).map((r) => ({ href: `#/payments/${r.id}`, name: r.supplier,
    sub: `${refLabel(r)} · ${day(r.preparedAt)}`, amount: usd(r.debitUsd, 2), status: r.status }));
  const tracked = new Set(REQS.map((r) => r.transferId).filter(Boolean));
  for (const t of STATE.transfers ?? []) if (!tracked.has(t.transferId) && !reqFor(t.reference)) rows.push({ name: t.supplier ?? t.reference, sub: t.reference, amount: money(t.debit), status: t.status });
  el.innerHTML = `${impactCard()}<div class="pp-head"><b>Past payments</b><a href="#/payments">View all</a></div>
    ${rows.length ? rows.slice(0, 14).map((r) => `<${r.href ? `a href="${esc(r.href)}"` : "div"} class="pp-row"><span class="pp-ico" aria-hidden="true">${esc(initials(r.name))}</span>
      <span class="pp-main"><b title="${esc(r.name)}">${esc(r.name)}</b><small>${esc(r.sub)}</small></span>
      <span class="pp-side"><b>${r.amount}</b><span class="tag ${statusKind(r.status)}">${esc(statusText(r.status))}</span></span></${r.href ? "a" : "div"}>`).join("")
    : `<p class="panel-sub">No payments yet. Ones you prepare in chat or by manual input show up here.</p>`}`;
}

function updateChatContext(available = true) {
  const el = $("#chat-context"); if (!el) return;
  const previous = SAVED_CHATS.find((c) => c.id === CHAT_ID)?.workspace;
  if (STATE && previous && previous !== `${STATE.company}|${!!STATE.localSimulation}` && !CHAT_BUSY) {
    CHAT_ID = crypto.randomUUID(); CHAT_REVISION = 0; CHAT = []; CHAT_INPUT = ""; CHAT_FOLLOWUP = ""; pageChat($("#page")); return;
  }
  el.textContent = `${!available ? "Company data unavailable · you can still ask" : workspaceNote()} · You’re working with AI agents: they prepare payments, a person approves each one`;
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
  $("#close-draft").hidden = !draft || !!requestFor(draft.d);
  $("#chat-input-note").textContent = CHAT_FOLLOWUP ? "Reply with the missing detail, or type a new request"
    : draft ? `${name} draft attached` : "Follow up naturally · Enter to send";
  renderChatHistory();
}

// ------------------------------------------------------------------ messages
const timeOf = (ms) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "");
function renderChatMessages() {
  const content = $("#chat-content"); if (!content) return;
  const root = $("#agent");
  root.classList.toggle("has-msgs", CHAT.length > 0);
  if (CHAT.length && !CHAT_OPEN) { CHAT_OPEN = true; root.classList.add("is-chat"); syncHero(); }
  const title = chatTitle(); $("#convo-title").textContent = title ?? "New conversation";
  const mine = initials(ME?.name) || "–";
  content.innerHTML = CHAT.length ? CHAT.map((m, i) => m.role === "user"
    ? `<article class="msg user" data-msg="${i}"><div class="msg-author"><span class="ini">${esc(m.by ?? (m.at ? "" : mine))}</span><b>You</b>${m.at ? `<time>${esc(timeOf(m.at))}</time>` : ""}</div><p class="msg-text">${esc(m.text)}</p></article>`
    : `<article class="msg agent${TYPING?.index === i ? " typing" : ""}" data-msg="${i}"><div class="msg-author">${ICON("sparkles-agent", 16)}<b>Route402 Agent</b>${m.answer?.decisions?.length ? `<span class="badge">${quotesKind(m.answer)}</span>` : ""}${m.at ? `<time>${esc(timeOf(m.at))}</time>` : ""}</div>
      <div class="msg-body">${m.error ? `<p class="chat-error" role="alert">${esc(m.error)}</p><p class="msg-note">Your request wasn't completed. You can send it again.</p>` : chatAnswer(m.answer, i)}</div></article>`).join("")
    : "";
  if (CHAT_BUSY) content.insertAdjacentHTML("beforeend", `<article class="msg agent"><div class="msg-author">${ICON("sparkles-agent", 16)}<b>Route402 Agent</b></div><div class="msg-body"><div class="chat-working" role="status"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>Your agents are working on this…</span><small>Payment requests take longer: the agents buy live quotes and check the supplier first.</small></div>
    <ol class="crew" aria-label="Agents on this request">${[["Concierge agent", "reads your request and finds the right suppliers and invoices"], ["Compliance agent", "checks the supplier and their bank details"],
      ["Routing agent", "buys live quotes from each payment route and compares cost and speed"]].map(([who, what]) => `<li><span class="dot" aria-hidden="true"></span><b>${who}</b> ${what}</li>`).join("")}</ol></div></article>`);
  $("#hero-prompts").innerHTML = promptItems(); $("#chat-suggestions").innerHTML = suggestRow();
  renderPastPayments(); syncChatComposer(); captureTyping();
}

// ------------------------------------------------------------------ scrolling and the typed-out reply
const chatScroller = () => $("#agent-scroll");
const nearBottom = () => { const s = chatScroller(); return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 140; };
const scrollChat = (smooth = true) => { const s = chatScroller(); if (s) s.scrollTo({ top: s.scrollHeight, behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" }); };
// A new reply is revealed like a streamed answer: text word by word, tables and quote cards as whole blocks.
// Re-renders (quotes loading) rebuild the DOM, so progress is kept as a character count and re-applied to the fresh DOM.
let TYPING = null;   // { index, shown, units, blocks, total }
const ATOMIC = ".proposal, .chat-table-wrap, .alts, details, .review-row, dl, button, .how";
function startTyping(index) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  TYPING = { index, shown: 0 }; requestAnimationFrame(tickTyping);
}
function captureTyping() {
  if (!TYPING) return;
  const body = $(`[data-msg="${TYPING.index}"] .msg-body`); if (!body) { TYPING = null; return; }
  const blocks = [...body.children], units = [];
  blocks.forEach((b, bi) => {
    if (b.matches(ATOMIC)) { units.push({ bi, cost: 24 }); return; }
    const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) if (n.nodeValue.trim()) units.push({ bi, node: n, full: n.nodeValue, cost: n.nodeValue.length });
  });
  Object.assign(TYPING, { blocks, units, total: units.reduce((a, u) => a + u.cost, 0) });
  paintTyping();
}
function paintTyping() {
  let left = TYPING.shown, reached = -1;
  for (const u of TYPING.units) {
    const take = Math.max(0, Math.min(u.cost, left)); left -= u.cost;
    if (u.node) u.node.nodeValue = take >= u.cost ? u.full : u.full.slice(0, u.full.lastIndexOf(" ", take) + 1 || take);
    if (take > 0) reached = Math.max(reached, u.bi);
  }
  TYPING.blocks.forEach((b, bi) => b.classList.toggle("unrevealed", bi > reached));
}
function tickTyping() {
  if (!TYPING?.units) return;
  const follow = nearBottom();
  // About 75 characters a second, a comfortable reading pace; very long replies speed up so none takes more than ~8 seconds
  const now = performance.now(), dt = Math.min(100, now - (TYPING.at ?? now)); TYPING.at = now;
  TYPING.shown += (Math.max(75, TYPING.total / 8) * dt) / 1000;
  if (TYPING.shown >= TYPING.total) { TYPING = null; renderChatMessages(); } else paintTyping();
  if (follow) scrollChat(false);
  if (TYPING) requestAnimationFrame(tickTyping);
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
  $("#chat-input").value = ""; saveChat(); renderChatMessages(); setCrumbs("Agent", chatTitle()); scrollChat();
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
    CHAT_BUSY = false; saveChat();
    if (location.hash.startsWith("#/chat") && $("#chat-content")) { const follow = nearBottom(); startTyping(CHAT.length - 1); renderChatMessages(); if (follow) scrollChat(); }
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
// Chat-made payments have internal references (chat_…); never show one as the recipient's name
const draftName = (d, q) => q?.recipient?.name ?? billOf(d.payable)?.supplier ?? d.supplier ?? d.beneficiary?.name ?? (String(d.payable).startsWith("chat_") ? "Supplier" : d.payable);
// Match on the payable reference: a request keeps it, while its intent can be re-quoted at release (same as reqFor)
const requestFor = (d) => reqFor(d.payable);
const whenUtc = (iso) => (iso ? `${new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} · ${utc(iso)}` : "-");
const dayUtc = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "-");
const nonZero = (s) => Number(num(s)) !== 0;
const maskOf = (q) => maskedFor(q.recipient.name, q.recipient.maskedAccount);
const feesText = (q) => q.legs.map((l) => [`${money(l.fundingFee)} transfer`, nonZero(l.payoutFee) ? `${money(l.payoutFee)} payout` : null].filter(Boolean).join(" + ")).join(" · ");
const fxText = (q) => q.legs.filter((l) => Number(l.fxRate) !== 1 || !l.funded.endsWith(q.recipient.ccy)).map((l) => `${money(l.funded)} × ${fxFmt(l.fxRate)}`).join(" · ");
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
  html += agentTrail(a);
  return html;
}

// ------------------------------------------------------------------ the agents' work, in plain words
// Built only from what the agents reported (hops with timings, paid calls); nothing here is estimated.
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const secs = (ms) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const usdc = (list) => list.reduce((s, c) => s + Number(c.priceUsdc || 0), 0);
function agentTrail(a) {
  const hops = a?.hops ?? [], paid = a?.paidCalls ?? [], decisions = a?.decisions ?? [];
  if (!paid.length && !decisions.length) return "";   // nothing but the concierge reading the request: no trail to show
  const quotes = paid.filter((c) => /quote/i.test(c.service ?? "")), screens = paid.filter((c) => !/quote/i.test(c.service ?? ""));
  const providers = [...new Set(quotes.map((c) => String(c.service).split(/[:_]/).pop()))].map((p) => RAIL[p]?.replace(/^(Our|Your) /, "") ?? p);
  const screenHop = hops.find((h) => h.to === "compliance"), screenDone = hops.find((h) => h.from === "compliance"), quoteHop = hops.find((h) => h.to === "providers");
  const last = hops.findLast?.((h) => h.ms != null) ?? [...hops].reverse().find((h) => h.ms != null);
  const suppliers = Number(/\((\d+) suppliers?\)/.exec(screenHop?.message ?? "")?.[1] ?? decisions.length);
  const sim = paid.length && paid.every((c) => c.mock) ? " (simulated, no real payment)" : "";
  const pay = (list) => (list.length && usdc(list) > 0 ? ` · paid ${usdc(list).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")} test USDC${sim}` : sim);
  // this run's time next to the running average across all agent runs in this workspace
  const avg = a.agentStats?.average, vsAvg = (ms, k) => (ms == null ? "" : `${secs(ms)}${avg?.[k] && avg.runs > 1 ? ` · avg ${secs(Math.round(avg[k]))}` : ""}`);
  const steps = [["Concierge agent", "Read your request and matched it to your suppliers and invoices", ""]];
  if (screenHop) steps.push(["Compliance agent", `Checked ${plural(suppliers, "supplier")} and their bank details before any money could move${pay(screens)}`, vsAvg(screenDone?.ms, "compliance")]);
  if (quoteHop || quotes.length) steps.push(["Routing agent", `Bought ${plural(quotes.length, "live quote")}${providers.length ? ` (${providers.join(", ")})` : ""} and compared total cost and arrival time${pay(quotes)}`, vsAvg(quoteHop?.ms, "routing")]);
  if (decisions.length) {
    const ok = decisions.filter((d) => d.decision === "approve"), review = decisions.filter((d) => d.decision === "review"), held = decisions.filter((d) => !["approve", "review"].includes(d.decision));
    const railName = (p) => (RAIL[p] ?? p).replace(/^(Our|Your) /, (w) => w.toLowerCase());
    const pref = { cheapest: "lowest total cost", fastest: "fastest arrival", balanced: "a balance of cost and speed", lowest_risk: "lowest risk" }[a.policy] ?? "a balance of cost and speed";
    const what = decisions.length === 1
      ? (ok.length ? `Recommended ${railName(ok[0].chosen)}, the best fit for ${pref}` : review.length ? `Recommended ${railName(review[0].chosen)}, but flagged a check for a person first` : `Held this payment: ${(held[0].reasons ?? [])[0] ?? "no route qualified"}`)
      : [ok.length && `${ok.length} recommended`, review.length && `${review.length} need a check first`, held.length && `${held.length} held`].filter(Boolean).join(", ");
    steps.push(["Decision", `${what}. You still review and approve before anything is sent.`, ""]);
  }
  // how the work was split between the agents (paid calls each one made), as one stacked bar with a legend
  const split = [["Routing agent", quotes.length, "var(--viz-1)"], ["Compliance agent", screens.length, "var(--viz-2)"]].filter(([, n]) => n > 0), total = split.reduce((s, [, n]) => s + n, 0);
  const splitBar = total ? `<div class="split" role="img" aria-label="${esc(split.map(([w, n]) => `${w}: ${n} of ${total} calls`).join(", "))}">
      <div class="split-bar">${split.map(([w, n, c]) => `<i style="flex:${n};background:${c}" title="${esc(`${w}: ${n} call${n === 1 ? "" : "s"}`)}"></i>`).join("")}</div>
      <div class="split-legend">${split.map(([w, n, c]) => `<span><i style="background:${c}"></i>${esc(w)} · ${n} call${n === 1 ? "" : "s"}</span>`).join("")}${avg?.runs > 1 ? `<span class="muted">avg ${avg.paidCalls.toFixed(1)} calls per request</span>` : ""}</div></div>` : "";
  const receipts = paid.map((c) => {
    const href = typeof c.explorer === "string" && /^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-f]+$/i.test(c.explorer) ? c.explorer : null;
    return `<li>${esc(c.service)} · ${esc(c.priceUsdc)} test USDC${c.buyer ? ` · bought by ${esc(c.buyer)}` : ""} ${c.mock ? "(simulated)" : href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">View on chain ↗</a>` : ""}</li>`;
  }).join("");
  return `<section class="agent-trail" aria-label="How your agents handled this">
    <div class="trail-head"><b>How your agents handled this</b><span>${[last?.ms != null ? `${vsAvg(last.ms, "total")} total` : "", paid.length ? plural(paid.length, "paid call") : ""].filter(Boolean).join(" · ")}</span></div>
    <ol>${steps.map(([who, what, t]) => `<li><span class="dot" aria-hidden="true"></span><div><b>${esc(who)}</b><p>${esc(what)}</p></div>${t ? `<time>${esc(t)}</time>` : ""}</li>`).join("")}</ol>
    ${splitBar}
    ${receipts ? `<details class="chat-details"><summary>Receipts for the data the agents bought</summary><ul class="receipts">${receipts}</ul></details>` : ""}
  </section>`;
}
// The headline of a payment answer: money saved and time saved against your bank wire, from the router's own analysis
const daysText = (h) => (h >= 36 ? `${(h / 24).toFixed(1)} days sooner` : h >= 1 ? `${Math.round(h)} hours sooner` : h > -1 ? "About the same time" : `${Math.round(-h)} hours later`);
function impactRow(d, q) {
  const an = q?.analysis; if (!an?.baseline) return "";
  const net = num(an.value?.customerNetSaving), gross = num(an.value?.customerSavings), ccy = String(an.value?.customerNetSaving ?? "").split(" ")[1] ?? "USD";
  const hours = (Date.parse(an.baseline.arrivalUtc) - Date.parse(q.arrivalUtc)) / 3600e3;
  if (!(net > 0.005) && hours < 1) return `<div class="save-hero neutral"><div><span>Compared with your bank wire</span><b>Your bank is the best route here</b><small>No cheaper or faster route met this payment’s deadline</small></div></div>`;
  const share = num(q.sourceDebit) ? (net / num(q.sourceDebit)) * 100 : 0, bps = an.costVsMidBps ?? {};
  return `<div class="save-hero">
    <div><span>You save vs your bank wire</span><b>${esc(fmt(net))} ${esc(ccy)}</b><small>${gross > net ? `after Route402’s ${esc(money(an.value.platformFee))} fee · ` : ""}${share.toFixed(2)}% of the payment</small></div>
    <div><span>Arrives</span><b>${esc(daysText(hours))}</b><small>${esc(whenUtc(q.arrivalUtc))} vs ${esc(whenUtc(an.baseline.arrivalUtc))}</small></div>
    ${bps.plan != null && bps.bank != null ? `<div><span>Cost above the market rate</span><b>${(bps.plan / 100).toFixed(2)}% vs ${(bps.bank / 100).toFixed(2)}%</b><small>this route vs your bank</small></div>` : ""}
  </div>`;
}
// What was searched and the math behind the decision, with this payment's own numbers
function howWeGotHere(d, q) {
  const an = q?.analysis; if (!an) return "";
  const all = [an, ...(d.options ?? []).filter((o) => o.intentId && o.intentId !== d.intentId).map((o) => quote(o.intentId)?.data?.analysis).filter(Boolean)];
  const routes = all.reduce((s, x) => s + (x.searched?.routes ?? 0), 0), eligible = all.reduce((s, x) => s + (x.searched?.eligible ?? 0), 0);
  const rails = [...new Set(all.flatMap((x) => x.searched?.rails ?? []))], nets = [...new Set(all.flatMap((x) => x.searched?.networks ?? []))];
  const excluded = {}; all.forEach((x) => Object.entries(x.searched?.excluded ?? {}).forEach(([k, n]) => { excluded[k] = (excluded[k] ?? 0) + n; }));
  const T = typeof termsOf === "function" ? termsOf(q) : null, b = an.baseline, v = an.value ?? {}, m = an.model ?? {}, bps = an.costVsMidBps ?? {};
  const src = String(q.sourceDebit).split(" ")[1], dest = q.recipient.ccy, fixedSource = q.amountType === "SOURCE_FIXED";
  const transit = (iso) => Math.max(0, (Date.parse(iso) - Date.parse(an.plannedAtUtc ?? q.capturedAt)) / 86400e3);
  const ourDays = transit(q.arrivalUtc), bankDays = b ? transit(b.arrivalUtc) : null, perDay = num(q.sourceDebit) * (m.costOfCashPct ?? 0) / 100 / 365;
  const cash = bankDays != null && bankDays > ourDays ? perDay * (bankDays - ourDays) : 0;
  const line = (k, v2) => `<div class="math-row"><span>${esc(k)}</span><b>${v2}</b></div>`;
  return `<section class="how" aria-label="How we got here">
    <div class="how-head"><b>How we got here</b><span>${routes} routes compared · ${eligible} qualified</span></div>
    <div class="how-grid">
      <div><span class="how-k">Where we searched</span><p>${esc(rails.join(", "))}${nets.length ? ` · ${nets.length} blockchain network${nets.length === 1 ? "" : "s"} (${esc(nets.join(", "))})` : ""}</p>
        ${Object.keys(excluded).length ? `<p class="muted">Ruled out: ${Object.entries(excluded).map(([k, n]) => `${n} ${esc(k)}`).join(" · ")}</p>` : ""}</div>
      <div><span class="how-k">Decision rule</span><p>${an.objective === "fastest" ? "Fastest arrival that meets the deadline" : an.objective === "cheapest" ? "Lowest total cost that meets the deadline" : "Lowest total cost plus the cost of money in transit"}, after the compliance and safety checks</p></div>
    </div>
    <div class="math">
      ${line("Market rate", `1 ${esc(src)} = ${esc(Number(m.mid).toFixed(4))} ${esc(dest)} <small>${esc(m.midSource ?? "")}</small>`)}
      ${an.alternatives ? line("Cost and speed options", [["cheapest", "Lowest cash cost"], ["fastest", "Fastest arrival"], ["balanced", "Best combined value"]].map(([key, label]) => {
        const p = an.alternatives[key]; return p ? `${esc(label)}: ${esc(money(p.sourceDebit))} route amount${num(p.platformFee) ? ` + ${esc(money(p.platformFee))} Route402 fee` : ""}; arrives ${esc(whenUtc(p.arrivalUtc))}` : "";
      }).filter(Boolean).join("<br>")) : ""}
      ${T ? line("This route", `${esc(money(q.sourceDebit))} = ${esc(feesLine(T))} fees + ${esc(T.principal)} converted${T.converts ? ` at ${esc(T.rate)}` : ""}`) : ""}
      ${bps.plan != null ? line("Cost above the market rate", `${(bps.plan / 100).toFixed(2)}% this route · ${bps.bank != null ? `${(bps.bank / 100).toFixed(2)}% your bank` : "no bank baseline"} <small>(what you pay − its value at the market rate) ÷ value at the market rate</small>`) : ""}
      ${b ? line(fixedSource ? "Supplier receives" : "Your bank would charge", fixedSource ? `${esc(money(q.recipientNet))} here vs ${esc(money(b.recipientNet))} through your bank` : `${esc(money(b.sourceDebit))} vs ${esc(money(q.sourceDebit))} here`) : ""}
      ${v.customerSavings ? line("Saving", `${esc(money(v.customerSavings))}${num(v.platformFee) ? ` − ${esc(money(v.platformFee))} Route402 fee = <strong>${esc(money(v.customerNetSaving))} you keep</strong> <small>${esc(v.feeRule ?? "")}</small>` : ""}`) : ""}
      ${bankDays != null ? line("Money in transit", `${ourDays.toFixed(1)} days here vs ${bankDays.toFixed(1)} days by bank wire${cash > 0.5 ? ` · at your ${esc(m.costOfCashPct)}% cost of cash that is worth <strong>${esc(fmt(cash))} ${esc(src)}</strong> (amount × ${esc(m.costOfCashPct)}% ÷ 365 × ${(bankDays - ourDays).toFixed(1)} days)` : ""}`) : ""}
    </div>
  </section>`;
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
  const leg = q?.legs?.[0], tokenized = String(leg?.routeId ?? "").startsWith("tokenized:");   // your bank's quote can be its tokenized-deposit rail
  const head = `<div class="proposal-head"><b>${esc(tokenized ? leg.label : opt.label ?? (d.chosen ? RAIL[d.chosen] ?? d.chosen : name))}</b><span class="badge ${kind}">${esc(badge)}</span></div>`;
  const reasons = (d.reasons ?? []).filter((r) => !r.startsWith("compared:"));
  if (!d.intentId) return `<section class="proposal held">${head}<p class="msg-text">${esc(name)}</p><ul class="reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></section>`;
  const amount = (label, value) => `<div class="amt"><span>${esc(label)}</span><b>${q ? money(value) : qs?.status === "error" ? "—" : `<i class="skel-line"></i>`}</b></div>`;
  const rows = q ? [["Fees (already included)", feesText(q)], ["Exchange", fxText(q)], ["Estimated arrival", `${whenUtc(q.arrivalUtc)}${q.plan === "split" ? ` · split across ${q.legs.length} routes` : ""}`]].filter(([, v]) => v) : [];
  const timing = d.timing ?? {}, note = [q && q.recipient.maskedAccount !== "no account on file" ? `Saved ${q.recipient.ccy} details ${maskOf(q)}` : null,
    timing.deadlineUtc ? `Requested delivery: ${dayUtc(timing.deadlineUtc)}` : null, timing.latestStartUtc ? `Start by ${whenUtc(timing.latestStartUtc)}` : null].filter(Boolean).join(" · ");
  const alts = (d.options ?? []).filter((o) => o.provider !== d.chosen);
  return `<section class="proposal">${head}
    <div class="amounts">${amount("You pay, fees included", q?.sourceDebit)}${ICON("arrow-right", 18, "arrow")}${amount(`${name} receives`, q?.recipientNet)}</div>
    ${qs?.status === "error" ? `<p class="msg-note">Quote details unavailable: ${esc(qs.error)}</p>` : ""}
    ${impactRow(d, q)}
    ${exposureNote(q)}
    <div class="divider"></div>
    ${rows.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}
    ${note ? `<p class="proposal-note">${esc(note)}</p>` : ""}
    ${(d.needs ?? []).length ? `<p class="proposal-note warn">Needs: ${esc(d.needs.join("; "))}</p>` : ""}
    ${withAction ? reviewAction(a, index, current, [d]) : ""}
  </section>
  ${alts.length ? `<div class="alts">${alts.map((o) => alternative(o, d, q)).join("")}</div>` : ""}
  ${howWeGotHere(d, q)}
  ${q ? `<p class="msg-note">${q.amountType === "SOURCE_FIXED" ? `Every option below sends the same ${esc(money(q.sourceDebit))}; they differ in what ${esc(name)} receives.` : `Every option below delivers ${esc(money(q.recipientNet))} to ${esc(name)}; they differ in what you pay.`} These ${q.simulation ? "simulated" : "test-network"} prices hold until ${esc(utc(q.expiresAt))}.</p>` : ""}
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
    ["routing", "US routing number, if applicable"], ["swift", "SWIFT / BIC, if applicable"], ["usdcWallet", "USDC wallet (optional)"],
    ["street", "Street address"], ["city", "Town / city"], ["postcode", "Postcode"]];
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
