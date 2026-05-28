import * as api from "../api.js";
import { toast, toastError, toastSuccess } from "../components/toast.js";
import { canDo } from "../auth.js";
import { mountChatWidget } from "../components/chat-panel.js";

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
    </div>
    ${showChat ? `<div class="chat-zone-divider" id="chat-divider"></div><div id="chat-zone" class="chat-zone"></div>` : ""}`;

  container.querySelector("#btn-new-ws")?.addEventListener("click", () => _showCreateWorkspaceModal(() => _renderWorkspaceList(container)));

  try {
    const workspaces = await api.listWorkspaces();
    const grid = container.querySelector("#ws-grid");
    if (!workspaces.length) {
      grid.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🏢</div><div class="empty-state-title">No workspaces yet</div><div class="empty-state-sub">Create your first workspace to get started.</div></div>`;
    } else {
      grid.innerHTML = workspaces.map(ws => _wsRow(ws)).join("") +
        (canDo("can_create_workspace") ? `<div style="margin-top:6px"><button class="btn btn-ghost btn-sm" id="add-ws-card" style="font-size:12px;color:var(--color-ink-faint)">+ New workspace</button></div>` : "");
      grid.querySelector("#add-ws-card")?.addEventListener("click", () => _showCreateWorkspaceModal(() => _renderWorkspaceList(container)));
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

    // Concierge chat zone — inject only if workspace has a concierge swarm
    const hasConcierge = canDo("can_chat_workspace") &&
      (ws.swarms || []).some(s => s.name === "concierge");
    if (hasConcierge) {
      const divider = document.createElement("div");
      divider.className = "chat-zone-divider";
      const chatZone = document.createElement("div");
      chatZone.className = "chat-zone";
      container.appendChild(divider);
      container.appendChild(chatZone);
      _wireResizeDivider(divider, chatZone, `sw-concierge-chat-w-${wsId}`);
      _chatDestroy = mountChatWidget({
        scope: "workspace",
        workspaceId: ws.id,
        title: `${ws.display_name} · Concierge`,
        container: chatZone,
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
