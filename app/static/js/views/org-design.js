import * as api from "../api.js";
import { toast, toastError, toastSuccess } from "../components/toast.js";

/**
 * Org-design view.
 *
 * Routes:
 *   segments = []        → workspace list
 *   segments = ["ws", id] → workspace detail
 */
export function renderOrgView(container, segments = []) {
  container.style.overflowY = "auto";

  if (segments[0] === "ws" && segments[1]) {
    _renderWorkspaceDetail(container, segments[1]);
  } else {
    _renderWorkspaceList(container);
  }
  return null;
}

// ── Workspace list ─────────────────────────────────────────────────────────

async function _renderWorkspaceList(container) {
  container.innerHTML = `
    <div class="page-header flex-row" style="justify-content:space-between">
      <div>
        <div class="page-title">Workspaces</div>
        <div class="page-sub">Department-like containers for swarms</div>
      </div>
      <button class="btn btn-primary" id="btn-new-ws">+ New workspace</button>
    </div>
    <div id="ws-grid" class="card-grid card-grid-3" style="padding:0 24px 24px"></div>`;

  container.querySelector("#btn-new-ws").addEventListener("click", () => _showCreateWorkspaceModal(() => _renderWorkspaceList(container)));

  try {
    const workspaces = await api.listWorkspaces();
    const grid = container.querySelector("#ws-grid");
    if (!workspaces.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">🏢</div><div class="empty-state-title">No workspaces yet</div><div class="empty-state-sub">Create your first workspace to get started.</div></div>`;
      return;
    }
    grid.innerHTML = workspaces.map(ws => _wsCard(ws)).join("") +
      `<div class="card card-add" id="add-ws-card">+ New workspace</div>`;
    grid.querySelector("#add-ws-card").addEventListener("click", () => _showCreateWorkspaceModal(() => _renderWorkspaceList(container)));
    grid.querySelectorAll(".ws-card").forEach(el => {
      el.addEventListener("click", () => window.swNav(`org/ws/${el.dataset.id}`));
    });
  } catch (err) { toastError(err); }
}

function _wsCard(ws) {
  const swarmCount = ws.swarm_count ?? 0;
  const updated = ws.updated_at ? _reltime(ws.updated_at) : "";
  return `
    <div class="card ws-card" data-id="${ws.id}" style="min-height:140px">
      <div class="flex-row">
        <div class="card-icon">🏢</div>
        <div class="badge badge-layer" style="font-size:10px">${_esc(ws.name)}</div>
      </div>
      <div class="card-title">${_esc(ws.display_name)}</div>
      <div class="card-desc">${_esc(ws.description || "No description")}</div>
      <div class="card-foot"><span>${swarmCount} swarms</span><span>${updated}</span></div>
    </div>`;
}

// ── Workspace detail ───────────────────────────────────────────────────────

async function _renderWorkspaceDetail(container, wsId) {
  container.innerHTML = `
    <div class="crumbs">
      <span class="crumb-link" id="crumb-workspaces">Workspaces</span>
      <span class="crumb-sep">›</span>
      <span class="crumb-here" id="crumb-ws-name">…</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 280px;gap:0;height:calc(100% - 38px);overflow:hidden">
      <div style="overflow-y:auto;padding:24px">
        <div class="flex-row" style="justify-content:space-between;margin-bottom:20px">
          <div>
            <div class="page-title" id="ws-title">…</div>
            <div class="page-sub" id="ws-desc"></div>
          </div>
          <div class="flex-row">
            <button class="btn btn-secondary btn-sm" id="btn-edit-ws">Edit</button>
            <button class="btn btn-danger btn-sm" id="btn-del-ws">Delete</button>
          </div>
        </div>
        <div class="sec-header">Swarms</div>
        <div id="swarm-grid" class="card-grid card-grid-2"></div>
      </div>
      <div style="border-left:1px solid var(--color-border-soft);padding:24px;overflow-y:auto;background:var(--color-bg)">
        <div class="sec-header">Workspace resources</div>
        <div id="ws-resources"></div>
      </div>
    </div>`;

  container.querySelector("#crumb-workspaces").addEventListener("click", () => window.swNav("org"));

  try {
    const ws = await api.getWorkspace(wsId);
    container.querySelector("#crumb-ws-name").textContent = ws.display_name;
    container.querySelector("#ws-title").textContent = ws.display_name;
    container.querySelector("#ws-desc").textContent = ws.description || "";

    // Edit workspace
    container.querySelector("#btn-edit-ws").addEventListener("click", () =>
      _showEditWorkspaceModal(ws, () => _renderWorkspaceDetail(container, wsId)));

    // Delete workspace — use modal, not confirm()
    container.querySelector("#btn-del-ws").addEventListener("click", () => {
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
      `<div class="card card-add" id="add-swarm-card">+ New swarm</div>`;

    grid.querySelector("#add-swarm-card").addEventListener("click", () =>
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
          <button class="btn btn-ghost btn-sm swarm-fire-btn" data-id="${s.id}" data-name="${_esc(s.display_name)}"
            style="padding:2px 8px;font-size:11px" title="Fire event">▶</button>
          <button class="btn btn-ghost btn-sm swarm-toggle-btn" data-id="${s.id}" data-enabled="${enabled}"
            style="padding:2px 8px;font-size:11px;${toggleStyle}">${toggleLabel}</button>
          <button class="btn btn-ghost btn-sm swarm-edit-btn" data-id="${s.id}" data-name="${_esc(s.display_name)}" data-desc="${_esc(s.description || '')}"
            style="padding:2px 8px;font-size:11px">Edit</button>
          <button class="btn btn-ghost btn-sm swarm-transfer-btn" data-id="${s.id}" data-name="${_esc(s.display_name)}" data-wsid="${_esc(s.workspace_id || '')}"
            style="padding:2px 8px;font-size:11px">Transfer</button>
          <button class="btn btn-ghost btn-sm swarm-del-btn" data-id="${s.id}" data-name="${_esc(s.display_name)}"
            style="padding:2px 8px;font-size:11px;color:var(--color-danger)">Delete</button>
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

function _showCreateWorkspaceModal(onDone) {
  _showModal("New workspace", `
    <div class="form-group">
      <label class="form-label">Display name</label>
      <input class="form-input" id="m-name" type="text" placeholder="e.g. Finance">
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <input class="form-input" id="m-desc" type="text" placeholder="What does this workspace do?">
    </div>`,
    async () => {
      const name = document.getElementById("m-name")?.value.trim();
      if (!name) throw { message: "Name is required" };
      await api.createWorkspace({ display_name: name, description: document.getElementById("m-desc")?.value.trim() || null });
      toastSuccess("Workspace created");
      onDone();
    }
  );
  setTimeout(() => document.getElementById("m-name")?.focus(), 50);
}

function _showEditWorkspaceModal(ws, onDone) {
  _showModal("Edit workspace", `
    <div class="form-group">
      <label class="form-label">Display name</label>
      <input class="form-input" id="m-name" type="text" value="${_esc(ws.display_name)}">
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <input class="form-input" id="m-desc" type="text" value="${_esc(ws.description || '')}">
    </div>`,
    async () => {
      await api.updateWorkspace(ws.id, {
        display_name: document.getElementById("m-name")?.value.trim() || ws.display_name,
        description: document.getElementById("m-desc")?.value.trim() || null,
      });
      toastSuccess("Saved");
      onDone();
    }
  );
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
        <button class="modal-close" id="modal-x">✕</button>
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

  return { close };
}

// ── Utilities ──────────────────────────────────────────────────────────────

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
