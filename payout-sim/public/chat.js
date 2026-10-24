// Plain-language requests go through the Fetch.ai concierge, including its paid quote and screening tools.
// Conversation state stays in this tab. A prompt never approves or executes a payment.
let CHAT = [], CHAT_BUSY = false, CHAT_FOLLOWUP = "", CHAT_INPUT = "";
try {
  const saved = JSON.parse(sessionStorage.getItem("r402-chat") ?? "{}");
  if (Array.isArray(saved.messages)) CHAT = saved.messages.filter((m) => m && ["user", "assistant"].includes(m.role)).slice(-60);
  CHAT_FOLLOWUP = typeof saved.followup === "string" ? saved.followup : "";
} catch {}
function saveChat() {
  try { sessionStorage.setItem("r402-chat", JSON.stringify({ messages: CHAT.slice(-60), followup: CHAT_FOLLOWUP })); } catch {}
}
const CHAT_EXAMPLES = [
  ["Pay suppliers", "Pay my German suppliers this week"],
  ["Find savings", "How much can I save this month"],
  ["Check bank details", "Check my suppliers' bank details"],
];

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
  });
  renderChatMessages(); updateChatContext();
}

function updateChatContext(available = true) {
  const el = $("#chat-context"); if (!el) return;
  el.textContent = !available ? "Company data unavailable · you can still ask" : STATE ? `${STATE.company} · ${STATE.localSimulation ? "local simulation" : STATE.connected ? "bank connected" : "demo data"}` : "Route402 · demo";
}
function syncChatComposer() {
  const input = $("#chat-input"), send = $("#chat-send"); if (!input || !send) return;
  send.disabled = CHAT_BUSY || !input.value.trim();
  send.innerHTML = CHAT_BUSY ? `Working <span class="spinner" aria-hidden="true"></span>` : `Send <span aria-hidden="true">↗</span>`;
  input.setAttribute("aria-busy", String(CHAT_BUSY));
  $("#new-chat").disabled = CHAT_BUSY;
  $("#chat-input-note").textContent = CHAT_FOLLOWUP ? "Reply with the missing detail, or type a new request" : "Enter to send · Shift + Enter for a new line";
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
  // The calculator is stateless: retain the original request when it asks for a missing detail.
  const newRequest = /^(pay|send|transfer|wire|convert|exchange|swap|check|verify|validate|how|what|run|settle)\b/i.test(text);
  const request = CHAT_FOLLOWUP && !newRequest ? `${CHAT_FOLLOWUP}\n${text}` : text;
  if (request.length > 500) {
    CHAT.push({ role: "assistant", error: "Please shorten the request to 500 characters, including the original request if you're answering a clarification." }); saveChat(); renderChatMessages(); return;
  }
  CHAT.push({ role: "user", text }); CHAT_INPUT = ""; CHAT_BUSY = true;
  $("#chat-input").value = ""; saveChat(); renderChatMessages();
  try {
    const answer = await api("/ask", { text: request });
    if (!answer || !["ok", "clarification", "blocked"].includes(answer.status)) throw new Error(answer?.error || "The agents returned an incomplete response. Please try again.");
    CHAT_FOLLOWUP = answer.status === "clarification" ? request : "";
    CHAT.push({ role: "assistant", answer });
  } catch (e) {
    CHAT.push({ role: "assistant", error: e.message });
    if (!CHAT_INPUT) CHAT_INPUT = text;
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
  if (decisions.some((d) => ["approve", "review"].includes(d.decision) && d.intentId)) html += `<button class="btn primary sm" data-chat-prepare="${index}">Prepare for approval</button>`;
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
  if (!ME) { signIn(() => prepareChat(index)); return; }
  modal(`<h2>Prepare this payment plan?</h2><p>Create requests for eligible payments. Start immediately after approval; recheck the deadline before sending. Your company's approval controls apply.</p><label class="confirm"><input type="checkbox" id="chat-reroute"/> Allow another quoted route to the same supplier if it meets the deadline and stays within the approved debit cap.</label><label class="confirm"><input type="checkbox" id="chat-confirm"/> I checked the supplier, invoice, fees and delivery estimate, including any cost exception needing approval.</label><div id="chat-prepare-error" role="alert"></div><div class="actions"><button class="btn ghost" id="chat-cancel">Cancel</button><button class="btn primary" id="chat-prepare-submit" disabled>Prepare for approval</button></div>`);
  $("#chat-cancel").onclick = closeModal;
  $("#chat-confirm").onchange = (e) => { $("#chat-prepare-submit").disabled = !e.target.checked; };
  $("#chat-prepare-submit").onclick = async (e) => {
    const button = e.currentTarget; button.disabled = true;
    try {
      const result = await api("/requests", { confirmed: true, allowReroute: $("#chat-reroute").checked, decisions: answer.decisions, purpose: answer.title || "Payment planned in chat" });
      const requests = result.requests ?? [], created = requests.filter((r) => r.requestId);
      if (!created.length) throw new Error(requests.map((r) => r.skipped).join("; ") || result.error || "No payment requests were created.");
      closeModal(); location.hash = created.length === 1 ? `#/payments/${created[0].requestId}` : "#/payments";
    } catch (error) { $("#chat-prepare-error").textContent = error.message; button.disabled = false; }
  };
}

document.querySelector("#new-chat").addEventListener("click", () => {
  if (CHAT_BUSY) return;
  CHAT = []; CHAT_INPUT = ""; CHAT_FOLLOWUP = ""; saveChat();
  if (location.hash === "#/chat") pageChat($("#page")); else location.hash = "#/chat";
});
