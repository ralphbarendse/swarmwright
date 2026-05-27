import * as api from "../api.js";
import { toastError, toastSuccess } from "../components/toast.js";
import { onEvent, offEvent } from "../sse.js";
import { _showModal } from "./org-design.js";
import { canDo } from "../auth.js";

/**
 * Control Room view (was: Runs).
 * Routes:
 *   segments = []   → control room (organogram + runs list)
 *   segments = [id] → run detail
 */
export function renderRunsView(container, runId) {
  const cleanups = [];
  const addCleanup = fn => cleanups.push(fn);

  if (runId) {
    _renderRunDetail(container, runId, addCleanup);
  } else {
    container.style.cssText = "overflow:hidden;height:100%";
    _renderControlRoom(container, addCleanup);
  }

  return () => cleanups.forEach(fn => { try { fn(); } catch (_) {} });
}

// ── Control Room ───────────────────────────────────────────────────────────

async function _renderControlRoom(container, addCleanup) {
  container.innerHTML = `
    <div style="display:grid;grid-template-columns:288px 1fr;height:100%;overflow:hidden">

      <!-- ── Left: Organogram ── -->
      <div style="
        border-right:1px dashed var(--color-cream-line);
        background:var(--color-panel);
        display:flex;flex-direction:column;
        overflow:hidden;
      ">
        <div style="
          padding:14px 18px 10px;
          border-bottom:1px dashed var(--color-cream-line);
          background:var(--color-parchment);
          flex-shrink:0;
        ">
          <div id="org-title" style="
            font-family:var(--font-display);
            font-size:18px;
            color:var(--color-ink);
            letter-spacing:-0.3px;
          ">…</div>
          <div style="
            font-family:var(--font-mono);
            font-size:10px;
            color:var(--color-ink-soft);
            letter-spacing:.08em;
            text-transform:uppercase;
            margin-top:2px;
          ">Control Room</div>
        </div>
        <div id="org-tree" style="flex:1;overflow-y:auto;padding:6px 0 16px"></div>
      </div>

      <!-- ── Right: Main content ── -->
      <div style="display:flex;flex-direction:column;overflow:hidden;background:var(--color-bg)">

        <!-- Stats bar + tab toggle -->
        <div style="
          display:flex;align-items:center;
          padding:0 14px 0 20px;
          border-bottom:1px dashed var(--color-cream-line);
          background:var(--color-parchment);
          flex-shrink:0;min-height:38px;gap:16px;
        ">
          <div style="flex:1;display:flex;align-items:center;gap:16px;font-family:var(--font-mono);font-size:11px;overflow:hidden">
            <span id="stat-running" style="color:var(--color-amber);white-space:nowrap;opacity:.4">● 0 running</span>
            <span id="stat-awaiting" style="color:var(--color-orchestrator);white-space:nowrap;opacity:.4">● 0 awaiting</span>
            <span id="stat-completed" style="color:var(--color-success);white-space:nowrap;opacity:.4">✓ 0 done today</span>
            <span id="stat-failed" style="color:var(--color-danger);white-space:nowrap;opacity:.4">✗ 0 failed today</span>
          </div>
          <div style="display:flex;gap:3px;flex-shrink:0">
            <button id="tab-log" style="
              font-family:var(--font-mono);font-size:10px;letter-spacing:.05em;text-transform:uppercase;
              background:var(--color-surface);border:1px dashed var(--color-cream-line);
              border-radius:3px;padding:3px 10px;cursor:pointer;
              color:var(--color-ink-soft);
            ">Log</button>
            <button id="tab-stream" style="
              font-family:var(--font-mono);font-size:10px;letter-spacing:.05em;text-transform:uppercase;
              background:none;border:1px dashed transparent;
              border-radius:3px;padding:3px 10px;cursor:pointer;
              color:var(--color-ink-faint);
            ">Events</button>
          </div>
        </div>

        <!-- Filter bar (log only) -->
        <div id="cr-filter-bar" style="
          padding:8px 20px;
          border-bottom:1px dashed var(--color-cream-line);
          background:var(--color-parchment);
          display:flex;align-items:center;gap:8px;flex-wrap:wrap;
          flex-shrink:0;
        ">
          <select class="form-select" id="fl-status" style="width:130px;font-size:12px">
            <option value="">All statuses</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="pending">Pending</option>
            <option value="awaiting_human">Awaiting human</option>
          </select>
          <select class="form-select" id="fl-workspace" style="width:150px;font-size:12px">
            <option value="">All workspaces</option>
          </select>
          <input type="text" id="fl-date-from" class="form-input" placeholder="From date"
            style="width:120px;font-size:12px;padding:4px 8px;font-family:var(--font-mono)"
            pattern="\d{4}-\d{2}-\d{2}" title="YYYY-MM-DD">
          <span style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint)">→</span>
          <input type="text" id="fl-date-to" class="form-input" placeholder="To date"
            style="width:120px;font-size:12px;padding:4px 8px;font-family:var(--font-mono)"
            pattern="\d{4}-\d{2}-\d{2}" title="YYYY-MM-DD">
          <button class="btn btn-ghost btn-sm" id="btn-refresh" style="margin-left:auto;font-size:11px;letter-spacing:.02em">↺ Refresh</button>
        </div>

        <!-- Context bar (shown when organogram selection active) -->
        <div id="cr-context-bar" style="
          display:none;
          align-items:center;gap:6px;
          padding:5px 20px;
          font-family:var(--font-mono);font-size:10px;
          color:var(--color-ink-soft);
          background:var(--color-cream-deep);
          border-bottom:1px dashed var(--color-cream-line);
          flex-shrink:0;
        ">
          <span style="color:var(--color-ink-faint)">Showing</span>
          <span id="cr-context-label" style="color:var(--color-amber);font-weight:700"></span>
          <button class="btn btn-ghost btn-sm" id="cr-clear-sel" style="
            margin-left:auto;font-size:10px;padding:1px 6px;
            color:var(--color-ink-faint);letter-spacing:.02em;
          ">✕ show all</button>
        </div>

        <!-- Log content -->
        <div id="cr-log-content" style="flex:1;overflow:hidden;display:flex;flex-direction:column">
          <div id="runs-list" style="flex:1;overflow-y:auto;padding:12px 20px 24px"></div>
          <div style="padding:0 20px 12px;display:flex;justify-content:center;flex-shrink:0">
            <button class="btn btn-ghost btn-sm" id="btn-load-more" style="display:none;font-size:11px">Load more</button>
          </div>
        </div>

        <!-- Events content (hidden by default) -->
        <div id="cr-stream-content" style="flex:1;overflow:hidden;display:none;flex-direction:column">
          <div style="
            padding:8px 20px;border-bottom:1px dashed var(--color-cream-line);
            background:var(--color-parchment);flex-shrink:0;
            display:flex;align-items:center;gap:10px;
          ">
            <span style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint);letter-spacing:.06em;text-transform:uppercase">Events table</span>
            <span id="cr-events-updated" style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint)"></span>
            <button class="btn btn-ghost btn-sm" id="btn-events-pause" style="margin-left:auto;font-size:10px">⏸ Pause</button>
          </div>
          <div id="cr-stream-list" style="flex:1;overflow-y:auto;padding:0"></div>
        </div>

      </div>
    </div>`;

  // ── Shared state ──────────────────────────────────────────────────────────
  const state = {
    sel: null,
    wsCollapsed: {},
    swarmMap: {},
    runningCounts: {},
    tab: "log",
    eventsPollInterval: null,
    eventsPaused: false,
  };

  let _workspaces = [];

  // ── Company name ─────────────────────────────────────────────────────────
  api.getSetting("branding.app_name")
    .then(s => {
      const el = container.querySelector("#org-title");
      if (el) el.textContent = s?.value || "Company";
    })
    .catch(() => {
      const el = container.querySelector("#org-title");
      if (el) el.textContent = "Company";
    });

  // ── Stats bar ─────────────────────────────────────────────────────────────
  const loadStats = async () => {
    try {
      const s = await api.getRunStats();
      const els = {
        running:   container.querySelector("#stat-running"),
        awaiting:  container.querySelector("#stat-awaiting"),
        completed: container.querySelector("#stat-completed"),
        failed:    container.querySelector("#stat-failed"),
      };
      if (els.running)   { els.running.textContent   = `● ${s.running} running`;      els.running.style.opacity   = s.running > 0 ? "1" : ".35"; }
      if (els.awaiting)  { els.awaiting.textContent  = `● ${s.awaiting_human} awaiting`; els.awaiting.style.opacity  = s.awaiting_human > 0 ? "1" : ".35"; }
      if (els.completed) { els.completed.textContent = `✓ ${s.completed_today} done today`; els.completed.style.opacity = s.completed_today > 0 ? "1" : ".35"; }
      if (els.failed)    { els.failed.textContent    = `✗ ${s.failed_today} failed today`; els.failed.style.opacity    = s.failed_today > 0 ? "1" : ".35"; }
    } catch { /* silently ignore */ }
  };

  // ── Organogram loader ─────────────────────────────────────────────────────
  const loadOrg = async () => {
    try {
      const wsList = await api.listWorkspaces();
      const details = await Promise.all(wsList.map(ws => api.getWorkspace(ws.id)));
      _workspaces = details;

      _workspaces.forEach(ws => {
        (ws.swarms || []).forEach(s => { state.swarmMap[s.id] = s; });
      });

      const wsFl = container.querySelector("#fl-workspace");
      if (wsFl) {
        wsFl.innerHTML = `<option value="">All workspaces</option>` +
          _workspaces.map(ws => `<option value="${ws.id}">${_esc(ws.display_name)}</option>`).join("");
      }

      // Running counts fetched alongside org data so renderOrg only fires once
      try {
        const running = await api.listRuns({ status: "running", limit: 200 });
        state.runningCounts = {};
        running.forEach(r => { state.runningCounts[r.swarm_id] = (state.runningCounts[r.swarm_id] || 0) + 1; });
      } catch { /* ignore */ }

      renderOrg();
    } catch (err) { toastError(err); }
  };

  // Refresh running counts independently (called on SSE run events)
  const loadRunningCounts = async () => {
    try {
      const running = await api.listRuns({ status: "running", limit: 200 });
      state.runningCounts = {};
      running.forEach(r => { state.runningCounts[r.swarm_id] = (state.runningCounts[r.swarm_id] || 0) + 1; });
      renderOrg();
    } catch { /* ignore */ }
  };

  // ── Organogram renderer ───────────────────────────────────────────────────
  const renderOrg = () => {
    const tree = container.querySelector("#org-tree");
    if (!tree) return;

    if (!_workspaces.length) {
      tree.innerHTML = `<div style="
        padding:24px 18px;
        font-family:var(--font-mono);font-size:11px;
        color:var(--color-ink-faint);text-align:center;line-height:1.6;
      ">No workspaces yet.<br>Create one in Org.</div>`;
      return;
    }

    tree.innerHTML = _workspaces.map(ws => {
      const swarms    = ws.swarms || [];
      const collapsed = !!state.wsCollapsed[ws.id];
      const isWsSel   = state.sel?.type === "ws" && state.sel.id === ws.id;

      return `
        <div class="org-ws-block" data-ws-id="${ws.id}" style="margin-bottom:2px">

          <!-- Workspace header row -->
          <div class="org-ws-row" data-ws-id="${ws.id}" style="
            display:flex;align-items:center;gap:7px;
            padding:7px 14px 7px 10px;
            cursor:pointer;user-select:none;
            border-left:3px solid ${isWsSel ? "var(--color-amber)" : "transparent"};
            background:${isWsSel ? "rgba(210,160,60,.08)" : "transparent"};
          ">
            <span class="org-chevron" style="
              font-size:10px;color:var(--color-ink-faint);
              display:inline-block;
              transition:transform .15s;
              transform:rotate(${collapsed ? -90 : 0}deg);
              flex-shrink:0;
            ">▾</span>
            <span style="font-size:11px;flex-shrink:0">🏢</span>
            <span style="
              font-family:var(--font-mono);font-size:11px;font-weight:700;
              letter-spacing:.05em;text-transform:uppercase;
              color:${isWsSel ? "var(--color-amber)" : "var(--color-ink-soft)"};
              flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
            ">${_esc(ws.display_name)}</span>
            <span style="
              font-family:var(--font-mono);font-size:9px;
              color:var(--color-ink-faint);flex-shrink:0;
            ">${swarms.length}</span>
          </div>

          <!-- Swarm children -->
          <div class="org-swarms-wrap" style="
            display:${collapsed ? "none" : "block"};
            margin-left:22px;
            border-left:1px dashed var(--color-cream-line);
          ">
            ${swarms.map(s => {
              const isSwarmSel = state.sel?.type === "swarm" && state.sel.id === s.id;
              const runCount   = state.runningCounts[s.id] || 0;
              return `
                <div class="org-swarm-row" data-swarm-id="${s.id}" style="
                  display:flex;align-items:center;gap:6px;
                  padding:6px 10px 6px 12px;
                  cursor:pointer;user-select:none;
                  border-left:2px solid ${isSwarmSel ? "var(--color-amber)" : "transparent"};
                  background:${isSwarmSel ? "rgba(210,160,60,.07)" : "transparent"};
                  transition:background .1s;
                ">
                  <span style="
                    color:${s.enabled ? "var(--color-success)" : "var(--color-ink-faint)"};
                    font-size:7px;flex-shrink:0;line-height:1;
                  ">●</span>
                  <span style="
                    font-family:var(--font-display);font-size:13px;
                    color:${isSwarmSel ? "var(--color-ink)" : "var(--color-ink-soft)"};
                    flex:1;min-width:0;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  ">${_esc(s.display_name)}</span>
                  ${runCount > 0 ? `<span style="
                    background:var(--color-amber);color:var(--color-bg);
                    font-family:var(--font-mono);font-size:8px;font-weight:700;
                    border-radius:8px;padding:1px 5px;flex-shrink:0;line-height:1.4;
                  ">${runCount}</span>` : ""}
                  <button
                    class="org-act-btn"
                    data-swarm-id="${s.id}"
                    data-enabled="${s.enabled}"
                    title="${s.enabled ? "Pause swarm" : "Activate swarm"}"
                    style="
                      font-family:var(--font-mono);font-size:9px;
                      background:none;border:1px dashed ${s.enabled ? "var(--color-success)" : "var(--color-cream-line)"};
                      border-radius:3px;padding:1px 5px;
                      color:${s.enabled ? "var(--color-success)" : "var(--color-ink-faint)"};
                      cursor:pointer;flex-shrink:0;letter-spacing:.03em;
                      transition:all .12s;
                    ">${s.enabled ? "active" : "paused"}</button>
                  <button
                    class="org-fire-btn"
                    data-swarm-id="${s.id}"
                    data-swarm-name="${_esc(s.display_name)}"
                    data-enabled="${s.enabled}"
                    title="Fire event into swarm"
                    style="
                      font-family:var(--font-mono);font-size:10px;
                      background:none;border:1px dashed var(--color-cream-line);
                      border-radius:3px;padding:1px 7px;
                      color:var(--color-amber);
                      cursor:pointer;flex-shrink:0;
                      transition:all .12s;
                    ">▶</button>
                </div>`;
            }).join("")}
            ${swarms.length === 0 ? `
              <div style="
                padding:7px 12px;
                font-family:var(--font-mono);font-size:10px;
                color:var(--color-ink-faint);
              ">no swarms</div>` : ""}
          </div>
        </div>`;
    }).join("");

    // ── Wire up organogram interactions ───────────────────────────────────

    tree.querySelectorAll(".org-ws-row").forEach(row => {
      row.addEventListener("click", e => {
        if (e.target.closest("button")) return;
        const wsId = row.dataset.wsId;
        const alreadySel = state.sel?.type === "ws" && state.sel.id === wsId;
        if (alreadySel) {
          state.sel = null;
          _syncWsDropdown("");
        } else {
          const ws = _workspaces.find(w => w.id === wsId);
          state.sel = { type: "ws", id: wsId, name: ws?.display_name || wsId };
          _syncWsDropdown(wsId);
        }
        renderOrg();
        _updateContextBar();
        load();
      });

      row.addEventListener("dblclick", () => {
        const wsId = row.dataset.wsId;
        state.wsCollapsed[wsId] = !state.wsCollapsed[wsId];
        renderOrg();
      });
    });

    tree.querySelectorAll(".org-swarm-row").forEach(row => {
      row.addEventListener("click", e => {
        if (e.target.closest("button")) return;
        const swarmId = row.dataset.swarmId;
        const alreadySel = state.sel?.type === "swarm" && state.sel.id === swarmId;
        if (alreadySel) {
          state.sel = null;
        } else {
          const s = state.swarmMap[swarmId];
          state.sel = { type: "swarm", id: swarmId, name: s?.display_name || swarmId };
          _syncWsDropdown("");
        }
        renderOrg();
        _updateContextBar();
        load();
      });
    });

    tree.querySelectorAll(".org-act-btn").forEach(btn => {
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        const swarmId  = btn.dataset.swarmId;
        const isActive = btn.dataset.enabled === "true";
        btn.disabled = true;
        try {
          const updated = await api.updateSwarm(swarmId, { enabled: !isActive });
          state.swarmMap[swarmId] = updated;
          _workspaces.forEach(ws => {
            const idx = (ws.swarms || []).findIndex(s => s.id === swarmId);
            if (idx !== -1) ws.swarms[idx] = { ...ws.swarms[idx], enabled: updated.enabled };
          });
          toastSuccess(isActive ? "Swarm paused" : "Swarm activated");
          renderOrg();
        } catch (err) { toastError(err); btn.disabled = false; }
      });
    });

    tree.querySelectorAll(".org-fire-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        _showFireModal(btn.dataset.swarmId, btn.dataset.swarmName);
      });
    });
  };

  // ── Tab toggle ────────────────────────────────────────────────────────────
  const _switchTab = (tab) => {
    state.tab = tab;
    const filterBar     = container.querySelector("#cr-filter-bar");
    const logContent    = container.querySelector("#cr-log-content");
    const streamContent = container.querySelector("#cr-stream-content");
    const tabLog        = container.querySelector("#tab-log");
    const tabStream     = container.querySelector("#tab-stream");

    if (tab === "stream") {
      filterBar.style.display     = "none";
      logContent.style.display    = "none";
      streamContent.style.display = "flex";
      tabLog.style.background    = "none";
      tabLog.style.color         = "var(--color-ink-faint)";
      tabLog.style.borderColor   = "transparent";
      tabStream.style.background = "var(--color-surface)";
      tabStream.style.color      = "var(--color-ink-soft)";
      tabStream.style.borderColor = "var(--color-cream-line)";
      // Start polling when tab first opened
      if (!state.eventsPollInterval) _startEventsPolling();
    } else {
      filterBar.style.display     = "flex";
      logContent.style.display    = "flex";
      streamContent.style.display = "none";
      tabLog.style.background    = "var(--color-surface)";
      tabLog.style.color         = "var(--color-ink-soft)";
      tabLog.style.borderColor   = "var(--color-cream-line)";
      tabStream.style.background = "none";
      tabStream.style.color      = "var(--color-ink-faint)";
      tabStream.style.borderColor = "transparent";
    }
    _updateContextBar();
  };

  // ── Context bar ───────────────────────────────────────────────────────────
  const _updateContextBar = () => {
    const bar   = container.querySelector("#cr-context-bar");
    const label = container.querySelector("#cr-context-label");
    if (!bar || !label) return;
    if (state.tab === "stream" || !state.sel) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "flex";
    const prefix = state.sel.type === "ws" ? "workspace" : "swarm";
    label.textContent = `${prefix}: ${state.sel.name}`;
  };

  const _syncWsDropdown = wsId => {
    const wsFl = container.querySelector("#fl-workspace");
    if (wsFl) wsFl.value = wsId || "";
  };

  // ── Runs loader ───────────────────────────────────────────────────────────
  let _offset = 0;
  const LIMIT = 30;

  const load = async (reset = true) => {
    if (reset) {
      _offset = 0;
      const list = container.querySelector("#runs-list");
      if (list) list.innerHTML = `
        <div style="padding:20px 0;font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint)">Loading…</div>`;
    }
    try {
      const status   = container.querySelector("#fl-status")?.value || "";
      const wsFl     = container.querySelector("#fl-workspace")?.value || "";
      const dateFrom = container.querySelector("#fl-date-from")?.value || "";
      const dateTo   = container.querySelector("#fl-date-to")?.value || "";
      const params   = { limit: LIMIT, offset: _offset };
      if (status)   params.status = status;
      if (dateFrom) params.started_after  = dateFrom + "T00:00:00";
      if (dateTo)   params.started_before = dateTo   + "T23:59:59";

      if (state.sel?.type === "swarm") {
        params.swarm_id = state.sel.id;
      } else if (state.sel?.type === "ws") {
        params.workspace_id = state.sel.id;
      } else if (wsFl) {
        params.workspace_id = wsFl;
      }

      const runs = await api.listRuns(params);
      _renderRunRows(container, runs, reset);
      _offset += runs.length;
      const loadBtn = container.querySelector("#btn-load-more");
      if (loadBtn) loadBtn.style.display = runs.length === LIMIT ? "" : "none";
    } catch (err) { toastError(err); }
  };

  // ── Stream event renderer ─────────────────────────────────────────────────
  const _renderStreamEvent = (msg) => {
    const list = container.querySelector("#cr-stream-list");
    if (!list) return;
    const MAX = 500;
    while (list.children.length >= MAX) list.removeChild(list.lastChild);

    const type = msg.type || "unknown";
    const { badge, text } = _formatStreamEvent(msg);
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    const item = document.createElement("div");
    item.style.cssText = "display:flex;align-items:baseline;gap:10px;padding:5px 0;border-bottom:1px solid var(--color-cream-line)22";
    item.innerHTML = `
      <span style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint);flex-shrink:0;white-space:nowrap">${time}</span>
      <span style="font-family:var(--font-mono);font-size:9px;letter-spacing:.05em;text-transform:uppercase;${badge.style};padding:1px 6px;border-radius:3px;flex-shrink:0;white-space:nowrap">${badge.label}</span>
      <span style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-soft);flex:1;word-break:break-all">${text}</span>`;
    list.insertBefore(item, list.firstChild);
  };

  // ── Filter bar events ─────────────────────────────────────────────────────
  container.querySelector("#fl-status")
    .addEventListener("change", () => load());

  container.querySelector("#fl-workspace")
    .addEventListener("change", e => {
      const wsId = e.target.value;
      if (wsId) {
        const ws = _workspaces.find(w => w.id === wsId);
        state.sel = ws ? { type: "ws", id: wsId, name: ws.display_name } : null;
      } else {
        state.sel = null;
      }
      renderOrg();
      _updateContextBar();
      load();
    });

  container.querySelector("#fl-date-from").addEventListener("change", () => load());
  container.querySelector("#fl-date-to").addEventListener("change", () => load());

  container.querySelector("#btn-refresh")
    .addEventListener("click", () => { loadOrg(); loadStats(); load(); });

  container.querySelector("#btn-load-more")
    .addEventListener("click", () => load(false));

  container.querySelector("#cr-clear-sel")
    .addEventListener("click", () => {
      state.sel = null;
      _syncWsDropdown("");
      renderOrg();
      _updateContextBar();
      load();
    });

  container.querySelector("#tab-log").addEventListener("click", () => _switchTab("log"));
  container.querySelector("#tab-stream").addEventListener("click", () => _switchTab("stream"));

  container.querySelector("#btn-events-pause").addEventListener("click", () => {
    const btn = container.querySelector("#btn-events-pause");
    state.eventsPaused = !state.eventsPaused;
    btn.textContent = state.eventsPaused ? "▶ Resume" : "⏸ Pause";
    if (!state.eventsPaused) _pollEvents();
  });

  // ── Events polling ────────────────────────────────────────────────────────
  const POLL_MS = 5000;

  const _pollEvents = async () => {
    if (state.eventsPaused || state.tab !== "stream") return;
    try {
      const events = await api.listEvents({ limit: 50 });
      _renderEventsTable(container, events, state.swarmMap);
      const el = container.querySelector("#cr-events-updated");
      if (el) el.textContent = `· updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    } catch { /* ignore poll errors */ }
  };

  const _startEventsPolling = () => {
    _pollEvents();
    state.eventsPollInterval = setInterval(_pollEvents, POLL_MS);
    addCleanup(() => {
      clearInterval(state.eventsPollInterval);
      state.eventsPollInterval = null;
    });
  };

  // ── SSE live updates (run log + stats only) ───────────────────────────────
  const _onRunEvent = () => {
    if (state.tab === "log") load();
    loadStats();
    loadRunningCounts();
  };

  onEvent("run.started",   _onRunEvent);
  onEvent("run.completed", _onRunEvent);
  onEvent("run.failed",    _onRunEvent);
  addCleanup(() => {
    offEvent("run.started",   _onRunEvent);
    offEvent("run.completed", _onRunEvent);
    offEvent("run.failed",    _onRunEvent);
  });

  // ── Fire modal ────────────────────────────────────────────────────────────
  //
  // Loads the swarm's invocation triggers. If one has a payload_schema we
  // render a structured form (like the canvas inspector does). If multiple
  // invocation triggers exist, the user picks one. Falls back to raw JSON
  // for swarms with no invocation trigger or no schema.

  const _showFireModal = async (swarmId, swarmName) => {
    // Try to load triggers; fail gracefully so the modal still appears.
    let invTriggers = [];
    try {
      const all = await api.listTriggers(swarmId);
      invTriggers = (all || []).filter(t => t.kind === "invocation");
    } catch { /* ignore — fall back to JSON */ }

    // If multiple invocation triggers, ask the user to pick one first.
    if (invTriggers.length > 1) {
      const opts = invTriggers.map((t, i) =>
        `<button class="btn btn-secondary btn-sm" data-i="${i}" style="text-align:left">${_esc(t.name)}</button>`
      ).join("");
      const { close } = _showModal(
        `Fire · ${_esc(swarmName)}`,
        `<p style="font-size:13px;color:var(--color-ink-soft);margin-bottom:12px">This swarm has multiple invocation triggers — pick one:</p>
         <div style="display:flex;flex-direction:column;gap:6px">${opts}</div>`,
        null, "—"
      );
      document.querySelectorAll(".modal-veil [data-i]").forEach(btn => {
        btn.addEventListener("click", () => {
          close();
          _showSingleFireModal(swarmId, swarmName, invTriggers[+btn.dataset.i]);
        });
      });
      return;
    }

    _showSingleFireModal(swarmId, swarmName, invTriggers[0] || null);
  };

  // Show the actual fire form for a specific trigger (or raw JSON if null).
  const _showSingleFireModal = (swarmId, swarmName, trigger) => {
    const cfg    = trigger?.config || {};
    const schema = cfg.payload_schema;

    // ── Structured form when the trigger declares a payload_schema ──────────
    if (trigger && schema && schema.length) {
      const fixedFields = schema.filter(f => f.mode === "fixed");
      const inputFields = schema.filter(f => f.mode !== "fixed");

      const fixedSection = fixedFields.length ? `
        <div class="form-group">
          <label class="form-label" style="color:var(--color-ink-soft)">Fixed fields (sent automatically)</label>
          <div style="background:var(--color-cream-deep);border:1px solid var(--color-cream-line);border-radius:4px;padding:8px 10px">
            ${fixedFields.map(f => `
              <div style="display:flex;gap:8px;align-items:center;margin-bottom:3px;font-size:12px">
                <span style="font-family:var(--font-mono);color:var(--color-ink-soft);width:120px;flex-shrink:0">${_esc(f.key)}</span>
                <span style="font-family:var(--font-mono)">${_esc(String(f.value ?? ""))}</span>
              </div>`).join("")}
          </div>
        </div>` : "";

      const inputSection = inputFields.map(f => {
        const req = f.required ? ` <span style="color:var(--color-danger)">*</span>` : "";
        const def = f.default !== undefined ? String(f.default) : "";
        let control;
        if (f.type === "boolean") {
          control = `<div style="display:flex;align-items:center;gap:6px">
            <input type="checkbox" id="fi-${_esc(f.key)}" class="fi-field" data-key="${_esc(f.key)}" data-type="boolean" ${def === "true" ? "checked" : ""} style="width:14px;height:14px;accent-color:var(--color-amber)">
            <label for="fi-${_esc(f.key)}" style="font-size:12px">${_esc(f.label || f.key)}</label>
          </div>`;
        } else if (f.type === "text") {
          control = `<textarea class="form-input fi-field" id="fi-${_esc(f.key)}" data-key="${_esc(f.key)}" data-type="text"
            rows="3" placeholder="${_esc(def)}" style="resize:vertical">${_esc(def)}</textarea>`;
        } else if (f.type === "number") {
          control = `<input class="form-input fi-field" id="fi-${_esc(f.key)}" data-key="${_esc(f.key)}" data-type="number"
            type="number" value="${_esc(def)}" placeholder="${_esc(def)}">`;
        } else {
          control = `<input class="form-input fi-field" id="fi-${_esc(f.key)}" data-key="${_esc(f.key)}" data-type="string"
            type="text" value="${_esc(def)}" placeholder="${_esc(def)}">`;
        }
        return f.type === "boolean" ? `<div class="form-group">${control}</div>` : `
          <div class="form-group">
            <label class="form-label" for="fi-${_esc(f.key)}">${_esc(f.label || f.key)}${req}</label>
            ${control}
          </div>`;
      }).join("");

      const noInputs = !inputFields.length;
      const bodyHtml = fixedSection + (noInputs
        ? `<p style="font-size:12px;color:var(--color-ink-faint);font-family:var(--font-mono)">All fields are fixed — click Fire to run.</p>`
        : inputSection);

      _showModal(
        `Fire · ${_esc(swarmName)} · ${_esc(trigger.name)}`,
        bodyHtml,
        async () => {
          const payload = {};
          for (const f of inputFields) {
            const el = document.getElementById(`fi-${f.key}`);
            if (!el) continue;
            let val;
            if (f.type === "boolean")     val = el.checked;
            else if (f.type === "number") val = el.value !== "" ? parseFloat(el.value) : undefined;
            else                          val = el.value;
            if (val === undefined || val === "") {
              if (f.required) throw { message: `"${f.label || f.key}" is required` };
            } else {
              payload[f.key] = val;
            }
          }
          const r = await api.invokeTrigger(trigger.id, payload);
          toastSuccess(`Fired "${trigger.name}" — event ${r?.event_id?.slice(0, 8) || ""}`);
          setTimeout(() => load(), 400);
        },
        "▶ Fire"
      );
      return;
    }

    // ── Raw JSON fallback ──────────────────────────────────────────────────
    const title = trigger
      ? `Fire · ${_esc(swarmName)} · ${_esc(trigger.name)}`
      : `Fire · ${_esc(swarmName)}`;

    _showModal(
      title,
      `<div class="form-group">
        <label class="form-label">Event payload (JSON)</label>
        <textarea class="form-input" id="m-payload" rows="5"
          style="font-family:var(--font-mono);font-size:12px;resize:vertical;line-height:1.5">{\n  "type": "manual"\n}</textarea>
        <div class="form-helper">Must be a valid JSON object. Add a <code style="font-family:var(--font-mono)">payload_schema</code> to the trigger to get a structured form instead.</div>
      </div>`,
      async () => {
        const raw = document.getElementById("m-payload")?.value.trim() || "{}";
        let payload;
        try { payload = JSON.parse(raw); }
        catch { throw { message: "Invalid JSON — check your payload syntax" }; }
        if (trigger) {
          await api.invokeTrigger(trigger.id, payload);
          toastSuccess(`Fired "${trigger.name}"`);
        } else {
          await api.fireEvent(swarmId, payload);
          toastSuccess("Event fired");
        }
        setTimeout(() => load(), 400);
      },
      "▶ Fire"
    );
    setTimeout(() => {
      const ta = document.getElementById("m-payload");
      if (ta) { ta.focus(); ta.select(); }
    }, 60);
  };

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  loadStats();
  await loadOrg();
  await load();
}

// ── Events table renderer ─────────────────────────────────────────────────

function _renderEventsTable(container, events, swarmMap) {
  const list = container.querySelector("#cr-stream-list");
  if (!list) return;

  if (!events.length) {
    list.innerHTML = `
      <div class="empty-state" style="padding-top:40px">
        <div class="empty-state-icon" style="font-size:28px">📭</div>
        <div class="empty-state-title">No events yet</div>
        <div class="empty-state-sub">Fire an event from a swarm to see it here.</div>
      </div>`;
    return;
  }

  const SOURCE_COLORS = {
    api:        "var(--color-amber)",
    heartbeat:  "var(--color-ink-faint)",
    listener:   "var(--color-orchestrator)",
    invocation: "var(--color-policy)",
  };

  list.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed">
      <colgroup>
        <col style="width:80px">
        <col style="width:90px">
        <col style="width:130px">
        <col>
      </colgroup>
      <thead>
        <tr style="border-bottom:1px dashed var(--color-cream-line);background:var(--color-parchment)">
          <th style="padding:6px 20px;font-family:var(--font-mono);font-size:9px;color:var(--color-ink-faint);font-weight:500;text-transform:uppercase;letter-spacing:.06em;text-align:left">Time</th>
          <th style="padding:6px 8px;font-family:var(--font-mono);font-size:9px;color:var(--color-ink-faint);font-weight:500;text-transform:uppercase;letter-spacing:.06em;text-align:left">Source</th>
          <th style="padding:6px 8px;font-family:var(--font-mono);font-size:9px;color:var(--color-ink-faint);font-weight:500;text-transform:uppercase;letter-spacing:.06em;text-align:left">Swarm</th>
          <th style="padding:6px 8px;font-family:var(--font-mono);font-size:9px;color:var(--color-ink-faint);font-weight:500;text-transform:uppercase;letter-spacing:.06em;text-align:left">Payload</th>
        </tr>
      </thead>
      <tbody>
        ${events.map(ev => {
          const swarm = swarmMap[ev.swarm_id];
          const swarmLabel = swarm?.display_name || ev.swarm_id?.slice(0, 12) || "—";
          const srcColor = SOURCE_COLORS[ev.source] || "var(--color-ink-faint)";
          const p = ev.payload || {};
          const typeVal = p.type;
          const rest = Object.entries(p).filter(([k]) => k !== "type")
            .map(([k, v]) => `${_esc(k)}: ${_esc(String(v).slice(0, 40))}`).join("  ·  ");
          const payloadSnippet = (typeVal ? `<b>${_esc(typeVal)}</b>  ` : "") +
            `<span style="color:var(--color-ink-faint)">${_esc(rest)}</span>`;
          return `
            <tr style="border-bottom:1px dashed var(--color-cream-line)22;transition:background .1s" onmouseover="this.style.background='var(--color-panel)'" onmouseout="this.style.background=''">
              <td style="padding:8px 20px;font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint);white-space:nowrap;overflow:hidden">${ev.received_at ? _reltime(ev.received_at) : "—"}</td>
              <td style="padding:8px 8px;overflow:hidden">
                <span style="font-family:var(--font-mono);font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:${srcColor};border:1px solid ${srcColor}44;border-radius:3px;padding:1px 5px">${_esc(ev.source || "?")}</span>
              </td>
              <td style="padding:8px 8px;font-family:var(--font-mono);font-size:11px;color:var(--color-ink-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(swarmLabel)}</td>
              <td style="padding:8px 8px;font-family:var(--font-mono);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${payloadSnippet}</td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

// ── Run row renderer ──────────────────────────────────────────────────────

function _renderRunRows(container, runs, reset) {
  const list = container.querySelector("#runs-list");
  if (!list) return;

  if (reset) list.innerHTML = "";

  if (!runs.length && !list.children.length) {
    list.innerHTML = `
      <div class="empty-state" style="padding-top:40px">
        <div class="empty-state-icon" style="font-size:28px">📋</div>
        <div class="empty-state-title">No runs yet</div>
        <div class="empty-state-sub">Fire an event from a swarm to start a run.</div>
      </div>`;
    return;
  }
  if (!runs.length) return;

  runs.forEach(run => {
    const row = document.createElement("div");
    row.style.cssText = `
      display:flex;align-items:center;gap:12px;
      padding:8px 20px;cursor:pointer;
      border-bottom:1px dashed var(--color-cream-line);
      transition:background .1s;
    `;

    const { dot, label } = _statusBadge(run.status);
    const duration = _duration(run.started_at, run.ended_at);
    const started  = run.started_at ? _reltime(run.started_at) : "—";
    const isRunning = run.status === "running";

    row.innerHTML = `
      <span style="flex-shrink:0;font-size:10px">${dot}</span>
      <div style="flex:1;min-width:0">
        <div style="font-family:var(--font-display);font-size:13px;color:var(--color-ink);
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(run.swarm_display_name || run.swarm_id)}</div>
        <div style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint);margin-top:1px">
          ${_esc(run.id.slice(0, 8))} · ${_esc(run.source || "—")}</div>
      </div>
      <div style="flex-shrink:0;display:flex;align-items:center;gap:8px">
        ${isRunning && canDo("can_stop_run") ? `<button class="btn btn-ghost btn-sm run-stop-btn" data-id="${run.id}" style="font-size:10px;padding:1px 6px;color:var(--color-danger);border-color:var(--color-danger)">■ Stop</button>` : ""}
        <div style="text-align:right">
          <div style="font-family:var(--font-mono);font-size:10px;
            background:${_statusColor(run.status)}18;color:${_statusColor(run.status)};
            padding:1px 6px;border-radius:3px;display:inline-block">${label}</div>
          <div style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint);margin-top:2px">
            ${started}${duration ? ` · ${duration}` : ""}</div>
        </div>
      </div>`;

    row.addEventListener("mouseenter", () => { row.style.background = "var(--color-panel)"; });
    row.addEventListener("mouseleave", () => { row.style.background = ""; });

    row.querySelector(".run-stop-btn")?.addEventListener("click", async e => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api.stopRun(run.id);
        toastSuccess("Stop signal sent");
      } catch (err) { toastError(err); btn.disabled = false; }
    });

    row.addEventListener("click", () => window.swNav(`runs/${run.id}`));
    list.appendChild(row);
  });
}

// ── Run detail ────────────────────────────────────────────────────────────

async function _renderRunDetail(container, runId, addCleanup) {
  container.style.cssText = "height:100%;overflow:hidden;display:flex;flex-direction:column";

  container.innerHTML = `
    <!-- Fixed header zone -->
    <div id="rd-header-zone" style="
      flex-shrink:0;overflow-y:auto;max-height:38vh;
      border-bottom:1px dashed var(--color-cream-line);
    ">
      <div class="crumbs">
        <span class="crumb-link" id="crumb-runs">Control Room</span>
        <span class="crumb-sep">›</span>
        <span class="crumb-here" id="crumb-run-id">…</span>
      </div>
      <div style="padding:0 24px 16px">
        <div id="run-header" style="margin-bottom:14px"></div>
        <div id="run-summary-bar" style="margin-bottom:12px"></div>
        <div id="violations-box" style="display:none;margin-bottom:12px"></div>
      </div>
    </div>

    <!-- Replay toolbar -->
    <div id="rd-replay-bar" style="
      flex-shrink:0;display:none;align-items:center;gap:8px;
      padding:5px 20px;
      background:var(--color-parchment);
      border-bottom:1px dashed var(--color-cream-line);
      font-family:var(--font-mono);font-size:11px;
    ">
      <span style="color:var(--color-ink-faint);letter-spacing:.05em;text-transform:uppercase;font-size:9px">Replay</span>
      <button id="replay-first" class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:12px" title="First step">⟨⟨</button>
      <button id="replay-prev"  class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:12px" title="Previous step">⟨</button>
      <span id="replay-counter" style="color:var(--color-ink-soft);min-width:70px;text-align:center">—</span>
      <button id="replay-next"  class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:12px" title="Next step">⟩</button>
      <button id="replay-last"  class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:12px" title="Last step">⟩⟩</button>
      <button id="replay-play"  class="btn btn-ghost btn-sm" style="padding:2px 9px;font-size:12px;color:var(--color-amber)" title="Auto-play">▶</button>
      <span style="margin-left:auto;color:var(--color-ink-faint);font-size:10px">Click a bar or step to seek</span>
    </div>

    <!-- Split: log (top) + swimlane (bottom) -->
    <div id="rd-split" style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0">

      <!-- Log pane -->
      <div id="rd-log-pane" style="flex:0 0 55%;overflow-y:auto;padding:12px 24px 20px;min-height:0">
        <div style="
          display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-shrink:0;
          font-family:var(--font-mono);font-size:9px;letter-spacing:.06em;
          text-transform:uppercase;color:var(--color-ink-faint);
        ">
          Step trace
          <button id="btn-toggle-replay" class="btn btn-ghost btn-sm" style="font-size:9px;padding:1px 7px;letter-spacing:.04em">⏵ Replay mode</button>
        </div>
        <div id="steps-list"></div>
      </div>

      <!-- Resize handle -->
      <div id="rd-divider" style="
        flex-shrink:0;height:5px;
        background:var(--color-cream-line);
        cursor:row-resize;
        border-top:1px solid var(--color-cream-line);
        border-bottom:1px solid var(--color-cream-line);
        transition:background .1s;
      "></div>

      <!-- Swimlane pane -->
      <div id="rd-timeline-pane" style="flex:1;overflow:auto;min-height:0;background:var(--color-bg)">
        <div style="
          padding:8px 24px 4px;
          font-family:var(--font-mono);font-size:9px;letter-spacing:.06em;
          text-transform:uppercase;color:var(--color-ink-faint);
          border-bottom:1px dashed var(--color-cream-line);
          background:var(--color-parchment);
          position:sticky;top:0;z-index:2;
        ">Timeline</div>
        <div id="swimlane" style="padding:8px 0 16px;min-width:600px"></div>
      </div>

    </div>`;

  container.querySelector("#crumb-runs").addEventListener("click", () => window.swNav("runs"));

  // ── Resize handle ──────────────────────────────────────────────────────────
  const divider = container.querySelector("#rd-divider");
  const splitEl = container.querySelector("#rd-split");
  const logPane = container.querySelector("#rd-log-pane");
  let _dragging = false;

  divider.addEventListener("mousedown", () => {
    _dragging = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  });
  const _onMouseMove = e => {
    if (!_dragging) return;
    const rect = splitEl.getBoundingClientRect();
    const pct = Math.min(80, Math.max(20, ((e.clientY - rect.top) / rect.height) * 100));
    logPane.style.flex = `0 0 ${pct}%`;
  };
  const _onMouseUp = () => {
    if (_dragging) { _dragging = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; }
  };
  document.addEventListener("mousemove", _onMouseMove);
  document.addEventListener("mouseup",   _onMouseUp);
  addCleanup(() => {
    document.removeEventListener("mousemove", _onMouseMove);
    document.removeEventListener("mouseup",   _onMouseUp);
  });

  // ── Replay state ───────────────────────────────────────────────────────────
  let _steps = [];
  let _replayIdx = -1;
  let _replayMode = false;
  let _playTimer = null;

  const _replayBar  = container.querySelector("#rd-replay-bar");
  const _toggleBtn  = container.querySelector("#btn-toggle-replay");

  const _setReplayMode = on => {
    _replayMode = on;
    _replayBar.style.display  = on ? "flex" : "none";
    _toggleBtn.textContent    = on ? "✕ Exit replay" : "⏵ Replay mode";
    if (!on) { _clearReplayHighlight(); if (_playTimer) { clearInterval(_playTimer); _playTimer = null; } }
    else if (_steps.length) _seekReplay(0);
  };

  _toggleBtn.addEventListener("click", () => _setReplayMode(!_replayMode));

  const _seekReplay = idx => {
    if (!_steps.length) return;
    _replayIdx = Math.max(0, Math.min(_steps.length - 1, idx));
    _applyReplayHighlight(container, _steps, _replayIdx);
  };

  const _clearReplayHighlight = () => {
    container.querySelectorAll(".step-card").forEach(c => {
      c.style.outline = "";
    });
    container.querySelectorAll(".swimlane-bar").forEach(b => {
      b.style.opacity = b.dataset.baseOpacity || ".75";
      b.style.outline = "";
    });
  };

  container.querySelector("#replay-first").addEventListener("click", () => _seekReplay(0));
  container.querySelector("#replay-last") .addEventListener("click", () => _seekReplay(_steps.length - 1));
  container.querySelector("#replay-prev") .addEventListener("click", () => _seekReplay(_replayIdx - 1));
  container.querySelector("#replay-next") .addEventListener("click", () => _seekReplay(_replayIdx + 1));
  container.querySelector("#replay-play") .addEventListener("click", () => {
    if (_playTimer) {
      clearInterval(_playTimer);
      _playTimer = null;
      container.querySelector("#replay-play").textContent = "▶";
    } else {
      container.querySelector("#replay-play").textContent = "⏸";
      _playTimer = setInterval(() => {
        if (_replayIdx >= _steps.length - 1) {
          clearInterval(_playTimer); _playTimer = null;
          container.querySelector("#replay-play").textContent = "▶";
        } else {
          _seekReplay(_replayIdx + 1);
        }
      }, 1200);
    }
  });

  // ── SSE + poll ─────────────────────────────────────────────────────────────
  let pollInterval = null;

  const _onRunEvent = data => {
    if (data?.run_id === runId) _reload();
  };
  onEvent("run.step",      _onRunEvent);
  onEvent("run.completed", _onRunEvent);
  onEvent("run.failed",    _onRunEvent);
  addCleanup(() => {
    offEvent("run.step",      _onRunEvent);
    offEvent("run.completed", _onRunEvent);
    offEvent("run.failed",    _onRunEvent);
    if (pollInterval)  { clearInterval(pollInterval);  pollInterval  = null; }
    if (_playTimer)    { clearInterval(_playTimer);    _playTimer    = null; }
  });

  const _reload = async () => {
    try {
      const run = await api.getRun(runId);
      container.querySelector("#crumb-run-id").textContent = run.id.slice(0, 8);
      _renderRunHeader(container, run);
      _renderSummaryBar(container, run);
      if (run.status === "awaiting_human") _loadEscalation(container, run.id);
      _renderViolations(container, run.steps || []);
      _steps = run.steps || [];
      _renderSteps(container, _steps, _replayMode ? _replayIdx : -1, _seekReplay);
      _renderSwimlane(container, _steps, run, _replayMode ? _replayIdx : -1, _seekReplay);
      if (_replayMode && _replayIdx >= 0) _applyReplayHighlight(container, _steps, _replayIdx);

      const live = run.status === "running" || run.status === "pending";
      if (live && !pollInterval) {
        pollInterval = setInterval(_reload, 3000);
      } else if (!live && pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    } catch (err) { toastError(err); }
  };

  await _reload();
}

function _renderRunHeader(container, run) {
  const header = container.querySelector("#run-header");
  const { dot, label } = _statusBadge(run.status);
  const duration = _duration(run.started_at, run.ended_at);
  const payloadStr = JSON.stringify(run.event_payload || {}, null, 2);

  const metaCells = [
    ["Source",   run.source || "—"],
    ["Started",  run.started_at ? new Date(run.started_at).toLocaleString() : "—"],
    ["Ended",    run.ended_at   ? new Date(run.ended_at).toLocaleString()   : "—"],
    ["Duration", duration || "—"],
  ];

  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <span>${dot}</span>
      <span style="font-family:var(--font-mono);font-size:11px;background:${_statusColor(run.status)}22;
        color:${_statusColor(run.status)};padding:2px 8px;border-radius:4px">${label}</span>
      <span style="font-family:var(--font-display);font-size:16px;color:var(--color-ink)">${_esc(run.swarm_display_name || run.swarm_id)}</span>
      <span style="color:var(--color-ink-faint);font-size:11px;font-family:var(--font-mono)">${_esc(run.id)}</span>
      <button onclick="swCopy('${run.id}',this)" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--color-ink-faint);padding:1px 4px;line-height:1" title="Copy run ID">⎘</button>
      ${canDo("can_start_run") ? `<button class="btn btn-ghost btn-sm" id="btn-replay" style="margin-left:auto">↺ Replay</button>` : ""}
      ${run.status === "running" && canDo("can_stop_run") ? `<button class="btn btn-ghost btn-sm" id="btn-stop-run" style="color:var(--color-danger);border-color:var(--color-danger)">■ Stop</button>` : ""}
    </div>

    <div style="display:flex;flex-wrap:wrap;background:var(--color-surface);
      border:1px solid var(--color-border-soft);border-radius:6px;overflow:hidden;
      margin-bottom:${run.error ? "10px" : "6px"}">
      ${metaCells.map(([k, v]) => `
        <div style="padding:8px 18px;border-right:1px dashed var(--color-cream-line);flex:1;min-width:120px">
          <div style="font-family:var(--font-mono);font-size:9px;text-transform:uppercase;
            letter-spacing:.07em;color:var(--color-ink-faint);margin-bottom:3px">${k}</div>
          <div style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-soft)">${_esc(v)}</div>
        </div>`).join("")}
    </div>

    ${run.error ? `<div style="background:var(--color-danger)1a;border:1px solid var(--color-danger)44;
      border-radius:6px;padding:10px 12px;font-size:12px;color:var(--color-danger);margin-bottom:8px">
      <b>Error:</b> ${_esc(run.error)}</div>` : ""}
    <details style="margin-top:4px">
      <summary style="font-size:11px;color:var(--color-ink-soft);cursor:pointer;font-family:var(--font-mono)">Event payload</summary>
      <pre style="margin-top:8px;font-size:11px;background:var(--color-surface);border:1px solid var(--color-border-soft);border-radius:4px;padding:8px;overflow-x:auto">${_esc(payloadStr)}</pre>
    </details>`;

  container.querySelector("#btn-replay").addEventListener("click", async () => {
    try {
      await api.replayRun(run.id);
      toastSuccess("Replay fired");
    } catch (err) { toastError(err); }
  });

  const stopBtn = container.querySelector("#btn-stop-run");
  if (stopBtn) {
    stopBtn.addEventListener("click", async () => {
      stopBtn.disabled = true;
      try {
        await api.stopRun(run.id);
        toastSuccess("Stop signal sent — run will halt at next turn");
      } catch (err) { toastError(err); stopBtn.disabled = false; }
    });
  }
}

// ── Run summary bar ───────────────────────────────────────────────────────

function _renderSummaryBar(container, run) {
  const bar = container.querySelector("#run-summary-bar");
  if (!bar) return;
  const steps = run.steps || [];
  if (!steps.length) { bar.innerHTML = ""; return; }

  const agentSteps  = steps.filter(s => s.step_type === "agent_call" || s.step_type === "perceptionist_call");
  const skillSteps  = steps.filter(s => s.step_type === "skill_call");
  const errorSteps  = steps.filter(s => s.error && s.step_type !== "topology_violation");
  const totalIn     = steps.reduce((n, s) => n + (s.tokens_input  || 0), 0);
  const totalOut    = steps.reduce((n, s) => n + (s.tokens_output || 0), 0);
  const duration    = _duration(run.started_at, run.ended_at);

  const pill = (label, val, color) =>
    val > 0 ? `<span style="display:inline-flex;align-items:center;gap:4px;background:${color}18;color:${color};font-family:var(--font-mono);font-size:11px;border-radius:6px;padding:3px 9px;border:1px solid ${color}33">${label} <b>${val}</b></span>` : "";

  const tokenPill = (totalIn || totalOut) ? `
    <span style="display:inline-flex;align-items:center;gap:4px;background:var(--color-surface);color:var(--color-ink-soft);font-family:var(--font-mono);font-size:11px;border-radius:6px;padding:3px 9px;border:1px solid var(--color-border-soft)" title="input tokens / output tokens">
      ↑${totalIn.toLocaleString()} ↓${totalOut.toLocaleString()} tok
    </span>` : "";

  bar.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 14px;background:var(--color-surface);border:1px solid var(--color-border-soft);border-radius:6px">
      ${pill("agents",  agentSteps.length, "var(--color-policy)")}
      ${pill("skills",  skillSteps.length, "var(--color-executioner)")}
      ${pill("errors",  errorSteps.length, "var(--color-danger)")}
      ${tokenPill}
      ${duration ? `<span style="margin-left:auto;font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint)">${steps.length} steps · ${duration}</span>` : `<span style="margin-left:auto;font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint)">${steps.length} steps</span>`}
    </div>`;
}

// ── Inline escalation card ────────────────────────────────────────────────

async function _loadEscalation(container, runId) {
  try {
    const items = await api.listInbox({ run_id: runId, status: "pending" });
    if (!items.length) return;
    const ha = items[0];

    const header = container.querySelector("#run-header");
    if (!header) return;

    // Remove any existing card (can be called on reload)
    header.querySelector("#run-escalation")?.remove();

    const div = document.createElement("div");
    div.id = "run-escalation";
    div.innerHTML = `
      <div style="
        margin-top:14px;
        background:var(--color-orchestrator)0f;
        border:1px solid var(--color-orchestrator)55;
        border-radius:6px;padding:14px 16px;
      ">
        <div style="font-family:var(--font-mono);font-size:10px;color:var(--color-orchestrator);letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">
          ● Awaiting Human Decision
        </div>
        <div style="font-size:14px;color:var(--color-ink);margin-bottom:10px;font-family:var(--font-display)">${_esc(ha.purpose)}</div>
        ${ha.payload ? `
          <details style="margin-bottom:12px">
            <summary style="font-size:11px;color:var(--color-ink-soft);cursor:pointer;font-family:var(--font-mono)">Proposed action</summary>
            <pre style="margin-top:6px;font-size:11px;background:var(--color-bg);border:1px solid var(--color-border-soft);border-radius:4px;padding:8px;overflow-x:auto;max-height:200px">${_esc(JSON.stringify(ha.payload, null, 2))}</pre>
          </details>` : ""}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm" id="btn-ha-approve" style="
            background:var(--color-success);color:white;
            border-color:var(--color-success);font-size:12px;
          ">✓ Approve</button>
          <button class="btn btn-ghost btn-sm" id="btn-ha-reject" style="
            color:var(--color-danger);border-color:var(--color-danger);font-size:12px;
          ">✕ Reject</button>
        </div>
      </div>`;
    header.appendChild(div);

    div.querySelector("#btn-ha-approve").addEventListener("click", async () => {
      try {
        await api.decideInboxItem(ha.id, { decision: "yes" });
        toastSuccess("Approved — run will resume");
        div.remove();
      } catch (err) { toastError(err); }
    });

    div.querySelector("#btn-ha-reject").addEventListener("click", async () => {
      try {
        await api.decideInboxItem(ha.id, { decision: "no" });
        toastSuccess("Rejected");
        div.remove();
      } catch (err) { toastError(err); }
    });
  } catch { /* run may not have a pending inbox item */ }
}

function _renderViolations(container, steps) {
  const box = container.querySelector("#violations-box");
  const violations = steps.filter(s => s.step_type === "topology_violation");
  if (!violations.length) { box.style.display = "none"; return; }
  box.style.display = "";
  box.innerHTML = `
    <div style="background:var(--color-amber)1a;border:1px solid var(--color-amber)88;border-radius:6px;padding:12px 16px">
      <div style="font-weight:600;font-size:12px;color:var(--color-amber);margin-bottom:8px;font-family:var(--font-mono)">Topology violations (${violations.length})</div>
      ${violations.map(v => `
        <div style="font-size:12px;padding:4px 0;border-bottom:1px solid var(--color-border-soft);font-family:var(--font-mono)">
          <span>${_esc(v.step_name)}</span>
          ${v.error ? ` — <span style="color:var(--color-ink-soft)">${_esc(v.error)}</span>` : ""}
        </div>`).join("")}
    </div>`;
}

function _renderSteps(container, steps, activeIdx = -1, onSeek = null) {
  const list = container.querySelector("#steps-list");
  if (!steps.length) {
    list.innerHTML = `<div style="color:var(--color-ink-soft);font-size:13px;padding:20px 0;font-family:var(--font-mono)">No steps recorded yet.</div>`;
    return;
  }

  list.innerHTML = steps.map((step, i) => {
    const isViolation = step.step_type === "topology_violation";
    const isActive    = activeIdx === i;
    const borderColor = isActive ? "var(--color-amber)" : (isViolation ? "var(--color-amber)" : (step.error ? "var(--color-danger)" : "var(--color-border-soft)"));
    const typeLabel   = _stepTypeLabel(step.step_type);
    const typeColor   = _stepTypeColor(step.step_type);
    const duration    = _duration(step.started_at, step.ended_at);
    const inputStr    = step.input  ? JSON.stringify(step.input,  null, 2) : null;
    const outputStr   = step.output ? JSON.stringify(step.output, null, 2) : null;
    const hasIO       = inputStr || outputStr;
    const stepId      = `step-${step.id}`;
    const tokenStr    = (step.tokens_input || step.tokens_output)
      ? `↑${(step.tokens_input  || 0).toLocaleString()} ↓${(step.tokens_output || 0).toLocaleString()} tok`
      : null;

    return `
      <div id="step-card-${step.id}" class="step-card" style="display:flex;gap:12px;margin-bottom:12px;cursor:pointer"
        data-step-idx="${i}">
        <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0">
          <div style="width:28px;height:28px;border-radius:50%;background:var(--color-surface);border:2px solid ${borderColor};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--color-ink-soft);font-family:var(--font-mono)">${i + 1}</div>
          ${i < steps.length - 1 ? `<div style="width:2px;flex:1;background:var(--color-border-soft);margin-top:4px"></div>` : ""}
        </div>
        <div style="flex:1;border:1px solid ${borderColor};border-radius:6px;padding:12px 14px;margin-bottom:4px;background:${isViolation ? "var(--color-amber)0a" : "var(--color-surface)"}">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:${step.error || hasIO ? 8 : 0}px">
            <span style="font-weight:600;font-size:13px;font-family:var(--font-display)">${_esc(step.step_name)}</span>
            <span style="font-size:10px;font-family:var(--font-mono);background:${typeColor}18;color:${typeColor};padding:1px 6px;border-radius:4px;border:1px solid ${typeColor}33">${typeLabel}</span>
            ${step.edge_purpose ? `<span style="font-size:11px;font-style:italic;color:var(--color-policy);background:var(--color-policy)18;padding:1px 7px;border-radius:10px;font-family:var(--font-sans)">"${_esc(step.edge_purpose)}"</span>` : ""}
            <div style="margin-left:auto;display:flex;align-items:center;gap:8px">
              ${tokenStr ? `<span style="font-size:10px;font-family:var(--font-mono);color:var(--color-ink-faint)" title="LLM tokens used">${tokenStr}</span>` : ""}
              ${duration ? `<span style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono)">${duration}</span>` : ""}
            </div>
          </div>
          ${step.error ? `<div style="font-size:12px;color:var(--color-danger);background:var(--color-danger)0f;border:1px solid var(--color-danger)33;border-radius:4px;padding:8px 10px;margin-bottom:8px;font-family:var(--font-mono)">${_esc(step.error)}</div>` : ""}
          ${step.output && !step.error ? `<div style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint);
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:6px"
            title="${_esc(_summarizeOutput(step.output))}">↳ ${_esc(_summarizeOutput(step.output))}</div>` : ""}
          ${hasIO ? `
            <div class="step-io" id="${stepId}" data-input="${_esc(inputStr || "")}" data-output="${_esc(outputStr || "")}">
              <div style="display:flex;align-items:center;gap:0;border-bottom:1px solid var(--color-border-soft);margin-bottom:8px">
                <button class="io-tab" data-step="${stepId}" data-pane="input"
                  style="font-size:11px;font-family:var(--font-mono);background:none;border:none;border-bottom:2px solid transparent;padding:4px 10px;cursor:pointer;color:var(--color-ink-soft)">Input</button>
                <button class="io-tab active" data-step="${stepId}" data-pane="output"
                  style="font-size:11px;font-family:var(--font-mono);background:none;border:none;border-bottom:2px solid var(--color-policy);padding:4px 10px;cursor:pointer;color:var(--color-policy)">Output</button>
                <button class="io-expand" data-step="${stepId}"
                  style="margin-left:auto;font-size:11px;font-family:var(--font-mono);background:none;border:none;cursor:pointer;color:var(--color-ink-faint);padding:4px 8px" title="Expand">⤢</button>
              </div>
              <div class="io-pane" data-step="${stepId}" data-pane="input" style="display:none">
                ${inputStr ? `<pre style="font-size:11px;background:var(--color-bg);border:1px solid var(--color-border-soft);border-radius:4px;padding:8px;overflow-x:auto;max-height:220px;margin:0">${_esc(inputStr)}</pre>` : `<span style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono)">No input recorded</span>`}
              </div>
              <div class="io-pane" data-step="${stepId}" data-pane="output">
                ${outputStr ? `<pre style="font-size:11px;background:var(--color-bg);border:1px solid var(--color-border-soft);border-radius:4px;padding:8px;overflow-x:auto;max-height:220px;margin:0">${_esc(outputStr)}</pre>` : `<span style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono)">No output yet</span>`}
              </div>
            </div>` : ""}
        </div>
      </div>`;
  }).join("");

  // Wire tab switching
  list.querySelectorAll(".io-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const stepId = btn.dataset.step;
      const pane   = btn.dataset.pane;
      list.querySelectorAll(`.io-tab[data-step="${stepId}"]`).forEach(t => {
        const active = t.dataset.pane === pane;
        t.style.borderBottomColor = active ? "var(--color-policy)" : "transparent";
        t.style.color = active ? "var(--color-policy)" : "var(--color-ink-soft)";
        t.classList.toggle("active", active);
      });
      list.querySelectorAll(`.io-pane[data-step="${stepId}"]`).forEach(p => {
        p.style.display = p.dataset.pane === pane ? "" : "none";
      });
    });
  });

  // Expand IO pane to fullscreen modal
  list.querySelectorAll(".io-expand").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const stepId = btn.dataset.step;
      const ioEl   = list.querySelector(`.step-io[id="${stepId}"]`);
      const activePane = ioEl?.querySelector(".io-tab.active")?.dataset?.pane || "output";
      const content = activePane === "output"
        ? ioEl?.dataset?.output
        : ioEl?.dataset?.input;
      if (!content) return;
      const veil = document.createElement("div");
      veil.className = "modal-veil";
      veil.innerHTML = `
        <div class="modal-box" style="max-width:900px;width:92vw;max-height:85vh;display:flex;flex-direction:column">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-shrink:0">
            <div style="font-family:var(--font-mono);font-size:12px;font-weight:600;text-transform:uppercase;
              letter-spacing:.07em;color:var(--color-ink-soft)">${activePane === "output" ? "Output" : "Input"}</div>
            <button class="modal-close-x" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--color-ink-soft);line-height:1">×</button>
          </div>
          <pre style="flex:1;overflow:auto;font-size:12px;background:var(--color-bg);
            border:1px solid var(--color-border-soft);border-radius:4px;
            padding:12px;margin:0;white-space:pre-wrap;word-break:break-all">${_esc(content)}</pre>
        </div>`;
      document.body.appendChild(veil);
      veil.querySelector(".modal-close-x").addEventListener("click", () => veil.remove());
      veil.addEventListener("click", e => { if (e.target === veil) veil.remove(); });
    });
  });

  // Click on step card to seek replay
  if (onSeek) {
    list.querySelectorAll(".step-card").forEach(card => {
      card.addEventListener("click", e => {
        if (e.target.closest("button,pre,details")) return;
        onSeek(parseInt(card.dataset.stepIdx, 10));
      });
    });
  }
}

