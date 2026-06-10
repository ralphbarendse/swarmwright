import * as api from "../api.js";
import { toast, toastError, toastSuccess } from "../components/toast.js";
import { canDo } from "../auth.js";
import { mountChatWidget, mountConciergeLauncher } from "../components/chat-panel.js";
import { icon } from "../icons.js";

let _chatDestroy = null;

/**
 * Org-design view.
 *
 * Routes:
 *   segments = []        → workspace list
 *   segments = ["ws", id] → workspace detail
 */
export function renderOrgView(container, segments = []) {
  if (_chatDestroy) { _chatDestroy(); _chatDestroy = null; }
  container.style.cssText = "display:flex;flex-direction:row;height:100%;overflow:hidden";

  if (segments[0] === "ws" && segments[1]) {
    _renderWorkspaceDetail(container, segments[1]);
  } else {
    _renderWorkspaceList(container);
  }
  return () => { if (_chatDestroy) { _chatDestroy(); _chatDestroy = null; } };
}

// ── Workspace list ─────────────────────────────────────────────────────────

async function _renderWorkspaceList(container) {
  const showChat = canDo("can_chat_operator");

  container.innerHTML = `
    <div style="flex:1;display:flex;flex-direction:column;min-width:0;overflow:hidden">
      <div class="page-header flex-row" style="justify-content:space-between;flex-shrink:0">
        <div>
          <div class="page-title">Workspaces</div>
          <div class="page-sub">Department-like containers for swarms</div>
        </div>
        <div class="flex-row">
          ${canDo("can_create_workspace") ? `<button class="btn btn-primary" id="btn-new-ws">+ New workspace</button>` : ""}
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;min-height:0;padding:0 24px 16px">
        <div id="ws-grid"></div>
      </div>
      <div id="snip-divider" class="snip-divider"></div>
      <div id="home-snippets" style="flex-shrink:0;overflow:hidden"></div>
    </div>
    ${showChat ? `<div class="chat-zone-divider" id="chat-divider"></div><div id="chat-zone" class="chat-zone"></div>` : ""}`;

  container.querySelector("#btn-new-ws")?.addEventListener("click", () => _showCreateWorkspaceModal(() => _renderWorkspaceList(container)));

  _wireSnippetDivider(container);

  try {
    const workspaces = await api.listWorkspaces();
    const grid = container.querySelector("#ws-grid");
    if (!workspaces.length) {
      grid.innerHTML = `<div class="empty-state"><div class="empty-state-icon" style="color:var(--color-ink-faint)">${icon("building-2", { size: 30 })}</div><div class="empty-state-title">No workspaces yet</div><div class="empty-state-sub">Create your first workspace to get started.</div></div>`;
    } else {
      grid.innerHTML = workspaces.map(ws => _wsRow(ws)).join("");
      grid.querySelectorAll(".ws-card").forEach(el => {
        el.addEventListener("click", () => window.swNav(`org/ws/${el.dataset.id}`));
      });
    }
  } catch (err) { toastError(err); }

  if (showChat) {
    const chatZone = container.querySelector("#chat-zone");
    _wireResizeDivider(container.querySelector("#chat-divider"), chatZone, "sw-operator-chat-w");
    _chatDestroy = mountChatWidget({ scope: "org", title: "Operator", container: chatZone });
  }
}

function _wsRow(ws) {
  const swarmCount = ws.swarm_count ?? 0;
  const updated = ws.updated_at ? _reltime(ws.updated_at) : "";
  return `
    <div class="card ws-card" data-id="${ws.id}" style="
      display:flex;flex-direction:row;align-items:center;gap:14px;
      padding:12px 16px;margin-bottom:5px;cursor:pointer;
      transition:background .1s;
    " onmouseover="this.style.background='var(--color-panel)'"
       onmouseout="this.style.background=''">
      <span style="font-size:20px;flex-shrink:0;line-height:1">${ws.icon || "🏢"}</span>
      <div style="flex:1;min-width:0">
        <div style="font-family:var(--font-display);font-size:15px;color:var(--color-ink)">${_esc(ws.display_name)}</div>
        <div style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint);margin-top:2px;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(ws.description || "No description")}</div>
      </div>
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint);flex-shrink:0;text-align:right">
        <div>${swarmCount} swarm${swarmCount !== 1 ? "s" : ""}</div>
        ${updated ? `<div style="margin-top:2px">${updated}</div>` : ""}
      </div>
      <span style="color:var(--color-ink-faint);font-size:16px;flex-shrink:0;line-height:1">›</span>
    </div>`;
}

// ── Home snippets (Control Room + Library footer band) ──────────────────────

function _snippetCardSkeleton(id, title, go, goLabel) {
  return `
    <div class="card" id="${id}" style="flex:1;display:flex;flex-direction:column;
      min-width:0;min-height:0;overflow:hidden;padding:12px 14px 10px;cursor:pointer"
      data-go="${go}">
      <div class="flex-row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
        <div class="card-title" style="margin:0">${title}</div>
        <span class="snip-go" style="font-size:11px;font-family:var(--font-mono);color:var(--color-ink-faint)">${goLabel} ›</span>
      </div>
      <div class="snip-head" style="margin-bottom:8px;font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint)">Loading…</div>
      <div class="snip-list" style="flex:1;overflow-y:auto;min-height:0"></div>
    </div>`;
}

function _renderHomeSnippets(container, mode = "normal") {
  const control = container.querySelector("#snip-control");
  const library = container.querySelector("#snip-library");
  const files   = container.querySelector("#snip-files");
  if (!control || !library) return;

  control.addEventListener("click", (e) => {
    const row = e.target.closest(".snip-row[data-run]");
    window.swNav(row ? `runs/${row.dataset.run}` : "runs");
  });
  library.addEventListener("click", (e) => {
    const row = e.target.closest(".snip-row[data-go]");
    window.swNav(row ? row.dataset.go : "library");
  });
  if (files) {
    files.addEventListener("click", (e) => {
      const row = e.target.closest(".snip-row[data-swarm]");
      window.swNav(row ? `swarm/${row.dataset.swarm}` : "files");
    });
  }

  const wide = mode === "wide";
  if (wide) {
    api.getRunStats().then(s => _fillWideStats(container.querySelector("#snip-stats-bar"), s)).catch(() => {});
  }
  _fillControlSnippet(control, wide);
  _fillLibrarySnippet(library, wide);
  if (files) _fillFilesSnippet(files, wide);
}

