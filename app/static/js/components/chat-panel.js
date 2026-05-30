/**
 * chat-panel.js — Inline chat widget.
 *
 * Two modes:
 *   scope = "org"       → Operator chat (platform-level, has Signals tab)
 *   scope = "workspace" → Concierge chat (workspace-level, routes requests)
 *
 * Use mountChatWidget({ scope, workspaceId, title, container }) to render
 * inline into any element. Returns a destroy function.
 */
import * as api from "../api.js";
import { onEvent, offEvent } from "../sse.js";
import { toastError } from "./toast.js";

const SCOPE_ORG       = "org";
const SCOPE_WORKSPACE = "workspace";
const WAIT_TIMEOUT_MS = 90_000;

export function mountChatWidget({ scope, workspaceId = null, title = null, container, onClose = null }) {
  const widget = new ChatWidget({ scope, workspaceId, title, container, onClose });
  widget.mount();
  return () => widget.destroy();
}

/**
 * mountConciergeLauncher — floating bubble that expands into an anchored
 * popover chat. Used for workspace-scoped concierge so it reads as a
 * lightweight "front desk" you summon, distinct from the always-docked
 * operator panel. Returns a destroy function.
 */
export function mountConciergeLauncher({ workspaceId, title = null, container }) {
  const launcher = new ConciergeLauncher({ workspaceId, title, container });
  launcher.mount();
  return () => launcher.destroy();
}

// ── ConciergeLauncher class ─────────────────────────────────────────────────────

class ConciergeLauncher {
  constructor({ workspaceId, title, container }) {
    this.workspaceId   = workspaceId;
    this.title         = title;
    this.container     = container;
    this.open          = false;
    this._root         = null;
    this._widgetDestroy = null;
    this._stateKey     = `sw-concierge-open-${workspaceId}`;
    this._onDocKey     = this._onDocKey.bind(this);
  }

  mount() {
    const root = document.createElement("div");
    root.className = "concierge-launcher";
    root.innerHTML = `
      <div class="concierge-popover" style="display:none">
        <div class="concierge-popover-inner"></div>
      </div>
      <button class="concierge-bubble" title="Concierge — ask for anything">
        <span class="concierge-bubble-icon">🛎</span>
        <span class="concierge-bubble-label">Concierge</span>
      </button>`;
    this.container.appendChild(root);
    this._root = root;

    root.querySelector(".concierge-bubble").addEventListener("click", () => this._toggle());
    document.addEventListener("keydown", this._onDocKey);

    if (localStorage.getItem(this._stateKey) === "1") this._open();
  }

  _toggle() { this.open ? this._close() : this._open(); }

  _open() {
    if (this.open) return;
    this.open = true;
    this._root.classList.add("is-open");
    this._root.querySelector(".concierge-popover").style.display = "flex";

    if (!this._widgetDestroy) {
      const inner = this._root.querySelector(".concierge-popover-inner");
      this._widgetDestroy = mountChatWidget({
        scope: SCOPE_WORKSPACE,
        workspaceId: this.workspaceId,
        title: this.title,
        container: inner,
        onClose: () => this._close(),
      });
    }
    localStorage.setItem(this._stateKey, "1");
  }

  _close() {
    if (!this.open) return;
    this.open = false;
    this._root.classList.remove("is-open");
    this._root.querySelector(".concierge-popover").style.display = "none";
    localStorage.setItem(this._stateKey, "0");
  }

  _onDocKey(e) {
    if (e.key === "Escape" && this.open) this._close();
  }

  destroy() {
    document.removeEventListener("keydown", this._onDocKey);
    this._widgetDestroy?.();
    this._widgetDestroy = null;
    this._root?.remove();
    this._root = null;
  }
}

// ── ChatWidget class ────────────────────────────────────────────────────────────

