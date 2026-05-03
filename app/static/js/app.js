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
      (v === "constitution"  && view === "constitution")   ||
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
    default:
      container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Not found</div></div>`;
  }
}

// ── Tab navigation ─────────────────────────────────────────────────────────

document.getElementById("topbar-tabs").addEventListener("click", e => {
  const btn = e.target.closest("[data-view]");
  if (!btn) return;
  const v = btn.dataset.view;
  if (v === "org")           navigate("org");
  else if (v === "swarm")    navigate("swarm/" + (_lastSwarmId || ""));
  else if (v === "constitution") navigate("constitution/" + (_lastAgentId || ""));
  else if (v === "runs")     navigate("runs");
  else if (v === "library")  navigate("library");
  else if (v === "inbox")    navigate("inbox");
  else if (v === "settings") navigate("settings");
});

// Track last-visited swarm and agent for tab re-activation
export let _lastSwarmId = "";
export let _lastAgentId = "";
export function setLastSwarm(id) { _lastSwarmId = id; }
export function setLastAgent(id) { _lastAgentId = id; }

// ── Global search (Cmd+K) ─────────────────────────────────────────────────

document.getElementById("global-search").addEventListener("focus", () => {
  // Simple: just a placeholder for now, focus moves to field
});
document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    document.getElementById("global-search").focus();
  }
  if (e.key === "Escape") {
    document.getElementById("global-search").blur();
    // Close any open modal
    document.querySelectorAll(".modal-veil").forEach(m => m.remove());
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────

// Apply persisted branding (primary / accent custom properties) before the
// first paint settles, so the user's theme is in effect on every screen, not
// just after they visit the Settings tab.
applyBrandingOnBoot();

// Refresh the Inbox count pip on boot and whenever the SSE stream sees a
// human-action event. Cheap; just bumps a number in the topbar.
refreshInboxPip();

sseConnect();
window.addEventListener("popstate", render);
render();
