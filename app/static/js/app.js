/**
 * SwarmWright — main application entry point and router.
 *
 * Routes:
 *   #org                   — workspace list
 *   #org/ws/<id>           — workspace detail
 *   #swarm/<id>            — swarm canvas
 *   #constitution/<id>     — constitution editor (agent)
 *   #runs                  — runs list
 *   #runs/<id>             — run detail
 *   #library               — skills + knowledge
 *   #files                 — org-wide file browser (all swarms)
 */

import * as api from "./api.js";
import { connect as sseConnect, onEvent as onSseEvent } from "./sse.js";
import { renderOrgView }          from "./views/org-design.js";
import { renderSwarmCanvas }      from "./views/swarm-canvas.js";
import { renderConstitutionEditor } from "./views/constitution-editor.js";
import { renderRunsView }         from "./views/runs.js";
import { renderLibraryView }      from "./views/library.js";
import { renderFilesView }        from "./views/files.js";
import { renderMobileFilesView }  from "./views/mobile-files.js";
import { renderSettingsView, applyBrandingOnBoot } from "./views/settings.js";
import { renderInboxView, refreshInboxPip }       from "./views/inbox.js";
import { renderWelcomeView }                      from "./views/welcome.js";
import { renderOnboardingView }                   from "./views/onboarding.js";
import { setCurrentUser, currentUser, canDo, logout } from "./auth.js";
import { mountChatWidget }                          from "./components/chat-panel.js";

// ── Router ────────────────────────────────────────────────────────────────────

function parseHash() {
  const raw = location.hash.slice(1) || "org";
  const parts = raw.split("/");
  return { view: parts[0], segments: parts.slice(1) };
}

let _activeCleanup = null;

function navigate(hash) {
  if (!hash.startsWith("#")) hash = "#" + hash;
  history.pushState(null, "", hash);
  render();
}

// Expose globally so views can call navigate()
window.swNav = navigate;