async function _fillFilesSnippet(card, wide = false) {
  const head = card.querySelector(".snip-head");
  const list = card.querySelector(".snip-list");
  try {
    const resp = await api.listAllFiles({ limit: wide ? 12 : 5 }).catch(() => ({ rows: [], total: 0 }));
    const files = resp.rows || [];
    const total = resp.total ?? files.length;
    const swarmCount = new Set(files.map(f => f.swarm_id)).size;
    head.textContent = total
      ? `${total} file${total !== 1 ? "s" : ""} across ${swarmCount}${total > files.length ? "+" : ""} swarm${swarmCount !== 1 ? "s" : ""}`
      : "No files yet";
    const recent = files;
    list.innerHTML = recent.length
      ? recent.map(_snipFileRow).join("")
      : `<div class="snip-empty" style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint);padding:6px 0">Agents haven't written any files yet</div>`;
  } catch {
    head.textContent = "Unavailable";
  }
}

function _snipFileRow(f) {
  const where = f.swarm_display_name || f.swarm_name || "swarm";
  return `
    <div class="snip-row" data-swarm="${_esc(f.swarm_id)}" style="display:flex;justify-content:space-between;
      align-items:baseline;gap:10px;padding:4px 0;cursor:pointer;border-bottom:1px dashed var(--color-cream-line)">
      <span style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink);overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap" title="${_esc(f.path)}">${_esc(f.filename)}</span>
      <span style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint);white-space:nowrap">${_esc(where)}</span>
    </div>`;
}

async function _fillControlSnippet(card, wide = false) {
  const head = card.querySelector(".snip-head");
  const list = card.querySelector(".snip-list");
  try {
    const [stats, runs] = await Promise.all([
      api.getRunStats().catch(() => null),
      api.listRuns({ limit: wide ? 15 : 5 }).catch(() => []),
    ]);
    if (stats) {
      head.style.display = "flex";
      head.style.gap = "12px";
      head.style.flexWrap = "wrap";
      head.innerHTML = [
        ["var(--color-amber)",        `● ${stats.running} running`,            stats.running],
        ["var(--color-orchestrator)", `● ${stats.awaiting_human} awaiting`,    stats.awaiting_human],
        ["var(--color-success)",      `${icon("check", { size: 12 })} ${stats.completed_today} done`,   stats.completed_today],
        ["var(--color-danger)",       `${icon("x", { size: 12 })} ${stats.failed_today} failed`,        stats.failed_today],
      ].map(([c, txt, n]) => `<span style="color:${c};opacity:${n > 0 ? 1 : .4};white-space:nowrap">${txt}</span>`).join("");
    } else {
      head.textContent = "Stats unavailable";
    }
    list.innerHTML = runs.length
      ? runs.map(_snipRunRow).join("")
      : `<div class="snip-empty" style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint);padding:6px 0">No runs yet</div>`;
    if (wide) {
      const spark = card.querySelector("#snip-spark");
      if (spark) _buildSparkline(runs, spark);
    }
  } catch {
    head.textContent = "Unavailable";
  }
}

async function _fillLibrarySnippet(card, wide = false) {
  const head = card.querySelector(".snip-head");
  const list = card.querySelector(".snip-list");
  try {
    const [docs, skills] = await Promise.all([
      api.listKnowledge({ scope: "company" }).catch(() => []),
      api.listSkills({ scope: "company" }).catch(() => []),
    ]);
    head.textContent =
      `${docs.length} knowledge doc${docs.length !== 1 ? "s" : ""} · ${skills.length} skill${skills.length !== 1 ? "s" : ""}`;

    if (wide) {
      const sortedDocs   = [...docs].sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
      const sortedSkills = [...skills].sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
      const empty = `<div style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint);padding:3px 0">Nothing here yet</div>`;

      const docSection = sortedDocs.length ? `
        ${sortedDocs[0] ? _snipDocCard(sortedDocs[0]) : ""}
        ${sortedDocs.slice(1, 6).map(d => _snipLibRow({
          kind: "Doc", label: d.title || d.name, updated: d.updated_at, nav: "library/knowledge"
        })).join("")}
      ` : empty;

      const skillSection = sortedSkills.length
        ? sortedSkills.slice(0, 7).map(_snipSkillRow).join("")
        : empty;

      list.innerHTML = `
        <div style="font-family:var(--font-mono);font-size:9px;letter-spacing:.08em;
          color:var(--color-ink-faint);margin-bottom:5px">DOCS (${docs.length})</div>
        ${docSection}
        <div style="font-family:var(--font-mono);font-size:9px;letter-spacing:.08em;
          color:var(--color-ink-faint);margin:10px 0 5px">SKILLS (${skills.length})</div>
        ${skillSection}
      `;
    } else {
      const items = [
        ...docs.map(d => ({ kind: "Doc", label: d.title || d.name, updated: d.updated_at, nav: "library/knowledge" })),
        ...skills.map(s => ({ kind: "Skill", label: s.name, updated: s.updated_at, nav: "library/skills" })),
      ]
        .sort((a, b) => new Date(b.updated || 0) - new Date(a.updated || 0))
        .slice(0, 5);
      list.innerHTML = items.length
        ? items.map(_snipLibRow).join("")
        : `<div class="snip-empty" style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint);padding:6px 0">Nothing here yet</div>`;
    }
  } catch {
    head.textContent = "Unavailable";
  }
}

function _snipRunRow(r) {
  const color = _snipStatusColor(r.status);
  const when = r.started_at ? _reltime(r.started_at) : "—";
  return `
    <div class="snip-row" data-run="${r.id}" style="display:flex;align-items:center;gap:8px;
      padding:5px 0;border-bottom:1px solid var(--color-cream-line);cursor:pointer">
      <span style="color:${color};font-size:10px;flex-shrink:0;line-height:1">●</span>
      <span style="flex:1;min-width:0;font-size:12px;color:var(--color-ink);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(r.swarm_display_name || r.swarm_id)}</span>
      <span style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint);flex-shrink:0">${when}</span>
    </div>`;
}

function _snipLibRow(it) {
  const tagColor = it.kind === "Skill" ? "var(--color-executioner)" : "var(--color-policy)";
  const when = it.updated ? _reltime(it.updated) : "";
  return `
    <div class="snip-row" data-go="${it.nav}" style="display:flex;align-items:center;gap:8px;
      padding:5px 0;border-bottom:1px solid var(--color-cream-line);cursor:pointer">
      <span style="font-family:var(--font-mono);font-size:9px;text-transform:uppercase;letter-spacing:.04em;
        color:${tagColor};flex-shrink:0;width:34px">${it.kind}</span>
      <span style="flex:1;min-width:0;font-size:12px;color:var(--color-ink);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(it.label)}</span>
      <span style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint);flex-shrink:0">${when}</span>
    </div>`;
}

