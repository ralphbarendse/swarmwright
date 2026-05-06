import * as api from "../api.js";
import { toastError, toastSuccess } from "../components/toast.js";
import { onEvent, offEvent } from "../sse.js";
import { _showModal } from "./org-design.js";

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
    container.style.cssText = "overflow-y:auto";
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
          <input type="date" id="fl-date-from" class="form-input" title="From date"
            style="width:130px;font-size:12px;padding:4px 8px;cursor:pointer">
          <span style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint)">→</span>
          <input type="date" id="fl-date-to" class="form-input" title="To date"
            style="width:130px;font-size:12px;padding:4px 8px;cursor:pointer">
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
  const _showFireModal = (swarmId, swarmName) => {
    _showModal(
      `Fire · ${swarmName}`,
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
    row.className = "card";
    row.style.cssText = "margin-bottom:7px;cursor:pointer;display:flex;align-items:center;gap:14px;padding:10px 14px";

    const { dot, label } = _statusBadge(run.status);
    const duration = _duration(run.started_at, run.ended_at);
    const started  = run.started_at ? _reltime(run.started_at) : "—";

    row.innerHTML = `
      <span style="flex-shrink:0">${dot}</span>
      <div style="flex:1;min-width:0">
        <div style="
          font-family:var(--font-display);font-size:14px;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
          color:var(--color-ink);
        ">${_esc(run.swarm_display_name || run.swarm_id)}</div>
        <div style="
          font-family:var(--font-mono);font-size:10px;
          color:var(--color-ink-faint);margin-top:2px;
        ">${_esc(run.id.slice(0, 8))} · ${_esc(run.source || "—")}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="
          font-family:var(--font-mono);font-size:10px;
          background:${_statusColor(run.status)}22;
          color:${_statusColor(run.status)};
          padding:2px 7px;border-radius:4px;display:inline-block;
        ">${label}</div>
        <div style="
          font-family:var(--font-mono);font-size:10px;
          color:var(--color-ink-faint);margin-top:4px;
        ">${started}${duration ? ` · ${duration}` : ""}</div>
      </div>`;

    row.addEventListener("click", () => window.swNav(`runs/${run.id}`));
    list.appendChild(row);
  });
}

// ── Run detail ────────────────────────────────────────────────────────────

async function _renderRunDetail(container, runId, addCleanup) {
  container.innerHTML = `
    <div class="crumbs">
      <span class="crumb-link" id="crumb-runs">Control Room</span>
      <span class="crumb-sep">›</span>
      <span class="crumb-here" id="crumb-run-id">…</span>
    </div>
    <div style="padding:0 24px;max-width:860px">
      <div id="run-header" style="margin-bottom:20px"></div>
      <div id="violations-box" style="display:none;margin-bottom:16px"></div>
      <div class="sec-header" style="margin-bottom:12px">Step trace</div>
      <div id="steps-list"></div>
    </div>`;

  container.querySelector("#crumb-runs").addEventListener("click", () => window.swNav("runs"));

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
  });

  const _reload = async () => {
    try {
      const run = await api.getRun(runId);
      container.querySelector("#crumb-run-id").textContent = run.id.slice(0, 8);
      _renderRunHeader(container, run);
      if (run.status === "awaiting_human") _loadEscalation(container, run.id);
      _renderViolations(container, run.steps || []);
      _renderSteps(container, run.steps || []);
    } catch (err) { toastError(err); }
  };

  await _reload();
}