// ── Swimlane ──────────────────────────────────────────────────────────────

function _renderSwimlane(container, steps, run, activeIdx, onSeek) {
  const swimEl = container.querySelector("#swimlane");
  if (!swimEl) return;

  const runStart = run.started_at ? new Date(run.started_at) : null;
  const runEnd   = run.ended_at   ? new Date(run.ended_at)   : new Date();

  if (!runStart || !steps.length) {
    swimEl.innerHTML = `<div style="padding:24px 24px;font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint)">No timeline data yet.</div>`;
    return;
  }

  const totalMs = Math.max(runEnd - runStart, 500);

  // Unique lanes in order of first appearance
  const laneOrder = [];
  const seen = new Set();
  steps.forEach(s => {
    const key = `${s.step_type}:${s.step_name}`;
    if (!seen.has(key)) { seen.add(key); laneOrder.push({ name: s.step_name, type: s.step_type }); }
  });

  const pct = iso => {
    if (!iso) return null;
    return Math.min(100, Math.max(0, ((new Date(iso) - runStart) / totalMs) * 100));
  };

  // Time axis ticks
  const TICK_N   = 6;
  const tickMsStep = totalMs / TICK_N;
  const ticks = Array.from({length: TICK_N + 1}, (_, i) => ({
    pct:   (i / TICK_N) * 100,
    label: _msLabel(i * tickMsStep),
  }));

  const LANE_H   = 34;
  const LABEL_W  = 130;

  const ticksHtml = ticks.map(t =>
    `<div style="position:absolute;left:calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${t.pct / 100});transform:translateX(-50%);font-family:var(--font-mono);font-size:9px;color:var(--color-ink-faint);white-space:nowrap">${t.label}</div>`
  ).join("");

  const gridLinesHtml = ticks.map(t =>
    `<div style="position:absolute;left:calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${t.pct / 100});top:0;bottom:0;width:1px;background:var(--color-cream-line);opacity:.5"></div>`
  ).join("");

  const lanesHtml = laneOrder.map(lane => {
    const laneSteps = steps.filter(s => s.step_name === lane.name && s.step_type === lane.type);
    const color = _stepTypeColor(lane.type);
    const barsHtml = laneSteps.map(step => {
      const sp = pct(step.started_at);
      if (sp === null) return "";
      const ep = pct(step.ended_at);
      const wPct = ep !== null ? Math.max(ep - sp, 0.4) : Math.max((100 - sp) * 0.4, 1);
      const isActive = steps.indexOf(step) === activeIdx;
      const tip = `${_esc(step.step_name)} · ${_duration(step.started_at, step.ended_at) || "in progress"}`;
      return `<div
        class="swimlane-bar"
        data-step-id="${step.id}"
        data-step-idx="${steps.indexOf(step)}"
        data-base-opacity="${isActive ? "1" : ".72"}"
        title="${tip}"
        style="
          position:absolute;
          left:calc((100% * ${sp / 100}));
          width:calc(100% * ${wPct / 100});
          top:20%;height:60%;
          background:${color};
          border-radius:3px;
          opacity:${isActive ? "1" : ".72"};
          outline:${isActive ? "2px solid var(--color-amber)" : "none"};
          cursor:pointer;
          transition:opacity .1s;
        "
      ></div>`;
    }).join("");

    return `<div style="display:flex;align-items:center;border-bottom:1px dashed var(--color-cream-line);height:${LANE_H}px;position:relative">
      <div style="
        width:${LABEL_W}px;flex-shrink:0;padding:0 10px 0 14px;
        font-family:var(--font-mono);font-size:10px;
        color:var(--color-ink-soft);display:flex;align-items:center;gap:6px;
        white-space:nowrap;overflow:hidden;
      " title="${_esc(lane.name)}">
        <span style="width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0;display:inline-block"></span>
        <span style="overflow:hidden;text-overflow:ellipsis">${_esc(lane.name)}</span>
      </div>
      <div style="flex:1;position:relative;height:100%">
        ${gridLinesHtml}
        ${barsHtml}
      </div>
    </div>`;
  }).join("");

  swimEl.innerHTML = `
    <!-- Time axis -->
    <div style="position:relative;height:22px;border-bottom:1px dashed var(--color-cream-line);background:var(--color-parchment);flex-shrink:0">
      ${ticksHtml}
    </div>
    ${lanesHtml}`;

  // Wire bar interactions
  swimEl.querySelectorAll(".swimlane-bar").forEach(bar => {
    bar.addEventListener("mouseenter", () => { bar.style.opacity = "1"; });
    bar.addEventListener("mouseleave", () => { bar.style.opacity = bar.dataset.baseOpacity || ".72"; });
    bar.addEventListener("click", () => {
      if (onSeek) onSeek(parseInt(bar.dataset.stepIdx, 10));
    });
  });
}