function _snipDocCard(d) {
  const title   = _esc(d.title || d.name);
  const preview = _esc((d.content_preview || "").trim());
  const when    = d.updated_at ? _reltime(d.updated_at) : "";
  return `
    <div class="snip-row" data-go="library/knowledge" style="display:flex;flex-direction:column;gap:3px;
      padding:7px 9px;margin-bottom:5px;border-radius:5px;cursor:pointer;
      background:var(--color-panel);border:1px solid var(--color-cream-line)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span style="font-size:12px;font-weight:600;color:var(--color-ink);
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0">${title}</span>
        <span style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint);flex-shrink:0">${when}</span>
      </div>
      ${preview ? `<div style="font-size:11px;color:var(--color-ink-faint);
        display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
        line-height:1.4">${preview}</div>` : ""}
    </div>`;
}

function _snipSkillRow(s) {
  const when = s.updated_at ? _reltime(s.updated_at) : "";
  return `
    <div class="snip-row" data-go="library/skills" style="display:flex;align-items:baseline;gap:8px;
      padding:5px 0;border-bottom:1px solid var(--color-cream-line);cursor:pointer">
      <span style="font-family:var(--font-mono);font-size:11px;color:var(--color-executioner);
        flex-shrink:0;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:30%">${_esc(s.name)}</span>
      <span style="flex:1;min-width:0;font-size:11px;color:var(--color-ink-faint);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(s.description || "")}</span>
      <span style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint);flex-shrink:0">${when}</span>
    </div>`;
}

function _snipStatusColor(status) {
  return {
    running:        "var(--color-amber)",
    completed:      "var(--color-success)",
    failed:         "var(--color-danger)",
    pending:        "var(--color-ink-faint)",
    awaiting_human: "var(--color-orchestrator)",
  }[status] || "var(--color-ink-faint)";
}

// ── Snippet panel resize ───────────────────────────────────────────────────

const _SNIP_H_KEY  = "sw-snip-h";
const _SNIP_CO_KEY = "sw-snip-collapsed";
const _SNIP_MICRO  = 52;
const _SNIP_WIDE   = 320;

function _snipMode(h) {
  return h < _SNIP_MICRO ? "micro" : h >= _SNIP_WIDE ? "wide" : "normal";
}

function _wireSnippetDivider(container) {
  const divider = container.querySelector("#snip-divider");
  const panel   = container.querySelector("#home-snippets");
  if (!divider || !panel) return;

  let currentMode = null;

  const _setHeight = (h, save = false) => {
    h = Math.max(40, Math.min(600, h));
    panel.style.height = h + "px";
    if (save) try { localStorage.setItem(_SNIP_H_KEY, h); } catch (_) {}
    const mode = _snipMode(h);
    if (mode !== currentMode) {
      currentMode = mode;
      _setSnippetMode(container, panel, mode);
    }
  };

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "snip-toggle";
  const _updateToggle = (collapsed) => {
    toggleBtn.textContent = collapsed ? "▴" : "▾";
    toggleBtn.title = collapsed ? "Expand panel" : "Collapse panel";
  };

  const _applyCollapse = (collapsed) => {
    if (collapsed) {
      try { localStorage.setItem(_SNIP_H_KEY, panel.offsetHeight || 190); } catch (_) {}
      panel.style.height = "0";
      divider.classList.add("snip-divider-collapsed");
    } else {
      const savedH = parseInt(localStorage.getItem(_SNIP_H_KEY)) || 190;
      _setHeight(savedH);
      divider.classList.remove("snip-divider-collapsed");
    }
    _updateToggle(collapsed);
    try { localStorage.setItem(_SNIP_CO_KEY, collapsed ? "1" : "0"); } catch (_) {}
  };

  _updateToggle(false);
  divider.appendChild(toggleBtn);
  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    _applyCollapse(!divider.classList.contains("snip-divider-collapsed"));
  });

  const startCollapsed = localStorage.getItem(_SNIP_CO_KEY) === "1";
  const savedH = parseInt(localStorage.getItem(_SNIP_H_KEY)) || 190;

  if (startCollapsed) {
    panel.style.height = "0";
    divider.classList.add("snip-divider-collapsed");
    _updateToggle(true);
  } else {
    _setHeight(savedH);
  }

  divider.addEventListener("mousedown", (e) => {
    if (divider.classList.contains("snip-divider-collapsed")) return;
    if (e.target === toggleBtn) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = panel.offsetHeight;
    const onMove = (mv) => _setHeight(startH + (startY - mv.clientY));
    const onUp   = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try { localStorage.setItem(_SNIP_H_KEY, panel.offsetHeight); } catch (_) {}
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function _setSnippetMode(container, panel, mode) {
  if (mode === "micro") {
    panel.style.cssText = `flex-shrink:0;overflow:hidden;height:${panel.style.height};
      display:flex;align-items:center;flex-direction:row;padding:0 24px;gap:0`;
    panel.innerHTML = _snipMicroSkeleton();
    _renderMicroSnippets(container);
  } else if (mode === "wide") {
    panel.style.cssText = `flex-shrink:0;overflow:hidden;height:${panel.style.height};
      display:flex;flex-direction:column;gap:0;padding:0`;
    panel.innerHTML = _snipWideSkeleton();
    _renderHomeSnippets(container, "wide");
  } else {
    panel.style.cssText = `flex-shrink:0;overflow:hidden;height:${panel.style.height};
      display:flex;flex-direction:row;gap:14px;
      border-top:1px dashed var(--color-cream-line);padding:14px 24px 16px`;
    panel.innerHTML =
      _snippetCardSkeleton("snip-control", "Control Room", "runs", "Go to room") +
      _snippetCardSkeleton("snip-library", "Library", "library", "Go to library") +
      _snippetCardSkeleton("snip-files", "Files", "files", "Browse files");
    _renderHomeSnippets(container, "normal");
  }
}

function _snipMicroSkeleton() {
  return `
    <div id="snip-micro" style="display:flex;align-items:center;gap:16px;width:100%;
      font-family:var(--font-mono)">
      <div id="snip-micro-status" style="display:flex;gap:12px;align-items:center;flex:1;min-width:0">
        <span style="font-size:11px;color:var(--color-ink-faint)">Loading…</span>
      </div>
      <a id="snip-micro-ctrl" style="font-size:12px;color:var(--color-ink-faint);cursor:pointer;
        white-space:nowrap">Control Room ›</a>
      <span style="color:var(--color-cream-line);font-size:10px">|</span>
      <a id="snip-micro-lib" style="font-size:12px;color:var(--color-ink-faint);cursor:pointer;
        white-space:nowrap">Library ›</a>
      <span id="snip-micro-lib-count" style="font-size:11px;color:var(--color-ink-faint)"></span>
      <span style="color:var(--color-cream-line);font-size:10px">|</span>
      <a id="snip-micro-files" style="font-size:12px;color:var(--color-ink-faint);cursor:pointer;
        white-space:nowrap">Files ›</a>
    </div>`;
}

function _snipWideSkeleton() {
  return `
    <div id="snip-stats-bar" style="display:flex;gap:32px;align-items:center;
      padding:10px 24px 8px;border-top:1px dashed var(--color-cream-line);
      border-bottom:1px solid var(--color-cream-line);flex-shrink:0">
      <span style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint)">Loading…</span>
    </div>
    <div style="flex:1;display:flex;gap:0;min-height:0">
      <div id="snip-control" class="card" style="flex:1;display:flex;flex-direction:column;
        min-width:0;min-height:0;overflow:hidden;padding:12px 14px 10px;cursor:pointer;
        border:none;border-radius:0" data-go="runs">
        <div class="flex-row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="card-title" style="margin:0">Control Room</div>
          <span class="snip-go" style="font-size:11px;font-family:var(--font-mono);
            color:var(--color-ink-faint)">Go to room ›</span>
        </div>
        <div class="snip-head" style="margin-bottom:8px;font-family:var(--font-mono);
          font-size:11px;color:var(--color-ink-faint)">Loading…</div>
        <div class="snip-list" style="flex:1;overflow-y:auto;min-height:0"></div>
        <div id="snip-spark" style="height:48px;flex-shrink:0;margin-top:6px;
          border-top:1px solid var(--color-cream-line);padding-top:6px;
          display:flex;align-items:flex-end;gap:2px"></div>
      </div>
      <div style="width:1px;background:var(--color-cream-line);flex-shrink:0;margin:10px 0"></div>
      <div id="snip-library" class="card" style="flex:1;display:flex;flex-direction:column;
        min-width:0;min-height:0;overflow:hidden;padding:12px 14px 10px;cursor:pointer;
        border:none;border-radius:0" data-go="library">
        <div class="flex-row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="card-title" style="margin:0">Library</div>
          <span class="snip-go" style="font-size:11px;font-family:var(--font-mono);
            color:var(--color-ink-faint)">Go to library ›</span>
        </div>
        <div class="snip-head" style="margin-bottom:8px;font-family:var(--font-mono);
          font-size:11px;color:var(--color-ink-faint)">Loading…</div>
        <div class="snip-list" style="flex:1;overflow-y:auto;min-height:0"></div>
      </div>
      <div style="width:1px;background:var(--color-cream-line);flex-shrink:0;margin:10px 0"></div>
      <div id="snip-files" class="card" style="flex:1;display:flex;flex-direction:column;
        min-width:0;min-height:0;overflow:hidden;padding:12px 14px 10px;cursor:pointer;
        border:none;border-radius:0" data-go="files">
        <div class="flex-row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="card-title" style="margin:0">Files</div>
          <span class="snip-go" style="font-size:11px;font-family:var(--font-mono);
            color:var(--color-ink-faint)">Browse files ›</span>
        </div>
        <div class="snip-head" style="margin-bottom:8px;font-family:var(--font-mono);
          font-size:11px;color:var(--color-ink-faint)">Loading…</div>
        <div class="snip-list" style="flex:1;overflow-y:auto;min-height:0"></div>
      </div>
    </div>`;
}

async function _renderMicroSnippets(container) {
  const statusEl   = container.querySelector("#snip-micro-status");
  const libCountEl = container.querySelector("#snip-micro-lib-count");
  container.querySelector("#snip-micro-ctrl")?.addEventListener("click", () => window.swNav("runs"));
  container.querySelector("#snip-micro-lib")?.addEventListener("click",  () => window.swNav("library"));
  container.querySelector("#snip-micro-files")?.addEventListener("click", () => window.swNav("files"));
  try {
    const [stats, docs, skills] = await Promise.all([
      api.getRunStats().catch(() => null),
      api.listKnowledge({ scope: "company" }).catch(() => []),
      api.listSkills({ scope: "company" }).catch(() => []),
    ]);
    if (statusEl && stats) {
      statusEl.innerHTML = [
        [stats.running,        "var(--color-amber)",        `● ${stats.running} running`],
        [stats.awaiting_human, "var(--color-orchestrator)", `${icon("hourglass", { size: 12 })} ${stats.awaiting_human} awaiting`],
        [stats.completed_today,"var(--color-success)",      `${icon("check", { size: 12 })} ${stats.completed_today} done`],
        [stats.failed_today,   "var(--color-danger)",       `${icon("x", { size: 12 })} ${stats.failed_today} failed`],
      ].map(([n, c, txt]) =>
        `<span style="font-size:11px;color:${c};opacity:${n > 0 ? 1 : .4};white-space:nowrap">${txt}</span>`
      ).join("");
    }
    if (libCountEl) libCountEl.textContent = `${docs.length} docs · ${skills.length} skills`;
  } catch (_) {}
}

function _fillWideStats(statsBar, stats) {
  if (!statsBar || !stats) return;
  statsBar.innerHTML = [
    { v: stats.running,         c: "var(--color-amber)",        label: "RUNNING" },
    { v: stats.awaiting_human,  c: "var(--color-orchestrator)", label: "AWAITING" },
    { v: stats.completed_today, c: "var(--color-success)",      label: "DONE TODAY" },
    { v: stats.failed_today,    c: "var(--color-danger)",       label: "FAILED" },
  ].map(({ v, c, label }) => `
    <div style="display:flex;flex-direction:column;align-items:flex-start">
      <div style="font-family:var(--font-display);font-size:28px;line-height:1;
        color:${c};opacity:${v > 0 ? 1 : .25}">${v}</div>
      <div style="font-family:var(--font-mono);font-size:9px;letter-spacing:.08em;
        color:var(--color-ink-faint);margin-top:2px">${label}</div>
    </div>
  `).join("");
}

function _buildSparkline(runs, sparkEl) {
  const now  = Date.now();
  const bins = Array.from({ length: 8 }, (_, i) => {
    const h = new Date(now - (7 - i) * 3600000).getHours();
    return { label: `${h}h`, running: 0, completed: 0, failed: 0 };
  });
  for (const r of runs) {
    if (!r.started_at) continue;
    const age = (now - new Date(r.started_at).getTime()) / 3600000;
    if (age < 0 || age >= 8) continue;
    const idx = Math.min(7, Math.max(0, 7 - Math.floor(age)));
    const key = r.status === "completed" ? "completed" : r.status === "failed" ? "failed" : "running";
    bins[idx][key]++;
  }
  const max = Math.max(1, ...bins.map(b => b.running + b.completed + b.failed));
  const px  = (n) => Math.max(2, Math.round((n / max) * 30));
  sparkEl.innerHTML = bins.map(b => `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:0;justify-content:flex-end">
      <div style="width:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:1px;height:30px">
        ${b.failed    ? `<div style="width:100%;height:${px(b.failed)}px;background:var(--color-danger);border-radius:1px;opacity:.8"></div>` : ""}
        ${b.completed ? `<div style="width:100%;height:${px(b.completed)}px;background:var(--color-success);border-radius:1px"></div>` : ""}
        ${b.running   ? `<div style="width:100%;height:${px(b.running)}px;background:var(--color-amber);border-radius:1px"></div>` : ""}
        ${!b.failed && !b.completed && !b.running ? `<div style="width:100%;height:2px;background:var(--color-cream-line);border-radius:1px;align-self:flex-end"></div>` : ""}
      </div>
      <div style="font-family:var(--font-mono);font-size:8px;color:var(--color-ink-faint);
        margin-top:2px;text-align:center;line-height:1">${b.label}</div>
    </div>
  `).join("");
}

// ── Workspace detail ───────────────────────────────────────────────────────

async function _renderWorkspaceDetail(container, wsId) {
  container.innerHTML = `
    <div style="flex:1;display:flex;flex-direction:column;min-width:0;overflow:hidden">
      <div class="crumbs" style="flex-shrink:0">
        <span class="crumb-link" id="crumb-workspaces">Workspaces</span>
        <span class="crumb-sep">›</span>
        <span class="crumb-here" id="crumb-ws-name">…</span>
      </div>
      <div id="ws-main" style="flex:1;display:grid;grid-template-columns:1fr 280px;gap:0;min-height:0;overflow:hidden">
        <div style="overflow-y:auto;padding:24px">
          <div class="flex-row" style="justify-content:space-between;margin-bottom:8px">
            <div>
              <div class="page-title" id="ws-title">…</div>
              <div class="page-sub" id="ws-desc"></div>
            </div>
            <div class="flex-row">
              ${canDo("can_edit_workspace") ? `<button class="btn btn-secondary btn-sm" id="btn-edit-ws">Edit</button>` : ""}
              ${canDo("can_delete_workspace") ? `<button class="btn btn-danger btn-sm" id="btn-del-ws">Delete</button>` : ""}
            </div>
          </div>
          <div id="ws-stats" style="display:flex;align-items:flex-start;gap:0;margin-bottom:22px;padding:14px 0;border-top:1px dashed var(--color-cream-line);border-bottom:1px dashed var(--color-cream-line)">
            <div style="color:var(--color-ink-faint);font-size:11px;font-family:var(--font-mono)">Loading stats…</div>
          </div>
          <div class="sec-header">Swarms</div>
          <div id="swarm-grid" class="card-grid card-grid-2"></div>
        </div>
        <div style="border-left:1px solid var(--color-border-soft);padding:24px;overflow-y:auto;background:var(--color-bg)">
          <div class="sec-header">Workspace resources</div>
          <div id="ws-resources"></div>
        </div>
      </div>
    </div>`;

  container.querySelector("#crumb-workspaces").addEventListener("click", () => window.swNav("org"));

  try {
    const ws = await api.getWorkspace(wsId);
    container.querySelector("#crumb-ws-name").textContent = ws.display_name;
    container.querySelector("#ws-title").textContent = ws.display_name;
    container.querySelector("#ws-desc").textContent = ws.description || "";

    // Workspace stats strip
    const statsEl = container.querySelector("#ws-stats");
    if (statsEl) {
      const totalTok = ws.total_tokens || 0;
      const tokStr = totalTok > 1_000_000
        ? `${(totalTok / 1_000_000).toFixed(1)}M`
        : totalTok > 1_000 ? `${Math.round(totalTok / 1_000)}k` : String(totalTok);
      const lastActive = ws.last_active_at
        ? _reltime(ws.last_active_at)
        : "never";
      statsEl.innerHTML = [
        { label: "Total runs",   val: (ws.total_runs || 0).toLocaleString() },
        { label: "Total tokens", val: tokStr },
        { label: "Last active",  val: lastActive },
      ].map(s => `
        <div style="display:flex;flex-direction:column;gap:3px;padding:0 20px 0 0;border-right:1px dashed var(--color-cream-line);last-child{border:none}">
          <div style="font-size:18px;font-weight:600;font-family:var(--font-display);color:var(--color-ink)">${s.val}</div>
          <div style="font-size:10px;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.06em;color:var(--color-ink-soft)">${s.label}</div>
        </div>`).join("") +
        `<div style="flex:1"></div>`;
    }

    // Concierge — floating bubble launcher, only if workspace has a concierge swarm
    const hasConcierge = canDo("can_chat_workspace") &&
      (ws.swarms || []).some(s => s.name === "concierge");
    if (hasConcierge) {
      _chatDestroy = mountConciergeLauncher({
        workspaceId: ws.id,
        title: `${ws.display_name} · Concierge`,
        container,
      });
    }

    // Edit workspace
    container.querySelector("#btn-edit-ws")?.addEventListener("click", () =>
      _showEditWorkspaceModal(ws, () => _renderWorkspaceDetail(container, wsId)));

    // Delete workspace — use modal, not confirm()
    container.querySelector("#btn-del-ws")?.addEventListener("click", () => {
      _showModal(
        "Delete workspace",
        `<p style="margin:0;color:var(--color-ink-soft)">Delete <b>${_esc(ws.display_name)}</b>? All swarms inside must be deleted first. This cannot be undone.</p>`,
        async () => {
          await api.deleteWorkspace(wsId);
          toastSuccess("Workspace deleted");
          window.swNav("org");
        },
        "Delete",
        true
      );
    });

    // Swarms grid
    const grid = container.querySelector("#swarm-grid");
    const swarms = ws.swarms || [];

    const _refreshGrid = () => _renderWorkspaceDetail(container, wsId);

    grid.innerHTML = swarms.map(s => _swarmCard(s)).join("") +
      (canDo("can_create_swarm") ? `<div class="card card-add" id="add-swarm-card">+ New swarm</div>` : "");

    grid.querySelector("#add-swarm-card")?.addEventListener("click", () =>
      _showCreateSwarmModal(wsId, _refreshGrid));

    // Navigate into swarm on card click
    grid.querySelectorAll(".swarm-card").forEach(el => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        window.swSwarm = el.dataset.id;
        window.swNav(`swarm/${el.dataset.id}`);
      });
    });

    // Delete swarm buttons
    grid.querySelectorAll(".swarm-del-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const swId = btn.dataset.id;
        const name = btn.dataset.name || swId;
        _showModal(
          "Delete swarm",
          `<p style="margin:0;color:var(--color-ink-soft)">Delete <b>${_esc(name)}</b>? All agents, runs, and files will be permanently removed.</p>`,
          async () => {
            await api.deleteSwarm(swId);
            toastSuccess("Swarm deleted");
            _refreshGrid();
          },
          "Delete",
          true
        );
      });
    });

    // Edit swarm buttons
    grid.querySelectorAll(".swarm-edit-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        _showEditSwarmModal(
          { id: btn.dataset.id, display_name: btn.dataset.name, description: btn.dataset.desc },
          _refreshGrid
        );
      });
    });

    // Enable/disable toggles
    grid.querySelectorAll(".swarm-toggle-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const swId = btn.dataset.id;
        const enabled = btn.dataset.enabled === "true";
        btn.disabled = true;
        try {
          await api.updateSwarm(swId, { enabled: !enabled });
          toastSuccess(enabled ? "Swarm disabled" : "Swarm enabled");
          _refreshGrid();
        } catch (err) {
          toastError(err);
          btn.disabled = false;
        }
      });
    });

    // Transfer swarm buttons
    grid.querySelectorAll(".swarm-transfer-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        _showSwarmTransferModal(
          { id: btn.dataset.id, display_name: btn.dataset.name, workspace_id: btn.dataset.wsid },
          _refreshGrid
        );
      });
    });

    // Fire event buttons
    grid.querySelectorAll(".swarm-fire-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        _showFireModal(btn.dataset.id, btn.dataset.name);
      });
    });

    // Resources sidebar
    const res = container.querySelector("#ws-resources");
    res.innerHTML = `
      <div class="collapsible-row">
        <span>Knowledge <span class="collapsible-count" id="kn-count">…</span></span>
        <span class="collapsible-view" data-tab="knowledge">View all ›</span>
      </div>
      <div class="collapsible-row">
        <span>Skills <span class="collapsible-count" id="sk-count">…</span></span>
        <span class="collapsible-view" data-tab="skills">View all ›</span>
      </div>
      <div class="collapsible-row" style="margin-bottom:0">
        <span>Perceptionists <span class="collapsible-count" id="pc-count">${ws.perceptionist_count ?? "…"}</span></span>
      </div>`;

    res.querySelectorAll("[data-tab]").forEach(el => {
      el.addEventListener("click", () => window.swNav(`library/${el.dataset.tab}/${wsId}`));
    });

    // Load knowledge + skills counts
    api.listKnowledge({ scope: "workspace", workspace_id: wsId })
      .then(docs => { const el = res.querySelector("#kn-count"); if (el) el.textContent = docs.length; })
      .catch(() => {});
    api.listSkills({ scope: "workspace", workspace_id: wsId })
      .then(skills => { const el = res.querySelector("#sk-count"); if (el) el.textContent = skills.length; })
      .catch(() => {});

  } catch (err) { toastError(err); }
}

function _swarmCard(s) {
  const enabled = s.enabled !== false;
  const statusDot = enabled
    ? `<span style="color:var(--color-success);font-size:10px">●</span>`
    : `<span style="color:var(--color-danger);font-size:10px">●</span>`;

  const runningBadge = s.running_count
    ? `<span style="background:rgba(217,119,6,.15);color:#d97706;font-size:10px;font-family:var(--font-mono);border-radius:8px;padding:1px 7px;font-weight:600">${s.running_count} running</span>`
    : "";

  const lastRun = s.last_run
    ? `last run ${_reltime(s.last_run.started_at)}`
    : "never run";

  const agentBadge = `<span title="agents" style="color:var(--color-ink-faint);font-size:11px">${s.agent_count ?? 0} agents</span>`;
  const triggerBadge = `<span title="triggers" style="color:var(--color-ink-faint);font-size:11px">${s.trigger_count ?? 0} triggers</span>`;

  const toggleLabel = enabled ? "Disable" : "Enable";
  const toggleStyle = enabled
    ? "color:var(--color-ink-faint)"
    : "color:var(--color-success)";

  return `
    <div class="card swarm-card" data-id="${s.id}" style="min-height:130px;cursor:pointer">
      <div class="flex-row" style="justify-content:space-between;align-items:flex-start">
        <div class="card-title flex-row" style="gap:6px;margin-bottom:4px">${statusDot} ${_esc(s.display_name)}</div>
        ${runningBadge}
      </div>
      <div class="card-desc" style="margin-bottom:8px">${_esc(s.description || "No description")}</div>
      <div class="flex-row" style="gap:12px;margin-bottom:10px">${agentBadge} · ${triggerBadge}</div>
      <div class="card-foot" style="align-items:center">
        <span style="color:var(--color-ink-faint);font-size:11px">${lastRun}</span>
        <div class="flex-row" style="gap:4px">
          ${canDo("can_start_run") ? `<button class="btn btn-ghost btn-sm swarm-fire-btn" data-id="${s.id}" data-name="${_esc(s.display_name)}" style="padding:2px 8px;font-size:11px" title="Fire event">▶</button>` : ""}
          ${canDo("can_edit_swarm") ? `<button class="btn btn-ghost btn-sm swarm-toggle-btn" data-id="${s.id}" data-enabled="${enabled}" style="padding:2px 8px;font-size:11px;${toggleStyle}">${toggleLabel}</button>` : ""}
          ${canDo("can_edit_swarm") ? `<button class="btn btn-ghost btn-sm swarm-edit-btn" data-id="${s.id}" data-name="${_esc(s.display_name)}" data-desc="${_esc(s.description || '')}" style="padding:2px 8px;font-size:11px">Edit</button>` : ""}
          ${canDo("can_edit_swarm") ? `<button class="btn btn-ghost btn-sm swarm-transfer-btn" data-id="${s.id}" data-name="${_esc(s.display_name)}" data-wsid="${_esc(s.workspace_id || '')}" style="padding:2px 8px;font-size:11px">Transfer</button>` : ""}
          ${canDo("can_delete_swarm") ? `<button class="btn btn-ghost btn-sm swarm-del-btn" data-id="${s.id}" data-name="${_esc(s.display_name)}" style="padding:2px 8px;font-size:11px;color:var(--color-danger)">Delete</button>` : ""}
        </div>
      </div>
    </div>`;
}

// ── Fire event modal ────────────────────────────────────────────────────────

function _showFireModal(swarmId, swarmName) {
  _showModal(
    `Fire · ${_esc(swarmName)}`,
    `<div class="form-group">
      <label class="form-label">Event payload (JSON)</label>
      <textarea class="form-input" id="m-payload" rows="5"
        style="font-family:var(--font-mono);font-size:12px;resize:vertical;line-height:1.5">{\n  "type": "manual"\n}</textarea>
    </div>`,
    async () => {
      const raw = document.getElementById("m-payload")?.value.trim() || "{}";
      let payload;
      try { payload = JSON.parse(raw); }
      catch { throw { message: "Invalid JSON — check your payload syntax" }; }
      await api.fireEvent(swarmId, payload);
      toastSuccess("Event fired");
    },
    "▶ Fire"
  );
  setTimeout(() => {
    const ta = document.getElementById("m-payload");
    if (ta) { ta.focus(); ta.select(); }
  }, 60);
}

// ── Modals ─────────────────────────────────────────────────────────────────

const _WS_EMOJIS = [
  "🏢","🏦","💼","🏗","🛠","⚙","🔬","📊","💡","🎯",
  "🚀","🌐","🔐","📦","🧩","🤖","🌿","⚡","🎨","📡",
  "🐝","🦾","🔭","🗂","💬","🏆","🧠","🔑","🌊","🎪",
];

function _mountEmojiPicker(container, defaultIcon) {
  const wrap = document.createElement("div");
  wrap.className = "form-group";
  wrap.innerHTML = `<label class="form-label">Icon</label>`;

  // Preview + text input row
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:12px;margin-bottom:10px";

  const preview = document.createElement("div");
  preview.style.cssText = `
    width:52px;height:52px;border-radius:8px;display:flex;align-items:center;justify-content:center;
    font-size:28px;line-height:1;background:var(--color-panel);
    border:2px solid var(--color-cream-line);flex-shrink:0;user-select:none;
  `;
  preview.textContent = defaultIcon || "🏢";

  const input = document.createElement("input");
  input.className = "form-input";
  input.id = "m-icon";
  input.type = "text";
  input.value = defaultIcon || "🏢";
  input.placeholder = "Paste any emoji";
  input.maxLength = 8;
  input.style.cssText = "font-size:22px;text-align:center;width:90px;letter-spacing:2px";

  input.addEventListener("input", () => {
    const v = input.value.trim() || "🏢";
    preview.textContent = v;
    // Highlight selected btn if matches
    grid.querySelectorAll(".epick-btn").forEach(b => {
      b.style.background = b.dataset.e === v ? "var(--color-amber)22" : "";
      b.style.borderColor = b.dataset.e === v ? "var(--color-amber)" : "var(--color-cream-line)";
    });
  });

  row.appendChild(preview);
  row.appendChild(input);
  wrap.appendChild(row);

  // Emoji grid
  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:repeat(10,1fr);gap:4px";

  _WS_EMOJIS.forEach(e => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "epick-btn";
    btn.dataset.e = e;
    btn.textContent = e;
    btn.title = e;
    const isSel = e === (defaultIcon || "🏢");
    btn.style.cssText = `
      font-size:20px;padding:5px 2px;line-height:1;cursor:pointer;border-radius:5px;
      border:1.5px solid ${isSel ? "var(--color-amber)" : "var(--color-cream-line)"};
      background:${isSel ? "var(--color-amber)22" : "var(--color-panel)"};
      transition:background .1s,border-color .1s;
    `;
    btn.addEventListener("mouseenter", () => {
      if (btn.dataset.e !== input.value) btn.style.background = "var(--color-cream-hover)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = btn.dataset.e === input.value ? "var(--color-amber)22" : "";
    });
    btn.addEventListener("click", () => {
      input.value = e;
      preview.textContent = e;
      grid.querySelectorAll(".epick-btn").forEach(b => {
        b.style.background = b.dataset.e === e ? "var(--color-amber)22" : "";
        b.style.borderColor = b.dataset.e === e ? "var(--color-amber)" : "var(--color-cream-line)";
      });
    });
    grid.appendChild(btn);
  });

  wrap.appendChild(grid);
  container.appendChild(wrap);
  return input; // caller can read .value on save
}

function _showCreateWorkspaceModal(onDone) {
  const { veil } = _showModal("New workspace", `
    <div class="form-group">
      <label class="form-label">Display name</label>
      <input class="form-input" id="m-name" type="text" placeholder="e.g. Finance">
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <input class="form-input" id="m-desc" type="text" placeholder="What does this workspace do?">
    </div>
    <div id="m-icon-mount"></div>`,
    async () => {
      const name = document.getElementById("m-name")?.value.trim();
      if (!name) throw { message: "Name is required" };
      await api.createWorkspace({
        display_name: name,
        description: document.getElementById("m-desc")?.value.trim() || null,
        icon: document.getElementById("m-icon")?.value.trim() || null,
      });
      toastSuccess("Workspace created");
      onDone();
    }
  );
  const mount = document.getElementById("m-icon-mount");
  if (mount) _mountEmojiPicker(mount, "🏢");
  document.getElementById("m-name")?.focus();
}

function _showEditWorkspaceModal(ws, onDone) {
  const { veil } = _showModal("Edit workspace", `
    <div class="form-group">
      <label class="form-label">Display name</label>
      <input class="form-input" id="m-name" type="text" value="${_esc(ws.display_name)}">
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <input class="form-input" id="m-desc" type="text" value="${_esc(ws.description || '')}">
    </div>
    <div id="m-icon-mount"></div>`,
    async () => {
      await api.updateWorkspace(ws.id, {
        display_name: document.getElementById("m-name")?.value.trim() || ws.display_name,
        description: document.getElementById("m-desc")?.value.trim() || null,
        icon: document.getElementById("m-icon")?.value.trim() || null,
      });
      toastSuccess("Saved");
      onDone();
    }
  );
  const mount = document.getElementById("m-icon-mount");
  if (mount) _mountEmojiPicker(mount, ws.icon || "🏢");
}

function _showEditSwarmModal(swarm, onDone) {
  _showModal("Edit swarm", `
    <div class="form-group">
      <label class="form-label">Name</label>
      <input class="form-input" id="m-name" type="text" value="${_esc(swarm.display_name)}">
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <input class="form-input" id="m-desc" type="text" value="${_esc(swarm.description || '')}">
    </div>`,
    async () => {
      const display_name = document.getElementById("m-name")?.value.trim();
      if (!display_name) throw { message: "Name is required" };
      await api.updateSwarm(swarm.id, {
        display_name,
        description: document.getElementById("m-desc")?.value.trim() || null,
      });
      toastSuccess("Saved");
      onDone();
    }
  );
  setTimeout(() => document.getElementById("m-name")?.focus(), 50);
}

function _showCreateSwarmModal(wsId, onDone) {
  _showModal("New swarm", `
    <div class="form-group">
      <label class="form-label">Display name</label>
      <input class="form-input" id="m-name" type="text" placeholder="e.g. Invoice Intake">
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <input class="form-input" id="m-desc" type="text" placeholder="What does this swarm do?">
    </div>`,
    async () => {
      const name = document.getElementById("m-name")?.value.trim();
      if (!name) throw { message: "Name is required" };
      await api.createSwarm(wsId, { display_name: name, description: document.getElementById("m-desc")?.value.trim() || null });
      toastSuccess("Swarm created");
      onDone();
    }
  );
  setTimeout(() => document.getElementById("m-name")?.focus(), 50);
}

// ── Swarm transfer modal ───────────────────────────────────────────────────

function _showSwarmTransferModal(swarm, onDone) {
  _showModal(
    `Transfer swarm · ${_esc(swarm.display_name)}`,
    `<p style="margin:0 0 14px;font-size:12px;color:var(--color-ink-soft)">
       Copy or move <b>${_esc(swarm.display_name)}</b> to another workspace.
       Copying duplicates agents, knowledge, and skills. Moving transfers ownership.
     </p>
     <div class="form-group">
       <label class="form-label">Operation</label>
       <div style="display:flex;gap:16px;margin-top:4px">
         <label style="display:flex;gap:6px;align-items:center;cursor:pointer;font-size:13px">
           <input type="radio" name="m-op" value="copy" checked> Copy
         </label>
         <label style="display:flex;gap:6px;align-items:center;cursor:pointer;font-size:13px">
           <input type="radio" name="m-op" value="move"> Move
         </label>
       </div>
     </div>
     <div class="form-group">
       <label class="form-label">Target workspace</label>
       <select class="form-input" id="m-target-ws"><option>Loading…</option></select>
     </div>`,
    async () => {
      const op = document.querySelector('[name="m-op"]:checked')?.value || "copy";
      const target_workspace_id = document.getElementById("m-target-ws")?.value;
      if (!target_workspace_id) throw { message: "Select a workspace" };
      if (op === "copy") {
        await api.copySwarm(swarm.id, { target_workspace_id });
        toastSuccess("Swarm copied");
      } else {
        await api.moveSwarm(swarm.id, { target_workspace_id });
        toastSuccess("Swarm moved");
      }
      onDone();
    },
    "Transfer"
  );

  const wsSelect = document.getElementById("m-target-ws");
  api.listWorkspaces().then(workspaces => {
    wsSelect.innerHTML = workspaces.map(ws =>
      `<option value="${_esc(ws.id)}" data-current="${ws.id === swarm.workspace_id ? "1" : "0"}">${_esc(ws.display_name)}${ws.id === swarm.workspace_id ? " (current)" : ""}</option>`
    ).join("");
    const nonCurrent = workspaces.find(ws => ws.id !== swarm.workspace_id);
    if (nonCurrent) wsSelect.value = nonCurrent.id;

    const updateDisabled = () => {
      const op = document.querySelector('[name="m-op"]:checked')?.value;
      wsSelect.querySelectorAll("option").forEach(opt => {
        opt.disabled = op === "move" && opt.dataset.current === "1";
      });
      if (op === "move" && wsSelect.selectedOptions[0]?.disabled) {
        const valid = [...wsSelect.options].find(o => !o.disabled);
        if (valid) wsSelect.value = valid.value;
      }
    };
    document.querySelectorAll('[name="m-op"]').forEach(r => r.addEventListener("change", updateDisabled));
    updateDisabled();
  }).catch(() => { wsSelect.innerHTML = "<option>Error loading workspaces</option>"; });
}

// ── Generic modal helper ───────────────────────────────────────────────────

export function _showModal(title, bodyHtml, onConfirm, confirmLabel = "Save", danger = false) {
  const veil = document.createElement("div");
  veil.className = "modal-veil";
  const btnClass = danger ? "btn btn-danger" : "btn btn-primary";
  veil.innerHTML = `
    <div class="modal" role="dialog">
      <div class="modal-header">
        <span>${title}</span>
        <button class="modal-close" id="modal-x">${icon("x", { size: 16 })}</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="modal-cancel">Cancel</button>
        <button class="${btnClass}" id="modal-confirm">${confirmLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(veil);

  const close = () => veil.remove();
  veil.querySelector("#modal-x").addEventListener("click", close);
  veil.querySelector("#modal-cancel").addEventListener("click", close);
  veil.addEventListener("click", e => { if (e.target === veil) close(); });

  const confirmBtn = veil.querySelector("#modal-confirm");
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    try {
      await onConfirm();
      close();
    } catch (err) {
      toastError(err);
      confirmBtn.disabled = false;
    }
  });

  return { close, veil };
}

