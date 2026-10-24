// Plain-language requests go through the Fetch.ai concierge, including its paid quote and screening tools.
// Structured context stays on the server; recent transcripts are saved in this browser. A prompt never approves or executes a payment.
let CHAT = [], CHAT_BUSY = false, CHAT_FOLLOWUP = "", CHAT_INPUT = "";
let CHAT_ID = crypto.randomUUID(), CHAT_REVISION = 0, SAVED_CHATS = [];
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
function renderChatHistory() {
  const el = document.querySelector("#chat-history"); if (!el) return;
  const workspace = typeof STATE !== "undefined" && STATE ? `${STATE.company}|${!!STATE.localSimulation}` : null;
  el.innerHTML = `<span class="history-label">Recent chats</span>${SAVED_CHATS.filter((c) => !workspace || !c.workspace || c.workspace === workspace).map((c) => `<button data-chat-open="${c.id}" class="${c.id === CHAT_ID ? "active" : ""}" ${CHAT_BUSY ? "disabled" : ""} title="${esc(c.title)}">${esc(c.title)}</button>`).join("")}`;
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
document.querySelector("#chat-history")?.addEventListener("click", (e) => { const button = e.target.closest("[data-chat-open]"); if (button) openChat(button.dataset.chatOpen); });

function pageChat(P) {
  P.innerHTML = `<div class="chat-workspace">
    <header class="chat-header"><span>YOUR PAYMENT ASSISTANT</span><span class="chat-context" id="chat-context">Route402 · testnet demo</span></header>
    <div class="chat-scroll" id="chat-scroll"><div class="chat-content" id="chat-content"></div></div>
    <div class="composer-wrap"><form class="composer" id="chat-form">
      <label class="sr-only" for="chat-input">Your request to the payment agents</label>
      <textarea id="chat-input" rows="2" maxlength="500" placeholder="Ask Route402 to plan a payment…" aria-describedby="chat-help"></textarea>
      <div class="composer-bottom"><span id="chat-input-note">Enter to send · Shift + Enter for a new line</span>
      <button type="submit" class="chat-send" id="chat-send" aria-label="Send request to agents">Send <span aria-hidden="true">↗</span></button></div>
    </form><p id="chat-help">Agents compare routes and check suppliers. Payments need your approval. <span>Demo environment · payouts simulated.</span></p></div>
  </div>`;
  const input = $("#chat-input"); input.value = CHAT_INPUT;
  input.addEventListener("input", () => { CHAT_INPUT = input.value; syncChatComposer(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!CHAT_BUSY) $("#chat-form").requestSubmit(); }
  });
  $("#chat-form").onsubmit = (e) => { e.preventDefault(); sendChat(input.value); };
  $("#chat-content").addEventListener("click", (e) => {
    const example = e.target.closest("[data-chat-example]");
    if (example) { input.value = CHAT_EXAMPLES[Number(example.dataset.chatExample)][1]; CHAT_INPUT = input.value; syncChatComposer(); input.focus(); }
    const prepare = e.target.closest("[data-chat-prepare]");
    if (prepare) prepareChat(Number(prepare.dataset.chatPrepare));
    const supplier = e.target.closest("[data-chat-supplier]");
    if (supplier) confirmChatSupplier(Number(supplier.dataset.chatSupplier));
  });
  renderChatMessages(); updateChatContext(); renderChatHistory(); void restoreChatContext();
}

