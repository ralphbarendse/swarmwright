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
 */

import { connect as sseConnect } from "./sse.js";
import { renderOrgView }          from "./views/org-design.js";
import { renderSwarmCanvas }      from "./views/swarm-canvas.js";
import { renderConstitutionEditor } from "./views/constitution-editor.js";
import { renderRunsView }         from "./views/runs.js";
import { renderLibraryView }      from "./views/library.js";
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
  const { view, segments } = parseHash();
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
    default:
      container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Not found</div></div>`;
  }
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

// ── Mobile detection ───────────────────────────────────────────────────────

function _isMobile() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function _bootMobile() {
  // Hide desktop chrome
  document.querySelector(".topbar").style.display = "none";
  document.getElementById("main").style.cssText =
    "position:fixed;inset:0;display:flex;flex-direction:column;overflow:hidden;";

  const app = document.getElementById("app");
  app.style.cssText = "display:flex;flex-direction:column;height:100dvh;overflow:hidden;";

  if (canDo("can_chat_operator")) {
    sseConnect();
    const wrap = document.createElement("div");
    wrap.style.cssText = "flex:1;display:flex;flex-direction:column;overflow:hidden;";
    document.getElementById("main").appendChild(wrap);
    mountChatWidget({ scope: "org", container: wrap });
  } else {
    document.getElementById("main").innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;padding:32px;text-align:center;flex-direction:column;gap:12px;color:var(--color-ink-soft)">
        <div style="font-size:32px">📵</div>
        <div style="font-weight:600;font-size:16px;color:var(--color-ink)">Mobile version not supported</div>
        <div style="font-size:14px">Please contact your administrator.</div>
      </div>`;
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

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