// ── Utilities ──────────────────────────────────────────────────────────────

function _wireResizeDivider(divider, chatZone, storageKey) {
  if (!divider || !chatZone) return;

  const collapseKey = storageKey + "-collapsed";

  // Restore persisted state
  const startCollapsed = localStorage.getItem(collapseKey) === "1";
  if (startCollapsed) {
    chatZone.classList.add("chat-zone-collapsed");
    divider.classList.add("chat-zone-divider-collapsed");
  } else {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) chatZone.style.width = saved;
    } catch (_) {}
  }

  // Toggle tab button
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "chat-zone-toggle";
  const _updateToggle = (collapsed) => {
    toggleBtn.textContent = collapsed ? "‹" : "›";
    toggleBtn.title       = collapsed ? "Expand chat panel" : "Collapse chat panel";
  };
  _updateToggle(startCollapsed);
  divider.appendChild(toggleBtn);

  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const collapsed = chatZone.classList.toggle("chat-zone-collapsed");
    divider.classList.toggle("chat-zone-divider-collapsed", collapsed);
    _updateToggle(collapsed);
    if (!collapsed) {
      // Restore a saved width so it doesn't snap back to the CSS default
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) chatZone.style.width = saved;
      } catch (_) {}
    } else {
      // Capture current width before the collapse transition erases it
      try {
        const w = chatZone.offsetWidth;
        if (w > 0) localStorage.setItem(storageKey, w + "px");
      } catch (_) {}
    }
    try { localStorage.setItem(collapseKey, collapsed ? "1" : "0"); } catch (_) {}
  });

  // Drag to resize (disabled when collapsed)
  divider.addEventListener("mousedown", (e) => {
    if (chatZone.classList.contains("chat-zone-collapsed")) return;
    if (e.target === toggleBtn) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = chatZone.offsetWidth;
    const onMove = (mv) => {
      const newW = Math.max(240, Math.min(800, startW + (startX - mv.clientX)));
      chatZone.style.width = newW + "px";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try { localStorage.setItem(storageKey, chatZone.style.width); } catch (_) {}
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function _esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _reltime(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60)   return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