function _renderRunHeader(container, run) {
  const header = container.querySelector("#run-header");
  const { dot, label } = _statusBadge(run.status);
  const duration = _duration(run.started_at, run.ended_at);
  const payloadStr = JSON.stringify(run.event_payload || {}, null, 2);

  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <span>${dot}</span>
      <span style="font-family:var(--font-mono);font-size:11px;background:${_statusColor(run.status)}22;color:${_statusColor(run.status)};padding:2px 8px;border-radius:4px">${label}</span>
      <span style="font-family:var(--font-display);font-size:16px;color:var(--color-ink)">${_esc(run.swarm_display_name || run.swarm_id)}</span>
      <span style="color:var(--color-ink-faint);font-size:11px;font-family:var(--font-mono)">${_esc(run.id)}</span>
      <button class="btn btn-ghost btn-sm" id="btn-replay" style="margin-left:auto">↺ Replay</button>
    </div>
    <div style="display:flex;gap:24px;flex-wrap:wrap;font-size:12px;font-family:var(--font-mono);color:var(--color-ink-soft);margin-bottom:${run.error ? 0 : 8}px">
      <span><b>Source</b> ${_esc(run.source || "—")}</span>
      <span><b>Started</b> ${run.started_at ? new Date(run.started_at).toLocaleString() : "—"}</span>
      <span><b>Ended</b> ${run.ended_at ? new Date(run.ended_at).toLocaleString() : "—"}</span>
      ${duration ? `<span><b>Duration</b> ${duration}</span>` : ""}
    </div>
    ${run.error ? `<div style="background:var(--color-danger)1a;border:1px solid var(--color-danger)44;border-radius:6px;padding:10px 12px;font-size:12px;color:var(--color-danger);margin-top:12px"><b>Error:</b> ${_esc(run.error)}</div>` : ""}
    <details style="margin-top:10px">
      <summary style="font-size:11px;color:var(--color-ink-soft);cursor:pointer;font-family:var(--font-mono)">Event payload</summary>
      <pre style="margin-top:8px;font-size:11px;background:var(--color-surface);border:1px solid var(--color-border-soft);border-radius:4px;padding:8px;overflow-x:auto">${_esc(payloadStr)}</pre>
    </details>`;

  container.querySelector("#btn-replay").addEventListener("click", async () => {
    try {
      await api.replayRun(run.id);
      toastSuccess("Replay fired");
    } catch (err) { toastError(err); }
  });
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

function _renderSteps(container, steps) {
  const list = container.querySelector("#steps-list");
  if (!steps.length) {
    list.innerHTML = `<div style="color:var(--color-ink-soft);font-size:13px;padding:20px 0;font-family:var(--font-mono)">No steps recorded yet.</div>`;
    return;
  }
  list.innerHTML = steps.map((step, i) => {
    const isViolation = step.step_type === "topology_violation";
    const borderColor = isViolation ? "var(--color-amber)" : (step.error ? "var(--color-danger)" : "var(--color-border-soft)");
    const typeLabel   = _stepTypeLabel(step.step_type);
    const duration    = _duration(step.started_at, step.ended_at);
    const outputStr   = step.output ? JSON.stringify(step.output, null, 2) : null;
    return `
      <div style="display:flex;gap:12px;margin-bottom:12px">
        <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0">
          <div style="width:28px;height:28px;border-radius:50%;background:var(--color-surface);border:2px solid ${borderColor};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--color-ink-soft);font-family:var(--font-mono)">${i + 1}</div>
          ${i < steps.length - 1 ? `<div style="width:2px;flex:1;background:var(--color-border-soft);margin-top:4px"></div>` : ""}
        </div>
        <div style="flex:1;border:1px solid ${borderColor};border-radius:6px;padding:12px 14px;margin-bottom:4px;background:${isViolation ? "var(--color-amber)0a" : "var(--color-surface)"}">
          <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px">
            <span style="font-weight:600;font-size:13px;font-family:var(--font-display)">${_esc(step.step_name)}</span>
            <span style="font-size:10px;font-family:var(--font-mono);background:var(--color-surface);color:var(--color-ink-soft);padding:1px 6px;border-radius:4px">${typeLabel}</span>
            ${step.edge_purpose ? `<span style="font-size:12px;font-style:italic;color:var(--color-policy);background:var(--color-policy)18;padding:1px 7px;border-radius:10px;font-family:var(--font-sans)">"${_esc(step.edge_purpose)}"</span>` : ""}
            ${duration ? `<span style="font-size:11px;color:var(--color-ink-faint);margin-left:auto;font-family:var(--font-mono)">${duration}</span>` : ""}
          </div>
          ${step.error ? `<div style="font-size:12px;color:var(--color-danger);margin-bottom:6px">${_esc(step.error)}</div>` : ""}
          ${outputStr ? `<details style="margin-top:4px"><summary style="font-size:11px;color:var(--color-ink-soft);cursor:pointer;font-family:var(--font-mono)">Output</summary><pre style="margin-top:6px;font-size:11px;background:var(--color-bg);border:1px solid var(--color-border-soft);border-radius:4px;padding:8px;overflow-x:auto;max-height:200px">${_esc(outputStr)}</pre></details>` : ""}
        </div>
      </div>`;
  }).join("");
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
