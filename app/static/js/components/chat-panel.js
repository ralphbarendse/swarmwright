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
import { renderMarkdown, highlightCodeBlocks } from "./markdown.js";
import { parseDelimited } from "./csv.js";
import { icon } from "../icons.js";
import { fileIcon } from "./file-preview.js";

const SCOPE_ORG       = "org";
const SCOPE_WORKSPACE = "workspace";
const WAIT_TIMEOUT_MS = 90_000;
const ATTACH_TEXT_MAX = 256 * 1024; // bytes — above this we don't fetch a text preview inline

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
        <span class="concierge-bubble-icon">${icon("concierge-bell", { size: 22 })}</span>
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
    this._historyOpen = false;
    // Remember the active conversation per scope so reopening resumes it.
    this._sessionKey = `sw-chat-session-${scope}-${workspaceId || "org"}`;
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
      // On a phone the on-screen keyboard's Enter inserts a newline (you can't
      // shift-Enter) — send only via the button. On desktop Enter still sends.
      if (e.key === "Enter" && !e.shiftKey && !_isMobileShell()) { e.preventDefault(); this._send(); }
    });
    // Auto-grow the textarea up to a few lines as the message gets longer.
    field?.addEventListener("input", () => {
      field.style.height = "auto";
      field.style.height = Math.min(field.scrollHeight, 140) + "px";
    });
    el.querySelector(".chat-wipe-btn")?.addEventListener("click", () => this._wipe());
    el.querySelector(".chat-collapse-btn")?.addEventListener("click", () => this.onClose?.());

    if (this.scope === SCOPE_ORG) {
      el.querySelectorAll(".chat-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => this._switchTab(btn.dataset.tab));
      });
      el.querySelector(".chat-hist-btn")?.addEventListener("click", () => this._openHistory());
      el.querySelector(".chat-history-close")?.addEventListener("click", () => this._closeHistory());
      this._wireDrawerSwipe(el.querySelector(".chat-history-drawer"));
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
           <button class="chat-tab-btn active" data-tab="chat">${icon("settings", { size: 14 })} Operator · Chat</button>
           <button class="chat-tab-btn" data-tab="signals">Signals <span class="chat-signal-badge" style="display:none"></span></button>
           <span class="chat-model-tag" style="display:none"></span>
           <button class="chat-hist-btn" title="Conversations">${icon("history", { size: 14 })} History</button>
           <button class="chat-edit-btn" title="Edit operator constitution" style="display:none">Edit</button>
         </div>
         <div class="chat-subtitle">Builds &amp; manages your platform — create swarms, trigger runs, review signals.</div>`
      : `<div class="chat-widget-header chat-widget-header--concierge">
           <span class="chat-header-icon">${icon("concierge-bell", { size: 20 })}</span>
           <div class="chat-header-titles">
             <span class="chat-header-title">Concierge <span class="chat-model-tag" style="display:none"></span></span>
             <span class="chat-header-sub">Tell me what you need — I'll route it to the right swarm.</span>
           </div>
           ${this.onClose ? `<button class="chat-collapse-btn" title="Minimise">${icon("x", { size: 16 })}</button>` : ""}
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
      </div>
      ${isOp ? `
      <div class="chat-history-drawer" style="display:none">
        <div class="chat-history-head">
          <span class="chat-history-title">Conversations</span>
          <button class="chat-history-close" title="Back to chat">${icon("x", { size: 16 })}</button>
        </div>
        <div class="chat-history-list" id="chat-history-list">
          <div class="chat-loading-init">Loading…</div>
        </div>
      </div>` : ""}`;
  }

  // ── Session / message loading ──────────────────────────────────────────────

  async _init() {
    try {
      const sess = await api.createOrGetChatSession({
        scope: this.scope,
        workspace_id: this.workspaceId || null,
      });
      // createOrGet returns the most recent session (and scope-level model/swarm
      // info). Prefer a previously-active conversation if we have one saved.
      const saved = this.scope === SCOPE_ORG ? localStorage.getItem(this._sessionKey) : null;
      if (saved) this.sessionId = Number(saved);
      else this._setActiveSession(sess.id);
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
      try {
        await this._loadMessages();
      } catch (_) {
        // Saved conversation was deleted/invalid — fall back to the latest one.
        this._setActiveSession(sess.id);
        await this._loadMessages();
      }
      if (this.scope === SCOPE_ORG) await this._loadSignals();
    } catch (err) {
      toastError(err);
    }
  }

  _setActiveSession(id) {
    this.sessionId = id;
    if (this.scope === SCOPE_ORG && id != null) {
      try { localStorage.setItem(this._sessionKey, String(id)); } catch (_) { /* ignore */ }
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
      _wireAttachments(el);
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
          toggle.innerHTML = `${icon("chevron-right", { size: 13 })} Activity`;
          return;
        }
        body.style.display = "block";
        toggle.innerHTML = `${icon("chevron-down", { size: 13 })} Activity`;
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

  _msgHtml({ role, content, run_id, attachments }) {
    if (role === "system") {
      return `<div class="chat-msg chat-msg-system"><div class="chat-bubble">${_escContent(content)}</div></div>`;
    }
    if (role === "user") {
      return `<div class="chat-msg chat-msg-user"><div class="chat-bubble">${_escContent(content)}</div></div>`;
    }
    const runTrail = run_id
      ? `<div class="chat-run-trail" data-run-id="${_esc(run_id)}">
           <button class="chat-run-trail-toggle">${icon("chevron-right", { size: 13 })} Activity</button>
           <div class="chat-run-trail-body" style="display:none"></div>
         </div>`
      : "";
    return `<div class="chat-msg chat-msg-assistant">
      <div class="chat-bubble chat-bubble-md">${_mdToHtml(content)}</div>
      ${_attachmentsHtml(attachments)}
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
    // The first reply may have auto-titled the conversation — reflect it.
    if (this._historyOpen) await this._loadSessions();
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

  // ── Conversation history (multiple sessions) ──────────────────────────────

  async _newChat() {
    if (this.waiting) return;
    try {
      const sess = await api.createOrGetChatSession({
        scope: this.scope,
        workspace_id: this.workspaceId || null,
        new: true,
      });
      this._setActiveSession(sess.id);
      this._closeHistory();
      if (this.activeTab !== "chat") this._switchTab("chat");
      const el = this._el?.querySelector("#chat-messages");
      if (el) el.innerHTML = `<div class="chat-empty">Ask me to create workspaces, swarms, trigger runs, or inspect unmet signals.</div>`;
      this._el?.querySelector(".chat-input-field")?.focus();
    } catch (err) {
      toastError(err);
    }
  }

  _openHistory() {
    const drawer = this._el?.querySelector(".chat-history-drawer");
    if (!drawer) return;
    this._historyOpen = true;
    drawer.style.display = "flex";
    requestAnimationFrame(() => drawer.classList.add("is-open"));
    this._loadSessions();
  }

  _closeHistory() {
    const drawer = this._el?.querySelector(".chat-history-drawer");
    if (!drawer) return;
    this._historyOpen = false;
    drawer.classList.remove("is-open");
    drawer.style.display = "none";
  }

  // Swipe-right anywhere on the drawer dismisses it (the slide-over comes in
  // from the right, so swiping it back out is the natural gesture on a phone).
  _wireDrawerSwipe(drawer) {
    if (!drawer) return;
    let x0 = null, y0 = null;
    drawer.addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0]; x0 = t.clientX; y0 = t.clientY;
    }, { passive: true });
    drawer.addEventListener("touchend", (e) => {
      if (x0 == null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      if (dx > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) this._closeHistory();
      x0 = y0 = null;
    }, { passive: true });
  }

  async _loadSessions() {
    const el = this._el?.querySelector("#chat-history-list");
    if (!el) return;
    try {
      const sessions = await api.listChatSessions({
        scope: this.scope,
        workspace_id: this.workspaceId || "",
      });
      const newRow = `<button class="chat-hist-new">＋ New conversation</button>`;
      const rows = sessions.map(s => {
        const active = String(s.id) === String(this.sessionId) ? " is-active" : "";
        const count = s.message_count != null ? `${s.message_count} msg` : "";
        return `<div class="chat-hist-row${active}" data-id="${s.id}">
          <button class="chat-hist-open" title="Open conversation">
            <span class="chat-hist-row-title">${_esc(s.title || "New conversation")}</span>
            <span class="chat-hist-row-meta">${_relTime(s.updated_at)}${count ? " · " + count : ""}</span>
          </button>
          <button class="chat-hist-del" title="Delete conversation" data-id="${s.id}">${icon("x", { size: 14 })}</button>
        </div>`;
      }).join("");
      el.innerHTML = newRow + (sessions.length ? rows : `<div class="chat-empty">No past conversations.</div>`);

      el.querySelector(".chat-hist-new")?.addEventListener("click", () => this._newChat());
      el.querySelectorAll(".chat-hist-row").forEach(row => {
        const id = Number(row.dataset.id);
        row.querySelector(".chat-hist-open")?.addEventListener("click", () => this._switchSession(id));
        row.querySelector(".chat-hist-del")?.addEventListener("click", (e) => {
          e.stopPropagation();
          this._deleteSession(id);
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="chat-empty" style="color:var(--color-danger)">Could not load history</div>`;
    }
  }

  async _switchSession(id) {
    if (String(id) === String(this.sessionId)) { this._closeHistory(); return; }
    this._setActiveSession(id);
    if (this.activeTab !== "chat") this._switchTab("chat");
    this._closeHistory();
    await this._loadMessages();
  }

  async _deleteSession(id) {
    try {
      await api.deleteChatSession(id);
      if (String(id) === String(this.sessionId)) {
        // Deleted the open conversation — resume the most recent remaining one
        // (createOrGet makes a fresh one if none are left).
        if (this.scope === SCOPE_ORG) { try { localStorage.removeItem(this._sessionKey); } catch (_) {} }
        const sess = await api.createOrGetChatSession({
          scope: this.scope,
          workspace_id: this.workspaceId || null,
        });
        this._setActiveSession(sess.id);
        await this._loadMessages();
      }
      await this._loadSessions();
    } catch (err) {
      toastError(err);
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
    const stepGlyph = s.step_type === "skill_call" ? icon("settings", { size: 12 })
      : s.step_type === "agent_call" ? icon("bot", { size: 13 }) : "·";
    const label = _esc(s.step_name || s.step_type || "");
    const dur = s.duration_ms != null ? `${s.duration_ms}ms` : "";
    return `<div class="chat-trail-step">
      <span class="chat-trail-icon">${stepGlyph}</span>
      <span class="chat-trail-label">${label}</span>
      <span class="chat-trail-dur">${dur}</span>
    </div>`;
  }).join("");

  return `<div class="chat-trail">
    <div class="chat-trail-status" style="color:${statusColor}">${_esc(run.status)}</div>
    ${stepRows}
    <a class="chat-trail-link" href="#runs/${_esc(run.id)}" onclick="window.swNav('runs/${_esc(run.id)}');return false;">View full run ${icon("arrow-right", { size: 13 })}</a>
  </div>`;
}

// ── Attachments ───────────────────────────────────────────────────────────────

function _attachmentsHtml(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return "";
  const cards = attachments.map((att) => {
    const dl = api.downloadSwarmFileUrl(att.swarm_id, att.path);
    const size = att.size_bytes != null ? ` · ${_fmtBytes(att.size_bytes)}` : "";
    return `<div class="chat-attach" data-att="${_esc(JSON.stringify(att))}">
      <div class="chat-attach-head">
        <span class="chat-attach-icon">${_attIcon(att)}</span>
        <span class="chat-attach-name" title="${_esc(att.path)}">${_esc(att.filename)}</span>
        <span class="chat-attach-size">${size}</span>
        <a class="chat-attach-dl" href="${dl}" title="Download" download>${icon("download", { size: 15 })}</a>
      </div>
      <div class="chat-attach-body"></div>
    </div>`;
  }).join("");
  return `<div class="chat-attachments">${cards}</div>`;
}

function _wireAttachments(container) {
  container.querySelectorAll(".chat-attach").forEach((card) => {
    if (card.dataset.wired) return;
    card.dataset.wired = "1";
    let att;
    try { att = JSON.parse(card.dataset.att); } catch { return; }
    _renderAttachmentPreview(card.querySelector(".chat-attach-body"), att);
  });
}

function _renderAttachmentPreview(body, att) {
  if (!body) return;
  const raw  = api.rawSwarmFileUrl(att.swarm_id, att.path);
  const mime = att.mime || "";
  const ext  = (att.filename.split(".").pop() || "").toLowerCase();

  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) {
    body.innerHTML = `<img class="chat-attach-img" src="${raw}" alt="">`;
    return;
  }

  // Everything else needs the text; bail out (download-only) for binaries and big files.
  const textish = ["md", "markdown", "csv", "tsv", "txt", "log", "json", "yaml", "yml", "xml",
    "html", "css", "js", "ts", "py", "sh", "ini", "toml", "env", "conf", "sql"].includes(ext);
  if (!textish || (att.size_bytes != null && att.size_bytes > ATTACH_TEXT_MAX)) return;

  fetch(raw).then(r => r.ok ? r.text() : Promise.reject(r.status)).then((text) => {
    if (ext === "md" || ext === "markdown") {
      body.innerHTML = `<div class="fv-md chat-attach-md">${renderMarkdown(text)}</div>`;
      highlightCodeBlocks(body);
    } else if (ext === "csv" || ext === "tsv") {
      body.innerHTML = _attachCsvHtml(text, ext === "tsv" ? "\t" : ",");
    } else {
      const pre = document.createElement("pre");
      pre.className = "chat-attach-pre";
      const code = document.createElement("code");
      code.className = `language-${ext}`;
      code.textContent = text;
      pre.appendChild(code);
      body.innerHTML = "";
      body.appendChild(pre);
      if (typeof hljs !== "undefined") { try { hljs.highlightElement(code); } catch { /* plain */ } }
    }
  }).catch(() => { /* leave download-only on fetch failure */ });
}

const _ATTACH_CSV_MAX_ROWS = 50;

function _attachCsvHtml(text, delim) {
  const rows = parseDelimited(text, delim);
  if (rows.length < 2) return `<pre class="chat-attach-pre">${_esc(text)}</pre>`;
  const head = rows[0];
  const cols = head.length;
  const shown = rows.slice(1, 1 + _ATTACH_CSV_MAX_ROWS);
  const th = head.map(c => `<th>${_esc(c)}</th>`).join("");
  const trs = shown.map(r =>
    `<tr>${Array.from({ length: cols }, (_, i) => `<td>${_esc(r[i] ?? "")}</td>`).join("")}</tr>`).join("");
  const more = rows.length - 1 > _ATTACH_CSV_MAX_ROWS
    ? `<div class="chat-attach-more">… ${rows.length - 1 - _ATTACH_CSV_MAX_ROWS} more rows — download for the full file</div>`
    : "";
  return `<div class="fv-csv-wrap chat-attach-csv"><table class="fv-csv">
    <thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>${more}`;
}

function _attIcon(att) {
  return fileIcon(att.mime || "", att.filename, 15);
}

function _fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function _isMobileShell() {
  return document.documentElement.classList.contains("sw-mobile");
}

function _relTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60)     return "just now";
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
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