function render() {
  let { view, segments } = parseHash();

  // On mobile, authoring/config surfaces are hidden. Any route that isn't a
  // mobile destination (incl. deep links someone followed from a desktop link)
  // bounces to the mobile home rather than rendering a broken desktop view.
  if (_mobileMode && !_mobileAllowed(view)) {
    view = MOBILE_HOME; segments = [];
    history.replaceState(null, "", "#" + MOBILE_HOME);
  }

  const main = document.getElementById("main");

  // Highlight active tab
  document.querySelectorAll(".topbar-tab").forEach(btn => {
    const v = btn.dataset.view;
    const active =
      (v === "org"           && (view === "org"))          ||
      (v === "swarm"         && view === "swarm")          ||
      (v === "runs"          && view === "runs")           ||
      (v === "library"       && view === "library")        ||
      (v === "inbox"         && view === "inbox")          ||
      (v === "settings"      && view === "settings");
    btn.classList.toggle("active", active);
  });

  // Run cleanup from previous view
  if (_activeCleanup) { try { _activeCleanup(); } catch (_) {} _activeCleanup = null; }

  main.innerHTML = "";
  const container = document.createElement("div");
  container.className = "view";
  main.appendChild(container);

  switch (view) {
    case "org":
      _activeCleanup = renderOrgView(container, segments);
      break;
    case "swarm":
      _activeCleanup = renderSwarmCanvas(container, segments[0]);
      break;
    case "constitution":
      _activeCleanup = renderConstitutionEditor(container, segments[0]);
      break;
    case "runs":
      _activeCleanup = renderRunsView(container, segments[0]);
      break;
    case "library":
      _activeCleanup = renderLibraryView(container, segments);
      break;
    case "files":
      _activeCleanup = _mobileMode
        ? renderMobileFilesView(container)
        : renderFilesView(container);
      break;
    case "settings":
      _activeCleanup = renderSettingsView(container, segments);
      break;
    case "inbox":
      _activeCleanup = renderInboxView(container, segments);
      break;
    case "welcome":
      renderWelcomeView(container);
      break;
    case "onboarding":
      renderOnboardingView(container);
      break;
    case "chat":
      _activeCleanup = renderMobileChat(container);
      break;
    default:
      container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Not found</div></div>`;
  }

  if (_mobileMode) _updateMobileNav(view);
}

// ── Tab navigation ─────────────────────────────────────────────────────────

function _handleTabClick(e) {
  const btn = e.target.closest("[data-view]");
  if (!btn) return;
  const v = btn.dataset.view;
  // Primary destinations (Org/Swarm/Control Room/Library) now live on the
  // Org hub; the topbar only carries utility actions.
  if (v === "inbox")         navigate("inbox");
  else if (v === "settings") navigate("settings");
}

document.getElementById("topbar-tabs").addEventListener("click", _handleTabClick);
document.querySelector(".topbar-right").addEventListener("click", _handleTabClick);
document.querySelector(".topbar-logo").addEventListener("click", () => navigate("org"));

// Track last-visited swarm and agent for tab re-activation
export let _lastSwarmId = "";
export let _lastAgentId = "";
export function setLastSwarm(id) { _lastSwarmId = id; }
export function setLastAgent(id) { _lastAgentId = id; }

// ── Global search (Cmd+K) ─────────────────────────────────────────────────

const _searchEl = document.getElementById("global-search");
if (_searchEl) _searchEl.addEventListener("focus", () => {});
document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    document.getElementById("global-search")?.focus();
  }
  if (e.key === "Escape") {
    document.getElementById("global-search")?.blur();
    // Close any open modal
    document.querySelectorAll(".modal-veil").forEach(m => m.remove());
  }
});

// ── User widget ────────────────────────────────────────────────────────────

function _renderUserWidget(user) {
  const right = document.querySelector(".topbar-right");
  if (!right) return;

  // Remove any existing user widget
  right.querySelector(".user-widget")?.remove();

  const chip = document.createElement("div");
  chip.className = "user-widget";
  chip.innerHTML = `
    <span class="user-widget-name">${_escHtml(user.display_name || user.username)}</span>
    <button class="user-widget-logout" title="Sign out">↩</button>
  `;
  chip.querySelector(".user-widget-logout").addEventListener("click", logout);
  right.appendChild(chip);
}

function _escHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

// ── Copy to clipboard helper ──────────────────────────────────────────────

window.swCopy = function(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = "✓";
    btn.style.color = "var(--color-success)";
    setTimeout(() => { btn.textContent = orig; btn.style.color = ""; }, 1500);
  });
};

// ── Mobile ─────────────────────────────────────────────────────────────────
//
// Phase 9. A phone is for consuming, conversing, and approving — never
// authoring. The mobile shell reuses the desktop views (one codebase) but
// swaps the topbar for a thumb-reachable bottom tab bar and exposes only the
// read/decide destinations: Chat, Signals (inbox), and Runs.

const MOBILE_HOME = "chat";

let _mobileMode = false;
let _mobileNavEl = null;

// Bottom-tab definitions. `view` is the route the tab navigates to; `show`
// gates visibility on the same per-user permissions the desktop uses.
const MOBILE_TABS = [
  { id: "chat",    view: "chat",  icon: "💬", label: "Chat",
    show: () => canDo("can_chat_operator") || canDo("can_chat_workspace") },
  { id: "signals", view: "inbox", icon: "🔔", label: "Signals", pip: true,
    show: () => canDo("can_decide_inbox") },
  { id: "runs",    view: "runs",  icon: "📡", label: "Runs",
    show: () => canDo("can_chat_operator") || canDo("can_start_run") || canDo("can_stop_run") },
  { id: "files",   view: "files", icon: "📁", label: "Files",
    show: () => canDo("can_read_files") },
];

function _isMobile() {
  return window.matchMedia("(max-width: 768px)").matches;
}

// Which routes are reachable on mobile = the visible tabs (plus run detail,
// which lives under the Runs tab and is navigated to internally).
function _mobileAllowed(view) {
  if (view === "runs") return MOBILE_TABS.find(t => t.id === "runs").show();
  return MOBILE_TABS.some(t => t.show() && t.view === view);
}

function _bootMobile() {
  _mobileMode = true;
  document.documentElement.classList.add("sw-mobile");
  document.querySelector(".topbar").style.display = "none";

  const visible = MOBILE_TABS.filter(t => t.show());

  // No mobile-eligible surface for this user → honest dead end.
  if (!visible.length) {
    document.getElementById("main").innerHTML = `
      <div class="mobile-unsupported">
        <div style="font-size:32px">📵</div>
        <div class="mobile-unsupported-title">Mobile not available for your account</div>
        <div>Open SwarmWright on a desktop, or contact your administrator.</div>
      </div>`;
    return;
  }

  _buildMobileNav(visible);
  sseConnect();
  if (visible.some(t => t.id === "signals")) _bindMobilePip();
  window.addEventListener("popstate", render);

  // Land on the home tab unless the deep link already points at an allowed one.
  const { view } = parseHash();
  if (!_mobileAllowed(view)) history.replaceState(null, "", "#" + MOBILE_HOME);
  render();
}

function _buildMobileNav(tabs) {
  const nav = document.createElement("nav");
  nav.className = "mobile-tabbar";
  nav.innerHTML = tabs.map(t => `
    <button class="mobile-tab" data-view="${t.view}" data-id="${t.id}">
      <span class="mobile-tab-icon">${t.icon}</span>
      <span class="mobile-tab-label">${t.label}</span>
      ${t.pip ? `<span class="mobile-tab-pip" hidden></span>` : ""}
    </button>`).join("");
  nav.addEventListener("click", e => {
    const btn = e.target.closest(".mobile-tab");
    if (btn) navigate(btn.dataset.view);
  });
  document.getElementById("app").appendChild(nav);
  _mobileNavEl = nav;
}

// Map the current route back onto a tab for the active-state highlight.
function _updateMobileNav(view) {
  if (!_mobileNavEl) return;
  const activeId = view === "inbox" ? "signals" : view === "runs" ? "runs" : view === "files" ? "files" : "chat";
  _mobileNavEl.querySelectorAll(".mobile-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.id === activeId);
  });
}

// Signals tab badge — mirrors the desktop inbox pip (pending actions + unread
// informs), refreshed from the server on the same SSE events.
async function _updateMobilePip() {
  const pip = _mobileNavEl?.querySelector(".mobile-tab-pip");
  if (!pip) return;
  try {
    const [actions, informs] = await Promise.all([
      api.listInbox({ status: "pending", limit: "200" }),
      api.listInforms({ status: "unread", limit: "200" }),
    ]);
    const total = (actions?.length ?? 0) + (informs?.length ?? 0);
    pip.hidden = !total;
    pip.textContent = total ? String(total) : "";
  } catch { /* offline / boot — ignore */ }
}

function _bindMobilePip() {
  ["human_action.pending", "human_action.resolved", "run.awaiting_human",
   "run.resumed", "human_inform.pending", "human_inform.acked"]
    .forEach(ev => onSseEvent(ev, () => _updateMobilePip()));
  _updateMobilePip();
}

// ── Mobile Chat tab ─────────────────────────────────────────────────────────
//
// Operators get the org-level Operator chat. Everyone else gets their
// workspace Concierge — the front desk, which the old chat-only mobile path
// wrongly walled off behind a "not supported" screen.

function renderMobileChat(container) {
  container.classList.add("mobile-chat-host");

  if (canDo("can_chat_operator")) {
    return mountChatWidget({ scope: "org", container });
  }

  // Concierge needs a workspace. Resolve which one, then mount.
  let destroy = null;
  const host = document.createElement("div");
  host.style.cssText = "flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;";
  container.appendChild(host);

  const mountConcierge = (wsId) => {
    destroy?.();
    host.innerHTML = "";
    destroy = mountChatWidget({ scope: "workspace", workspaceId: wsId, container: host });
  };

  (async () => {
    let workspaces = [];
    try { workspaces = await api.listWorkspaces(); } catch { /* handled below */ }

    if (!workspaces.length) {
      host.innerHTML = `
        <div class="mobile-unsupported">
          <div style="font-size:32px">🛎</div>
          <div class="mobile-unsupported-title">No workspace yet</div>
          <div>Ask your administrator to add you to a workspace.</div>
        </div>`;
      return;
    }

    if (workspaces.length > 1) {
      // Light switcher so a member of several workspaces can pick a front desk.
      const bar = document.createElement("div");
      bar.className = "mobile-ws-switch";
      bar.innerHTML = `<label>Workspace</label>
        <select class="form-select">
          ${workspaces.map(w => `<option value="${w.id}">${_escHtml(w.display_name || w.name || w.id)}</option>`).join("")}
        </select>`;
      container.insertBefore(bar, host);
      bar.querySelector("select").addEventListener("change", e => mountConcierge(e.target.value));
    }
    mountConcierge(workspaces[0].id);
  })();

  return () => destroy?.();
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

function _registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* non-fatal */ });
  });
}

applyBrandingOnBoot();

async function boot() {
  try {
    const res = await fetch("/api/v1/auth/me");
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    const { user } = await res.json();
    setCurrentUser(user);
    _renderUserWidget(user);
  } catch {
    window.location.href = "/login";
    return;
  }

  _registerServiceWorker();

  if (_isMobile()) {
    _bootMobile();
    return;
  }

  refreshInboxPip();
  sseConnect();
  window.addEventListener("popstate", render);
  render();
}

boot();