function updateChatContext(available = true) {
  const el = $("#chat-context"); if (!el) return;
  const previous = SAVED_CHATS.find((c) => c.id === CHAT_ID)?.workspace;
  if (STATE && previous && previous !== `${STATE.company}|${!!STATE.localSimulation}` && !CHAT_BUSY) {
    CHAT_ID = crypto.randomUUID(); CHAT_REVISION = 0; CHAT = []; CHAT_INPUT = ""; CHAT_FOLLOWUP = ""; pageChat($("#page")); return;
  }
  el.textContent = !available ? "Company data unavailable · you can still ask" : STATE ? `${STATE.company} · ${STATE.localSimulation ? "local simulation" : STATE.connected ? "bank connected" : "demo data"}` : "Route402 · demo";
}
function syncChatComposer() {
  const input = $("#chat-input"), send = $("#chat-send"); if (!input || !send) return;
  send.disabled = CHAT_BUSY || !input.value.trim();
  send.innerHTML = CHAT_BUSY ? `Working <span class="spinner" aria-hidden="true"></span>` : `Send <span aria-hidden="true">↗</span>`;
  input.setAttribute("aria-busy", String(CHAT_BUSY));
  $("#new-chat").disabled = CHAT_BUSY;
  $("#chat-input-note").textContent = CHAT_FOLLOWUP ? "Reply with the missing detail, or type a new request" : "Follow up naturally · Enter to send";
  renderChatHistory();
}
function renderChatMessages() {
  const content = $("#chat-content"); if (!content) return;
  content.classList.toggle("has-messages", CHAT.length > 0);
  content.innerHTML = CHAT.length ? CHAT.map((m, i) => `<article class="chat-message ${m.role}"><div class="message-label">${m.role === "user" ? "You" : "Route402"}</div>
    <div class="message-body">${m.role === "user" ? `<p>${esc(m.text)}</p>` : m.error ? `<p class="chat-error" role="alert">${esc(m.error)}</p><p class="muted">Your request wasn't completed. You can send it again.</p>` : chatAnswer(m.answer, i)}</div></article>`).join("")
    : `<section class="chat-welcome"><div class="chat-emblem" aria-hidden="true">↗</div><p class="chat-eyebrow">LESS FRICTION. BETTER ROUTES.</p><h1>Where should your<br/>money go next?</h1>
      <p>Tell us what you need. Your agents will take it from here.</p>
      <div class="chat-examples">${CHAT_EXAMPLES.map(([label, prompt], i) => `<button data-chat-example="${i}"><span>${esc(label)} <b aria-hidden="true">↗</b></span><small>${esc(prompt)}</small></button>`).join("")}</div></section>`;
  if (CHAT_BUSY) content.insertAdjacentHTML("beforeend", `<article class="chat-message assistant"><div class="message-label">Route402</div><div class="message-body chat-working" role="status"><span class="spinner" aria-hidden="true"></span> Your agents are reviewing the request…<small>Quote and supplier checks can take a few minutes.</small></div></article>`);
  syncChatComposer();
  const scroll = $("#chat-scroll"); if (scroll && CHAT.length) scroll.scrollTop = scroll.scrollHeight;
}

async function sendChat(text) {
  text = text.trim(); if (!text || CHAT_BUSY) return;
  // The server resolves this turn against structured context; never concatenate old instructions or trust browser answers.
  const request = text;
  if (request.length > 500) {
    CHAT.push({ role: "assistant", error: "Please shorten this message to 500 characters." }); saveChat(); renderChatMessages(); return;
  }
  CHAT.push({ role: "user", text }); CHAT_INPUT = ""; CHAT_BUSY = true;
  $("#chat-input").value = ""; saveChat(); renderChatMessages();
  try {
    const answer = await api("/ask", { text: request, conversationId: CHAT_ID, conversationRevision: CHAT_REVISION });
    if (!answer || !["ok", "clarification", "blocked"].includes(answer.status)) throw new Error(answer?.error || "The agents returned an incomplete response. Please try again.");
    CHAT_FOLLOWUP = answer.status === "clarification" ? request : "";
    if (answer.conversationId === CHAT_ID && Number.isInteger(answer.conversationRevision)) CHAT_REVISION = answer.conversationRevision;
    CHAT.push({ role: "assistant", answer });
  } catch (e) {
    CHAT.push({ role: "assistant", error: e.message });
    if (!CHAT_INPUT) CHAT_INPUT = text;
    // A timed-out agent call may already have stored the draft. Synchronize its revision without retrying paid tools.
    try { const saved = await api(`/conversations/${CHAT_ID}`); if (Number.isInteger(saved.conversationRevision)) CHAT_REVISION = saved.conversationRevision; } catch {}
  } finally {
    CHAT_BUSY = false; saveChat(); renderChatMessages();
    const input = $("#chat-input"); if (input) { input.value = CHAT_INPUT; syncChatComposer(); input.focus(); }
    $("#new-chat").disabled = false;
  }
}

function chatTable(headers, rows) {
  if (!rows.length) return "";
  return `<div class="chat-table-wrap"><table class="chat-table"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v) => `<td>${esc(v ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function chatAnswer(a, index) {
  if (!a) return "<p>No response available. Please ask again.</p>";
  if (a.status === "clarification" || a.status === "blocked") return `${a.status === "blocked" ? "<h2>Let's resolve this first</h2>" : ""}<p>${esc(a.clarification || "Please add more detail to your request.")}</p>`;
  const p = a.preview ?? {}, view = p.preview ?? {}, decisions = a.decisions ?? [];
  let html = `<h2>${esc(a.title || p.title || "Here's what I found")}</h2>`;
  if (p.message) html += `<p>${esc(p.message)}</p>`;
  if (p.suppliers) html += chatTable(["Supplier company", "Country", "Currencies", "Linked bills", "Receiving details"], p.suppliers.map((s) => [s.name, s.country, s.currencies.join(", "), s.billIds.length, `${s.check} · ${s.maskedAccount}`]));
  if (p.transfers) html += chatTable(["Transfer", "Supplier", "Amount", "Status", "Deadline"], p.transfers.map((t) => [t.id, t.supplier, t.amount, t.status, t.deadlineStatus ?? "Awaiting evidence"]));
  if (p.reviewResults) html += chatTable(["Payment", "Agent decision", "Explanation"], p.reviewResults.map((r) => [r.supplier ?? r.payable, r.decision, (r.reasons ?? []).join("; ")]));
  if (p.action?.type === "add_supplier") {
    html += chatTable(["Supplier", "Country", "Currency"], [[p.supplierDraft.name, p.supplierDraft.country, p.supplierDraft.currency]]);
    html += `<button class="btn primary sm" data-chat-supplier="${index}" ${a.conversationRevision !== CHAT_REVISION ? "disabled" : ""}>Review & save supplier</button>`;
  }
  const facts = [["You pay", view.youPay], ["Supplier receives", view.theyGet], ["You receive", view.youGet], ["Savings vs your bank", view.youSave ?? p.companyKeeps], ["Estimated arrival", view.arrives ? when(view.arrives) : null]] .filter(([, value]) => value != null);
  if (facts.length) html += `<dl class="chat-facts">${facts.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>`;
  if (view.status && view.status !== "OK") html += `<p>${esc(view.reason || (view.missing ?? []).join("; ") || view.status)}</p>`;
  if (view.timing?.deadlineUtc) html += `<p class="chat-deadline">Recipient deadline: <b>${esc(when(view.timing.deadlineUtc))}</b>${view.timing.latestStartUtc ? ` · Start by ${esc(when(view.timing.latestStartUtc))}` : ""}</p>`;
  if (view.savingsStatus || p.savings) html += `<p class="muted">Projected savings before agent review and execution. Held payments are not payment commitments.</p>`;
  if (p.savings) html += chatTable(["Savings by lever", "Amount"], Object.entries(p.savings).map(([key, value]) => [key.replace(/([A-Z])/g, " $1"), value]));
  if (p.results) html += chatTable(["Supplier", "Bank details", "Notes"], p.results.map((r) => [r.supplier, r.status, (r.issues ?? []).join("; ") || "Checks passed"]));
  if (p.byCurrency) html += chatTable(["Currency", "Owed", "Confirmed incoming", "Expected"], Object.entries(p.byCurrency).map(([ccy, r]) => [ccy, fmt(r.owe), fmt(r.incoming), fmt(r.expected)]));
  if (view.lines?.length) html += `<p>${view.lines.length} bill${view.lines.length === 1 ? "" : "s"} in this plan${view.companyKeeps ? ` · ${esc(view.companyKeeps)} savings after fees` : ""}.</p>`;
  html += decisions.map((d) => {
    const option = d.options?.find((o) => o.provider === d.chosen), name = billOf(d.payable)?.supplier ?? d.payable;
    return `<section class="chat-decision"><div class="chat-decision-head"><b>${esc(name)}</b>${pill(d.decision === "approve" ? "ok" : "warn", d.decision === "approve" ? "Ready for your review" : d.decision === "review" ? "Needs review" : "On hold")}</div>
      ${option ? `<p>${esc(option.label ?? RAIL[d.chosen] ?? d.chosen)}${option.arrivalUtc ? ` · arrives ${esc(when(option.arrivalUtc))}` : ""}</p>` : ""}
      ${d.timing?.deadlineUtc ? `<p>Recipient deadline: <b>${esc(when(d.timing.deadlineUtc))}</b>${d.timing.latestStartUtc ? ` · Start by ${esc(when(d.timing.latestStartUtc))}` : ""}</p>` : ""}
      ${(d.needs ?? []).length ? `<p><b>Needs: ${esc(d.needs.join("; "))}</b></p>` : ""}
      <ul>${(d.reasons ?? []).filter((r) => !r.startsWith("compared:")).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></section>`;
  }).join("");
  if (decisions.some((d) => ["approve", "review"].includes(d.decision) && d.intentId)) html += `<button class="btn primary sm" data-chat-prepare="${index}" ${a.conversationId !== CHAT_ID || a.conversationRevision !== CHAT_REVISION ? "disabled" : ""}>${a.conversationRevision !== CHAT_REVISION ? "Plan changed · ask for a fresh preview" : "Prepare for approval"}</button>`;
  if (!decisions.length && view.lines?.length) html += chatTable(["Invoice", "Plan", "Amount to convert"], view.lines.map((r) => [r.payable, r.status || r.route || "See plan", r.convertedAmount ? `${r.convertedAmount} ${r.ccy}` : "Paid from balance"]));
  if (p.tip) html += `<p>${esc(p.tip)}</p>`;
  if (a.paidCalls?.length || a.hops?.length) html += `<details class="chat-details"><summary>Agent activity${a.paidCalls?.length ? ` · ${a.paidCalls.length} tool calls · ${esc(a.spentUsdc)} test USDC${a.paidCalls.every((c) => c.mock) ? " · local simulation" : ""}` : ""}</summary>
    <ol>${(a.hops ?? []).map((h) => `<li><b>${esc(h.from)} → ${esc(h.to)}</b> · ${esc(h.message)}</li>`).join("")}</ol>
    ${(a.paidCalls ?? []).map((c) => {
      const href = typeof c.explorer === "string" && /^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-f]+$/i.test(c.explorer) ? c.explorer : null;
      return `<p>${esc(c.service)} · ${esc(c.priceUsdc)} test USDC ${c.mock ? "(mock)" : href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">View transaction ↗</a>` : ""}</p>`;
    }).join("")}</details>`;
  return html;
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
      CHAT_REVISION = result.conversationRevision; CHAT.push({ role: "assistant", answer: result }); saveChat(); closeModal(); renderChatMessages();
      await loadAll(); updateChatContext();
    } catch (error) { $("#supplier-error").textContent = error.message; button.disabled = false; }
  };
}

document.querySelector("#new-chat").addEventListener("click", () => {
  if (CHAT_BUSY) return;
  saveChat(); CHAT_ID = crypto.randomUUID(); CHAT_REVISION = 0; CHAT = []; CHAT_INPUT = ""; CHAT_FOLLOWUP = ""; saveChat();
  if (location.hash === "#/chat") pageChat($("#page")); else location.hash = "#/chat";
});