function _applyReplayHighlight(container, steps, idx) {
  // Clear all
  container.querySelectorAll(".step-card").forEach(c => { c.style.outline = ""; });
  container.querySelectorAll(".swimlane-bar").forEach(b => {
    b.style.opacity  = b.dataset.baseOpacity || ".72";
    b.style.outline  = "";
  });

  if (idx < 0 || idx >= steps.length) return;
  const step = steps[idx];

  // Highlight card in log
  const card = container.querySelector(`#step-card-${step.id}`);
  if (card) {
    card.style.outline = "2px solid var(--color-amber)";
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // Highlight bar in swimlane
  const bar = container.querySelector(`.swimlane-bar[data-step-id="${step.id}"]`);
  if (bar) {
    bar.style.opacity = "1";
    bar.style.outline = "2px solid var(--color-amber)";
    bar.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // Update counter + buttons
  const counter  = container.querySelector("#replay-counter");
  const prevBtn  = container.querySelector("#replay-prev");
  const nextBtn  = container.querySelector("#replay-next");
  const firstBtn = container.querySelector("#replay-first");
  const lastBtn  = container.querySelector("#replay-last");
  if (counter)  counter.textContent  = `${idx + 1} / ${steps.length}`;
  if (firstBtn) firstBtn.disabled    = idx === 0;
  if (prevBtn)  prevBtn.disabled     = idx === 0;
  if (nextBtn)  nextBtn.disabled     = idx === steps.length - 1;
  if (lastBtn)  lastBtn.disabled     = idx === steps.length - 1;
}

// ── Utilities ─────────────────────────────────────────────────────────────

function _statusBadge(status) {
  return {
    running:        { dot: `<span style="color:var(--color-amber);font-size:12px">●</span>`,        label: "Running" },
    completed:      { dot: `<span style="color:var(--color-success);font-size:12px">●</span>`,      label: "Completed" },
    failed:         { dot: `<span style="color:var(--color-danger);font-size:12px">●</span>`,       label: "Failed" },
    pending:        { dot: `<span style="color:var(--color-ink-faint);font-size:12px">●</span>`,    label: "Pending" },
    awaiting_human: { dot: `<span style="color:var(--color-orchestrator);font-size:12px">●</span>`, label: "Awaiting" },
  }[status] || { dot: `<span style="color:var(--color-ink-faint);font-size:12px">●</span>`, label: status || "—" };
}

function _statusColor(status) {
  return {
    running:        "var(--color-amber)",
    completed:      "var(--color-success)",
    failed:         "var(--color-danger)",
    pending:        "var(--color-ink-faint)",
    awaiting_human: "var(--color-orchestrator)",
  }[status] || "var(--color-ink-faint)";
}

function _stepTypeColor(type) {
  return {
    agent_call:          "var(--color-policy)",
    skill_call:          "var(--color-executioner)",
    perceptionist_call:  "var(--color-perceptionist)",
    human_escalation:    "var(--color-orchestrator)",
    caller_call:         "var(--color-orchestrator)",
    informer_notify:     "var(--color-ink-soft)",
    topology_violation:  "var(--color-amber)",
  }[type] || "var(--color-ink-faint)";
}

function _stepTypeLabel(type) {
  return {
    agent_call:          "Agent",
    skill_call:          "Skill",
    perceptionist_call:  "Perceptionist",
    human_escalation:    "Human",
    caller_call:         "Caller",
    informer_notify:     "Informer",
    topology_violation:  "Violation",
  }[type] || type;
}

function _duration(start, end) {
  if (!start || !end) return null;
  const ms = new Date(end) - new Date(start);
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function _summarizeOutput(obj) {
  if (!obj) return "";
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  return s.length > 130 ? s.slice(0, 130) + "…" : s;
}

function _msLabel(ms) {
  if (ms < 1000)  return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function _reltime(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60)    return "just now";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function _esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