class ChatWidget {
  constructor({ scope, workspaceId, title, container, onClose = null }) {
    this.scope       = scope;
    this.workspaceId = workspaceId;
    this.title       = title || (scope === SCOPE_ORG ? "Operator" : "Concierge");
    this.container   = container;
    this.onClose     = onClose;
    this.sessionId   = null;
    this.swarmId     = null;
    this.waiting     = false;
    this.activeTab   = "chat";
    this._el         = null;
    this._waitTimer  = null;
    this._sseHandler       = this._onSseComplete.bind(this);
    this._signalHandler    = this._onSignalNew.bind(this);
    this._stepHandler      = this._onChatStep.bind(this);
    this._signalBadgeCount = 0;
    this._modelInfo  = null;
  }

  mount() {
    const el = document.createElement("div");
    el.className = "chat-widget";
    el.innerHTML = this._html();
    this.container.appendChild(el);
    this._el = el;

    const field   = el.querySelector(".chat-input-field");
    const sendBtn = el.querySelector(".chat-input-send");
    sendBtn?.addEventListener("click", () => this._send());
    field?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this._send(); }
    });
    el.querySelector(".chat-wipe-btn")?.addEventListener("click", () => this._wipe());
    el.querySelector(".chat-collapse-btn")?.addEventListener("click", () => this.onClose?.());

    if (this.scope === SCOPE_ORG) {
      el.querySelectorAll(".chat-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => this._switchTab(btn.dataset.tab));
      });
      onEvent("signal.new", this._signalHandler);
    }

    onEvent("chat.complete", this._sseHandler);
    onEvent("chat.step",     this._stepHandler);
    this._init();
  }

  destroy() {
    clearTimeout(this._waitTimer);
    offEvent("chat.complete", this._sseHandler);
    offEvent("chat.step",     this._stepHandler);
    offEvent("signal.new",    this._signalHandler);
    this._el?.remove();
    this._el = null;
  }

  // ── Template ───────────────────────────────────────────────────────────────

  _html() {
    const isOp = this.scope === SCOPE_ORG;
    const header = isOp
      ? `<div class="chat-tabs">
           <button class="chat-tab-btn active" data-tab="chat">⚙ Operator · Chat</button>
           <button class="chat-tab-btn" data-tab="signals">Signals <span class="chat-signal-badge" style="display:none"></span></button>
           <span class="chat-model-tag" style="display:none"></span>
           <button class="chat-edit-btn" title="Edit operator constitution" style="display:none">Edit</button>
         </div>
         <div class="chat-subtitle">Builds &amp; manages your platform — create swarms, trigger runs, review signals.</div>`
      : `<div class="chat-widget-header chat-widget-header--concierge">
           <span class="chat-header-icon">🛎</span>
           <div class="chat-header-titles">
             <span class="chat-header-title">Concierge <span class="chat-model-tag" style="display:none"></span></span>
             <span class="chat-header-sub">Tell me what you need — I'll route it to the right swarm.</span>
           </div>
           ${this.onClose ? `<button class="chat-collapse-btn" title="Minimise">✕</button>` : ""}
         </div>`;

    const placeholder = isOp
      ? "Create a swarm, trigger a run, check signals…"
      : "Ask for something…";

    return `
      ${header}
      <div class="chat-body">
        <div class="chat-messages" id="chat-messages">
          <div class="chat-loading-init">Loading…</div>
        </div>
        <div class="chat-input-area">
          <textarea class="chat-input-field" placeholder="${placeholder}" rows="2"></textarea>
          <div class="chat-input-row">
            <button class="btn btn-ghost btn-sm chat-wipe-btn">Clear history</button>
            <button class="btn btn-primary btn-sm chat-input-send">Send</button>
          </div>
        </div>
      </div>
      <div class="chat-signals-body" id="chat-signals-body" style="display:none">
        <div class="chat-signals-list" id="chat-signals-list">
          <div class="chat-loading-init">Loading…</div>
        </div>
      </div>`;
  }

  // ── Session / message loading ──────────────────────────────────────────────

  async _init() {
    try {
      const sess = await api.createOrGetChatSession({
        scope: this.scope,
        workspace_id: this.workspaceId || null,
      });
      this.sessionId = sess.id;
      if (sess.model_info) this._setModelTag(sess.model_info);
      if (sess.swarm_id && this.scope === SCOPE_ORG) {
        this.swarmId = sess.swarm_id;
        const editBtn = this._el?.querySelector(".chat-edit-btn");
        if (editBtn) {
          editBtn.style.display = "inline-block";
          editBtn.addEventListener("click", () => {
            if (window.swNav) window.swNav(`swarm/${this.swarmId}`);
          });
        }
      }
      await this._loadMessages();
      if (this.scope === SCOPE_ORG) await this._loadSignals();
    } catch (err) {
      toastError(err);
    }
  }

  _setModelTag(info) {
    const tag = this._el?.querySelector(".chat-model-tag");
    if (!tag) return;
    const provider = info.provider || "";
    const model    = info.model    || "";
    const label    = model !== "default" && model !== "unknown"
      ? `${provider} · ${model}`
      : provider || "unknown";
    tag.textContent = label;
    tag.style.display = "inline-block";
  }

  async _loadMessages() {
    if (!this.sessionId) return;
    const msgs = await api.listChatMessages(this.sessionId, { limit: 100 });
    const el = this._el?.querySelector("#chat-messages");
    if (!el) return;

    if (!msgs.length) {
      el.innerHTML = `<div class="chat-empty">${
        this.scope === SCOPE_ORG
          ? "Ask me to create workspaces, swarms, trigger runs, or inspect unmet signals."
          : "Tell me what you need and I'll route your request to the right swarm."
      }</div>`;
    } else {
      el.innerHTML = msgs.map(m => this._msgHtml(m)).join("");
      el.scrollTop = el.scrollHeight;
      this._wireRunTrails(el);
    }
  }

  _wireRunTrails(container) {
    container.querySelectorAll(".chat-run-trail").forEach(trail => {
      const toggle = trail.querySelector(".chat-run-trail-toggle");
      const body   = trail.querySelector(".chat-run-trail-body");
      const runId  = trail.dataset.runId;
      if (!toggle || !body || !runId) return;

      toggle.addEventListener("click", async () => {
        const open = body.style.display !== "none";
        if (open) {
          body.style.display = "none";
          toggle.textContent = "▸ Activity";
          return;
        }
        body.style.display = "block";
        toggle.textContent = "▾ Activity";
        if (body.dataset.loaded) return;
        body.dataset.loaded = "1";
        body.innerHTML = `<div class="chat-trail-loading">Loading…</div>`;
        try {
          const run = await api.getRun(runId);
          body.innerHTML = _renderRunTrail(run);
        } catch (_) {
          body.innerHTML = `<div class="chat-trail-loading" style="color:var(--color-danger)">Could not load run</div>`;
        }
      });
    });
  }

  _msgHtml({ role, content, run_id }) {
    if (role === "system") {
      return `<div class="chat-msg chat-msg-system"><div class="chat-bubble">${_escContent(content)}</div></div>`;
    }
    if (role === "user") {
      return `<div class="chat-msg chat-msg-user"><div class="chat-bubble">${_escContent(content)}</div></div>`;
    }
    const runTrail = run_id
      ? `<div class="chat-run-trail" data-run-id="${_esc(run_id)}">
           <button class="chat-run-trail-toggle">▸ Activity</button>
           <div class="chat-run-trail-body" style="display:none"></div>
         </div>`
      : "";
    return `<div class="chat-msg chat-msg-assistant">
      <div class="chat-bubble chat-bubble-md">${_mdToHtml(content)}</div>
      ${runTrail}
    </div>`;
  }

  _appendMessage(role, content) {
    const el = this._el?.querySelector("#chat-messages");
    if (!el) return;
    el.querySelector(".chat-empty")?.remove();
    const wrap = document.createElement("div");
    wrap.innerHTML = this._msgHtml({ role, content });
    el.appendChild(wrap.firstElementChild);
    el.scrollTop = el.scrollHeight;
  }

  _showThinking() {
    const el = this._el?.querySelector("#chat-messages");
    if (!el || el.querySelector("#chat-thinking")) return;
    const div = document.createElement("div");
    div.id        = "chat-thinking";
    div.className = "chat-msg chat-msg-assistant";
    div.innerHTML = `<div class="chat-bubble chat-thinking">
      <div class="chat-step-trail"></div>
      <div class="chat-thinking-dots"><span></span><span></span><span></span></div>
    </div>`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  _hideThinking() {
    this._el?.querySelector("#chat-thinking")?.remove();
  }

  _onChatStep(msg) {
    if (String(msg.session_id) !== String(this.sessionId)) return;
    const trail = this._el?.querySelector("#chat-thinking .chat-step-trail");
    if (!trail) return;
    // Mark the previous in-progress step as done.
    trail.querySelector(".chat-step-chip.active")?.classList.remove("active");
    const chip = document.createElement("div");
    chip.className = "chat-step-chip active";
    chip.textContent = _stepLabel(msg);
    trail.appendChild(chip);
    const msgs = this._el?.querySelector("#chat-messages");
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }

  _setInputEnabled(on) {
    const field   = this._el?.querySelector(".chat-input-field");
    const sendBtn = this._el?.querySelector(".chat-input-send");
    if (field)   { field.disabled   = !on; }
    if (sendBtn) { sendBtn.disabled = !on; }
    if (on) field?.focus();
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  async _send() {
    if (this.waiting || !this.sessionId) return;
    const field = this._el?.querySelector(".chat-input-field");
    const content = field?.value.trim();
    if (!content) return;

    this.waiting = true;
    field.value = "";
    this._setInputEnabled(false);
    this._appendMessage("user", content);
    this._showThinking();

    // Timeout fallback — reload messages if SSE never arrives
    this._waitTimer = setTimeout(() => {
      this._onTimeout();
    }, WAIT_TIMEOUT_MS);

    try {
      await api.sendChatMessage(this.sessionId, content);
    } catch (err) {
      this._onTimeout();
      toastError(err);
    }
  }

  _onTimeout() {
    clearTimeout(this._waitTimer);
    if (!this.waiting) return;
    this.waiting = false;
    this._hideThinking();
    this._setInputEnabled(true);
    this._loadMessages();
  }

  // ── SSE ───────────────────────────────────────────────────────────────────

  async _onSseComplete(msg) {
    if (msg.session_id !== this.sessionId) return;
    clearTimeout(this._waitTimer);
    this.waiting = false;
    this._hideThinking();
    this._setInputEnabled(true);
    await this._loadMessages();
    if (this.scope === SCOPE_ORG && this.activeTab === "signals") {
      await this._loadSignals();
    }
  }

  // ── Wipe ─────────────────────────────────────────────────────────────────

  async _wipe() {
    if (!this.sessionId) return;
    try {
      await api.wipeChatMessages(this.sessionId);
      await this._loadMessages();
    } catch (err) {
      toastError(err);
    }
  }

  // ── SSE: new signal from any concierge ───────────────────────────────────

  async _onSignalNew() {
    if (this.activeTab === "signals") {
      await this._loadSignals();
    } else {
      this._signalBadgeCount++;
      const badge = this._el?.querySelector(".chat-signal-badge");
      if (badge) {
        badge.textContent = this._signalBadgeCount;
        badge.style.display = "inline-block";
      }
    }
  }

  // ── Tabs (operator only) ──────────────────────────────────────────────────

  _switchTab(tab) {
    this.activeTab = tab;
    const chatBody    = this._el?.querySelector(".chat-body");
    const signalsBody = this._el?.querySelector("#chat-signals-body");
    if (!chatBody || !signalsBody) return;
    chatBody.style.display    = tab === "chat"    ? "" : "none";
    signalsBody.style.display = tab === "signals" ? "" : "none";
    this._el?.querySelectorAll(".chat-tab-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    if (tab === "signals") {
      // Clear badge when user opens the tab
      this._signalBadgeCount = 0;
      const badge = this._el?.querySelector(".chat-signal-badge");
      if (badge) { badge.textContent = ""; badge.style.display = "none"; }
      this._loadSignals();
    }
  }

  // ── Signals (unmet needs) ─────────────────────────────────────────────────

  async _loadSignals() {
    const el = this._el?.querySelector("#chat-signals-list");
    if (!el) return;
    try {
      const needs = await api.listUnmetNeeds({ status: "open" });
      if (!needs.length) {
        el.innerHTML = `<div class="chat-empty">No open signals.</div>`;
        return;
      }
      el.innerHTML = needs.map(n => this._needHtml(n)).join("");
      el.querySelectorAll(".need-dismiss-btn").forEach(btn => {
        btn.addEventListener("click", () => this._patchNeed(btn.dataset.id, "dismissed"));
      });
      el.querySelectorAll(".need-address-btn").forEach(btn => {
        btn.addEventListener("click", () => this._patchNeed(btn.dataset.id, "addressed"));
      });
    } catch (_) {
      el.innerHTML = `<div class="chat-empty" style="color:var(--color-danger)">Could not load signals</div>`;
    }
  }

  _needHtml(n) {
    const ts = n.created_at ? _reltime(n.created_at) : "";
    return `
      <div class="chat-need" data-id="${n.id}">
        <div class="chat-need-text">${_esc(n.verbatim_request)}</div>
        ${n.concierge_summary ? `<div class="chat-need-summary">${_esc(n.concierge_summary)}</div>` : ""}
        <div class="chat-need-foot">
          <span class="chat-need-time">${ts}</span>
          <div style="display:flex;gap:4px">
            <button class="btn btn-ghost btn-sm need-dismiss-btn" data-id="${n.id}" style="font-size:10px">Dismiss</button>
            <button class="btn btn-primary btn-sm need-address-btn" data-id="${n.id}" style="font-size:10px">Address</button>
          </div>
        </div>
      </div>`;
  }

  async _patchNeed(id, status) {
    try {
      await api.patchUnmetNeed(parseInt(id, 10), { status });
      await this._loadSignals();
    } catch (err) {
      toastError(err);
    }
  }
}

// ── Skill step labels ─────────────────────────────────────────────────────────

const _SKILL_LABELS = {
  list_swarms:                "Checking swarms…",
  list_workspace_swarms:      "Checking workspace…",
  list_workspaces:            "Listing workspaces…",
  create_workspace:           "Creating workspace…",
  create_swarm:               "Creating swarm…",
  patch_swarm:                "Updating swarm…",
  patch_topology:             "Updating topology…",
  draft_constitution:         "Drafting constitution…",
  trigger_run:                "Triggering run…",
  list_runs:                  "Checking run history…",
  read_run:                   "Reading run…",
  create_skill:               "Creating skill…",
  flag_unmet_need:            "Flagging unmet need…",
  list_unmet_needs:           "Checking signals…",
  search_knowledge:           "Searching knowledge…",
  search_workspace_knowledge: "Searching workspace…",
};

// Turn a chat.step event into a human-readable progress label.
function _stepLabel(msg) {
  const name = msg.label || msg.skill || "";
  switch (msg.phase) {
    case "agent":         return `Delegating to ${name}…`;
    case "perceptionist": return `Consulting ${name}…`;
    case "swarm":         return `Invoking ${name}…`;
    case "skill":
    default:              return _SKILL_LABELS[name] || `${name}…`;
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

// ── Lightweight markdown → HTML ───────────────────────────────────────────────

function _inlineFmt(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g,     "<em>$1</em>")
    .replace(/`(.+?)`/g,       '<code class="chat-icode">$1</code>');
}

function _mdToHtml(md) {
  if (!md) return "";
  const lines       = md.split("\n");
  const out         = [];
  let listType      = null;   // "ul" | "ol" | null
  let inCode        = false;
  let codeAcc       = [];

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  // Collect table rows — flush when a non-table line appears
  let tableRows = [];
  const flushTable = () => {
    if (!tableRows.length) return;
    const [header, ...body] = tableRows.filter(r => !/^\|[-|: ]+\|$/.test(r.trim()));
    const thCells = (header || "").split("|").filter((_,i,a) => i > 0 && i < a.length - 1);
    const bodyRows = body.map(r => {
      const cells = r.split("|").filter((_,i,a) => i > 0 && i < a.length - 1);
      return `<tr>${cells.map(c => `<td>${_inlineFmt(_esc(c.trim()))}</td>`).join("")}</tr>`;
    });
    out.push(
      `<div class="chat-table-wrap"><table class="chat-table">` +
      `<thead><tr>${thCells.map(c => `<th>${_inlineFmt(_esc(c.trim()))}</th>`).join("")}</tr></thead>` +
      `<tbody>${bodyRows.join("")}</tbody></table></div>`
    );
    tableRows = [];
  };

  for (const raw of lines) {
    // ── fenced code blocks ───────────────────────────────
    if (raw.startsWith("```")) {
      flushTable();
      if (inCode) {
        out.push(`<pre class="chat-pre"><code>${_esc(codeAcc.join("\n"))}</code></pre>`);
        codeAcc = []; inCode = false;
      } else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeAcc.push(raw); continue; }

    // ── markdown tables ───────────────────────────────────
    if (/^\|.+\|$/.test(raw.trim())) {
      closeList();
      tableRows.push(raw.trim());
      continue;
    }
    flushTable();

    // ── list items ───────────────────────────────────────
    const ulM = raw.match(/^[-*]\s+(.*)/);
    const olM = raw.match(/^\d+\.\s+(.*)/);
    if (ulM) {
      if (listType !== "ul") { closeList(); out.push('<ul class="chat-list">'); listType = "ul"; }
      out.push(`<li>${_inlineFmt(_esc(ulM[1]))}</li>`);
      continue;
    }
    if (olM) {
      if (listType !== "ol") { closeList(); out.push('<ol class="chat-list">'); listType = "ol"; }
      out.push(`<li>${_inlineFmt(_esc(olM[1]))}</li>`);
      continue;
    }
    closeList();

    // ── headings ─────────────────────────────────────────
    const hM = raw.match(/^(#{1,3})\s+(.*)/);
    if (hM) {
      const tag = hM[1].length === 1 ? "chat-h1" : hM[1].length === 2 ? "chat-h2" : "chat-h3";
      out.push(`<div class="${tag}">${_inlineFmt(_esc(hM[2]))}</div>`);
      continue;
    }

    // ── divider ──────────────────────────────────────────
    if (/^---+$/.test(raw.trim())) { out.push('<hr class="chat-hr">'); continue; }

    // ── blank line ───────────────────────────────────────
    if (!raw.trim()) { out.push('<div class="chat-gap"></div>'); continue; }

    // ── normal line ──────────────────────────────────────
    out.push(`<div>${_inlineFmt(_esc(raw))}</div>`);
  }
  flushTable();
  closeList();
  if (inCode) out.push(`<pre class="chat-pre"><code>${_esc(codeAcc.join("\n"))}</code></pre>`);
  return out.join("");
}

function _renderRunTrail(run) {
  const statusColor = run.status === "completed"
    ? "var(--color-success)"
    : run.status === "failed" ? "var(--color-danger)" : "var(--color-warn)";
  const steps = (run.steps || []).filter(s => s.step_type !== "topology_violation");
  const stepRows = steps.map(s => {
    const icon = s.step_type === "skill_call" ? "⚙" : s.step_type === "agent_call" ? "◈" : "·";
    const label = _esc(s.step_name || s.step_type || "");
    const dur = s.duration_ms != null ? `${s.duration_ms}ms` : "";
    return `<div class="chat-trail-step">
      <span class="chat-trail-icon">${icon}</span>
      <span class="chat-trail-label">${label}</span>
      <span class="chat-trail-dur">${dur}</span>
    </div>`;
  }).join("");

  return `<div class="chat-trail">
    <div class="chat-trail-status" style="color:${statusColor}">${_esc(run.status)}</div>
    ${stepRows}
    <a class="chat-trail-link" href="#runs/${_esc(run.id)}" onclick="window.swNav('runs/${_esc(run.id)}');return false;">View full run →</a>
  </div>`;
}

function _esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _escContent(str) {
  return _esc(str).replace(/\n/g, "<br>");
}

function _reltime(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60)    return "just now";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
