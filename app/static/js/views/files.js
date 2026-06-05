import * as api from "../api.js";
import { toastError, toastSuccess } from "../components/toast.js";
import { canDo } from "../auth.js";
import { fillFilePreview, fileIcon, fmtBytes } from "../components/file-preview.js";

/**
 * Files view — an org-wide file browser over every swarm's file store.
 *
 * Files still live inside each swarm (written by agents/humans, or linked from
 * another swarm). This page gives humans one place to find, preview, upload and
 * cross-link them: a workspace → swarm → folder tree on the left, a table/grid
 * of the selected scope on the right, and a slide-over preview panel.
 *
 * Route: #files
 */

const VIEW_KEY = "sw.files.view"; // "table" | "grid"

export function renderFilesView(container) {
  container.style.overflowY = "hidden";
  container.style.height = "100%";
  container.style.position = "relative"; // anchor preview/modal overlays

  container.innerHTML = `
    <style>
      .fv-row .fv-actions { opacity: 0; transition: opacity .12s; }
      .fv-row:hover .fv-actions { opacity: 1; }
      .fv-act { cursor:pointer; border:none; background:none; padding:3px 5px; border-radius:4px;
        font-size:13px; color:var(--color-ink-soft); line-height:1; }
      .fv-act:hover { background:var(--color-cream-line); color:var(--color-ink); }
      .fv-tree-item { padding:4px 8px; font-family:var(--font-mono); font-size:11px; cursor:pointer;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; border-radius:4px; }
      .fv-tree-item:hover { background:var(--color-parchment); }
      .fv-card { border:1px solid var(--color-cream-line); border-radius:7px; background:var(--color-card);
        padding:12px; cursor:pointer; transition:border-color .12s, box-shadow .12s; display:flex;
        flex-direction:column; gap:8px; min-width:0; }
      .fv-card:hover { border-color:var(--color-accent); box-shadow:0 1px 6px rgba(0,0,0,.05); }
      .fv-chip { display:inline-flex; align-items:center; gap:3px; font-family:var(--font-mono);
        font-size:9px; padding:1px 5px; border-radius:3px; vertical-align:middle; }
    </style>
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden">
      <div class="crumbs" style="flex-shrink:0">
        <span class="crumb-link" onclick="swNav('org')">Workspaces</span>
        <span class="crumb-sep">›</span>
        <span class="crumb-here">Files</span>
      </div>
      <div class="page-header" style="flex-shrink:0">
        <div class="page-title">Files</div>
        <div class="page-sub">Everything your swarms have produced, in one place</div>
      </div>
      <div style="display:flex;gap:12px;align-items:center;padding:12px 24px;
        border-bottom:1px dashed var(--color-cream-line);flex-shrink:0">
        <input id="files-search" type="text" placeholder="Search filename or path…"
          style="flex:1;max-width:320px;font-family:var(--font-mono);font-size:13px;
          padding:7px 10px;border:1px solid var(--color-cream-line);border-radius:5px;
          background:var(--color-card)">
        <select id="files-ws" class="form-select"
          style="width:180px;font-size:13px"><option value="">All workspaces</option></select>
        <div id="files-view-toggle" style="display:flex;border:1px solid var(--color-cream-line);
          border-radius:5px;overflow:hidden">
          <button data-view="table" class="fv-view-btn" title="Table view"
            style="border:none;background:none;padding:6px 9px;cursor:pointer;font-size:13px">☰</button>
          <button data-view="grid" class="fv-view-btn" title="Grid view"
            style="border:none;background:none;padding:6px 9px;cursor:pointer;font-size:13px;
            border-left:1px solid var(--color-cream-line)">▦</button>
        </div>
        <button id="files-upload-btn" class="btn btn-primary btn-sm" style="margin:0">Upload</button>
        <span id="files-count" style="margin-left:auto;font-family:var(--font-mono);
          font-size:11px;color:var(--color-ink-faint)"></span>
      </div>
      <div style="display:flex;flex:1;overflow:hidden">
        <div id="files-tree" style="width:220px;flex-shrink:0;overflow-y:auto;padding:10px 8px;
          border-right:1px dashed var(--color-cream-line);background:var(--color-panel)"></div>
        <div id="files-body" style="flex:1;overflow-y:auto;padding:14px 20px"></div>
      </div>
    </div>`;

  const searchEl = container.querySelector("#files-search");
  const wsEl     = container.querySelector("#files-ws");
  const countEl  = container.querySelector("#files-count");
  const treeEl   = container.querySelector("#files-tree");
  const bodyEl   = container.querySelector("#files-body");
  const uploadBtn = container.querySelector("#files-upload-btn");

  let allRows = [];                 // last server page (search + ws filtered)
  let total = 0;
  let selected = { kind: "all" };   // tree selection scope
  const expanded = new Set();       // expanded tree node keys
  const known = new Set();          // keys seen (so new nodes default to expanded)
  let view = localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "table";
  let searchTimer = null;
  let disposed = false;

  if (!canDo("can_edit_swarm")) uploadBtn.style.display = "none";

  // View toggle buttons
  function _syncViewButtons() {
    container.querySelectorAll(".fv-view-btn").forEach(b => {
      const on = b.dataset.view === view;
      b.style.background = on ? "var(--color-accent)" : "transparent";
      b.style.color = on ? "#fff" : "var(--color-ink-soft)";
    });
  }
  container.querySelectorAll(".fv-view-btn").forEach(b => {
    b.addEventListener("click", () => {
      view = b.dataset.view;
      localStorage.setItem(VIEW_KEY, view);
      _syncViewButtons();
      _renderBody();
    });
  });
  _syncViewButtons();

  // Populate the workspace filter once.
  api.listWorkspaces().then(wss => {
    if (disposed) return;
    for (const ws of wss) {
      const opt = document.createElement("option");
      opt.value = ws.id;
      opt.textContent = ws.display_name || ws.name;
      wsEl.appendChild(opt);
    }
  }).catch(() => { /* filter just stays "All workspaces" */ });

  async function reload() {
    const params = {};
    const q  = searchEl.value.trim();
    const ws = wsEl.value;
    if (q)  params.search = q;
    if (ws) params.workspace_id = ws;
    bodyEl.innerHTML = `<div style="font-family:var(--font-mono);font-size:12px;
      color:var(--color-ink-faint);padding:20px 0">Loading…</div>`;
    try {
      const resp = await api.listAllFiles(params);
      if (disposed) return;
      allRows = resp.rows || [];
      total = resp.total ?? allRows.length;
      _renderTree();
      _renderBody();
    } catch (e) {
      if (disposed) return;
      toastError("Could not load files");
      bodyEl.innerHTML = `<div style="font-family:var(--font-mono);font-size:12px;
        color:var(--color-danger)">Failed to load files.</div>`;
    }
  }

  // ── Tree ──────────────────────────────────────────────────────────────────

  function _buildTree() {
    // ws -> { id, label, swarms: Map(swarmId -> { id, wsId, label, prefixes:Set }) }
    const wss = new Map();
    for (const f of allRows) {
      const wsId = f.workspace_id || "—";
      if (!wss.has(wsId)) {
        wss.set(wsId, { id: wsId, label: f.workspace_display_name || f.workspace_name || "Workspace", swarms: new Map() });
      }
      const w = wss.get(wsId);
      if (!w.swarms.has(f.swarm_id)) {
        w.swarms.set(f.swarm_id, { id: f.swarm_id, wsId, label: f.swarm_display_name || f.swarm_name || "Swarm", prefixes: new Set() });
      }
      const s = w.swarms.get(f.swarm_id);
      const parts = f.path.split("/");
      let acc = "";
      for (let i = 0; i < parts.length - 1; i++) {
        acc += (acc ? "/" : "") + parts[i];
        s.prefixes.add(acc);
      }
    }
    return wss;
  }

  function _seed(key) {
    if (!known.has(key)) { known.add(key); expanded.add(key); }
  }
  function _isSel(scope) {
    if (selected.kind !== scope.kind) return false;
    return selected.wsId === scope.wsId && selected.swarmId === scope.swarmId && selected.prefix === scope.prefix;
  }

  function _renderTree() {
    const wss = _buildTree();
    const rows = [];

    rows.push(`<div class="fv-tree-item" data-scope='${JSON.stringify({ kind: "all" })}'
      style="${_isSel({ kind: "all" }) ? "background:var(--color-parchment);color:var(--color-accent);font-weight:600" : ""}">
      ▸ All files <span style="color:var(--color-ink-faint)">(${total})</span></div>`);

    for (const w of [...wss.values()].sort((a, b) => a.label.localeCompare(b.label))) {
      const wsKey = `ws:${w.id}`;
      _seed(wsKey);
      const wOpen = expanded.has(wsKey);
      const wScope = { kind: "ws", wsId: w.id };
      rows.push(`<div class="fv-tree-item" data-toggle="${wsKey}" data-scope='${JSON.stringify(wScope)}'
        style="${_isSel(wScope) ? "background:var(--color-parchment);color:var(--color-accent);font-weight:600" : ""}">
        ${wOpen ? "▾" : "▸"} ${_esc(w.label)}</div>`);
      if (!wOpen) continue;

      for (const s of [...w.swarms.values()].sort((a, b) => a.label.localeCompare(b.label))) {
        const swKey = `sw:${s.id}`;
        _seed(swKey);
        const sOpen = expanded.has(swKey);
        const sScope = { kind: "swarm", wsId: w.id, swarmId: s.id };
        rows.push(`<div class="fv-tree-item" data-toggle="${swKey}" data-scope='${JSON.stringify(sScope)}'
          style="padding-left:20px;${_isSel(sScope) ? "background:var(--color-parchment);color:var(--color-accent);font-weight:600" : ""}">
          ${s.prefixes.size ? (sOpen ? "▾" : "▸") : "·"} ${_esc(s.label)}</div>`);
        if (!sOpen) continue;

        for (const p of [...s.prefixes].sort()) {
          const depth = p.split("/").length; // 1-based folder depth
          const fScope = { kind: "folder", wsId: w.id, swarmId: s.id, prefix: p };
          rows.push(`<div class="fv-tree-item" data-scope='${JSON.stringify(fScope)}'
            style="padding-left:${20 + depth * 12}px;color:var(--color-ink-soft);${_isSel(fScope) ? "background:var(--color-parchment);color:var(--color-accent);font-weight:600" : ""}">
            ▱ ${_esc(p.split("/").pop())}</div>`);
        }
      }
    }
    treeEl.innerHTML = rows.join("");

    treeEl.querySelectorAll(".fv-tree-item").forEach(el => {
      el.addEventListener("click", () => {
        const toggle = el.dataset.toggle;
        const scope = JSON.parse(el.dataset.scope);
        // A click both selects the scope and toggles expand for branch nodes.
        if (toggle) {
          if (expanded.has(toggle)) expanded.delete(toggle); else expanded.add(toggle);
        }
        selected = scope;
        _renderTree();
        _renderBody();
      });
    });
  }

  // ── Body (table / grid) ─────────────────────────────────────────────────────

  function _inScope(f) {
    switch (selected.kind) {
      case "ws":     return f.workspace_id === selected.wsId;
      case "swarm":  return f.swarm_id === selected.swarmId;
      case "folder": return f.swarm_id === selected.swarmId &&
        (f.path === selected.prefix || f.path.startsWith(selected.prefix + "/"));
      default:       return true;
    }
  }

  function _renderBody() {
    const rows = allRows.filter(_inScope);
    const showSwarmCol = selected.kind === "all" || selected.kind === "ws";
    countEl.textContent = `${rows.length} of ${total} file${total !== 1 ? "s" : ""}`;

    if (!allRows.length) {
      bodyEl.innerHTML = `
        <div class="empty-state" style="padding:48px 0">
          <div class="empty-state-title">No files yet</div>
          <div class="empty-state-sub" style="font-family:var(--font-mono);font-size:12px;
            color:var(--color-ink-faint);margin-top:6px">
            Files written by your agents (or uploaded into a swarm) show up here.
          </div>
        </div>`;
      return;
    }
    if (!rows.length) {
      bodyEl.innerHTML = `<div style="font-family:var(--font-mono);font-size:12px;
        color:var(--color-ink-faint);padding:20px 0">No files in this folder.</div>`;
      return;
    }

    bodyEl.innerHTML = view === "grid" ? _renderGrid(rows, showSwarmCol) : _renderTable(rows, showSwarmCol);
    _wireRowActions();
  }

  function _renderTable(rows, showSwarmCol) {
    const head = `
      <tr style="text-align:left;color:var(--color-ink-soft)">
        <th style="padding:6px 12px 6px 0">Name</th>
        ${showSwarmCol ? `<th style="padding:6px 12px">Swarm</th>` : ""}
        <th style="padding:6px 12px">Size</th>
        <th style="padding:6px 12px">Origin</th>
        <th style="padding:6px 12px">Updated</th>
        <th style="padding:6px 12px">Run</th>
        <th></th>
      </tr>`;
    return `
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead style="font-family:var(--font-mono);font-size:10px;letter-spacing:.04em;
          text-transform:uppercase;border-bottom:1px solid var(--color-cream-line)">${head}</thead>
        <tbody>${rows.map(f => _tableRow(f, showSwarmCol)).join("")}</tbody>
      </table>`;
  }

  function _tableRow(f, showSwarmCol) {
    const updated = f.updated_at
      ? new Date(f.updated_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
      : "—";
    const runLink = f.created_by_run_id
      ? `<a href="#" onclick="event.stopPropagation();swNav('runs/${f.created_by_run_id}');return false"
           style="font-family:var(--font-mono);font-size:11px;color:var(--color-accent);text-decoration:none">${f.created_by_run_id.slice(0, 8)}…</a>`
      : `<span style="color:var(--color-ink-soft)">—</span>`;
    return `<tr class="fv-row" data-id="${_esc(f.id)}" style="border-bottom:1px dashed var(--color-cream-line)">
      <td style="padding:8px 12px 8px 0;font-family:var(--font-mono);max-width:340px">
        <span style="display:flex;align-items:center;gap:7px;overflow:hidden">
          <span style="flex-shrink:0">${fileIcon(f.mime_type, f.filename)}</span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(f.path)}">${_esc(f.path)}</span>
          ${_linkChips(f)}
        </span></td>
      ${showSwarmCol ? `<td style="padding:8px 12px;color:var(--color-ink-soft);white-space:nowrap;cursor:pointer"
        onclick="swNav('swarm/${f.swarm_id}')">${_esc(f.swarm_display_name || f.swarm_name || "")}</td>` : ""}
      <td style="padding:8px 12px;font-family:var(--font-mono);color:var(--color-ink-soft);white-space:nowrap">${fmtBytes(f.size_bytes)}</td>
      <td style="padding:8px 12px">${_originDot(f.origin)}</td>
      <td style="padding:8px 12px;font-family:var(--font-mono);font-size:11px;color:var(--color-ink-soft);white-space:nowrap">${updated}</td>
      <td style="padding:8px 12px">${runLink}</td>
      <td style="padding:8px 0;text-align:right;white-space:nowrap">${_actionCluster(f)}</td>
    </tr>`;
  }

  function _renderGrid(rows, showSwarmCol) {
    return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px">
      ${rows.map(f => _gridCard(f, showSwarmCol)).join("")}</div>`;
  }

  function _gridCard(f, showSwarmCol) {
    const isImg = (f.mime_type || "").startsWith("image/");
    const thumb = isImg
      ? `<div style="height:90px;border-radius:5px;overflow:hidden;background:var(--color-parchment);
           display:flex;align-items:center;justify-content:center">
           <img src="${api.rawSwarmFileUrl(f.swarm_id, f.path)}" loading="lazy"
             style="max-width:100%;max-height:100%;object-fit:contain" alt=""></div>`
      : `<div style="height:90px;border-radius:5px;background:var(--color-parchment);
           display:flex;align-items:center;justify-content:center;font-size:34px">${fileIcon(f.mime_type, f.filename)}</div>`;
    return `<div class="fv-row fv-card" data-id="${_esc(f.id)}" data-act="preview">
      ${thumb}
      <div style="display:flex;flex-direction:column;gap:3px;min-width:0">
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink);overflow:hidden;
          text-overflow:ellipsis;white-space:nowrap" title="${_esc(f.path)}">${_esc(f.filename)} ${_linkChips(f)}</span>
        <span style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint);display:flex;
          justify-content:space-between;gap:6px">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(showSwarmCol ? (f.swarm_display_name || f.swarm_name || "") : fmtBytes(f.size_bytes))}</span>
          <span>${_originDot(f.origin)}</span></span>
      </div>
      <div class="fv-actions" style="display:flex;gap:2px;justify-content:flex-end">${_actionCluster(f)}</div>
    </div>`;
  }

  function _actionCluster(f) {
    const canEdit = canDo("can_edit_swarm");
    return `<span class="fv-actions" style="display:inline-flex;gap:1px;align-items:center">
      <button class="fv-act" data-act="preview" title="Preview">👁</button>
      <button class="fv-act" data-act="download" title="Download">↓</button>
      <button class="fv-act" data-act="copy" title="Copy path">⧉</button>
      ${canEdit ? `<button class="fv-act" data-act="link" title="Link into another swarm">↗</button>` : ""}
      ${canEdit ? `<button class="fv-act" data-act="delete" title="Delete" style="color:var(--color-danger,#c0392b)">✕</button>` : ""}
    </span>`;
  }

  function _wireRowActions() {
    bodyEl.querySelectorAll("[data-id]").forEach(rowEl => {
      const id = rowEl.dataset.id;
      const f = allRows.find(r => r.id === id);
      if (!f) return;
      // Grid card body click → preview; explicit action buttons handled below.
      rowEl.querySelectorAll("[data-act]").forEach(btn => {
        if (btn === rowEl) return;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          _doAction(btn.dataset.act, f);
        });
      });
      if (view === "grid") {
        rowEl.addEventListener("click", () => _doAction("preview", f));
      }
    });
  }

  function _doAction(act, f) {
    switch (act) {
      case "preview":  _openPreview(f); break;
      case "download": window.location.href = api.downloadSwarmFileUrl(f.swarm_id, f.path); break;
      case "copy":
        navigator.clipboard?.writeText(f.path).then(() => toastSuccess("Path copied")).catch(() => {});
        break;
      case "link":     _openLinkPicker(f); break;
      case "delete":   _deleteFile(f); break;
    }
  }

  async function _deleteFile(f) {
    if (!confirm(`Delete "${f.path}"${f.is_link ? " (link only)" : ""}?`)) return;
    try {
      await api.deleteSwarmFile(f.swarm_id, f.path);
      toastSuccess(f.is_link ? "Link removed" : "Deleted");
      reload();
    } catch (err) {
      toastError(err.message || "Delete failed");
    }
  }

  // ── Preview slide-over ──────────────────────────────────────────────────────

  function _openPreview(f) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute;inset:0;z-index:40;display:flex;justify-content:flex-end";
    overlay.innerHTML = `
      <div class="fv-backdrop" style="position:absolute;inset:0;background:rgba(20,16,10,.28)"></div>
      <div style="position:relative;width:min(520px,90%);background:var(--color-card);height:100%;
        box-shadow:-4px 0 18px rgba(0,0,0,.12);display:flex;flex-direction:column">
        <div style="padding:14px 18px;border-bottom:1px dashed var(--color-cream-line);flex-shrink:0">
          <div style="display:flex;align-items:start;justify-content:space-between;gap:10px">
            <div style="min-width:0">
              <div style="font-family:var(--font-mono);font-size:13px;color:var(--color-ink);
                overflow:hidden;text-overflow:ellipsis" title="${_esc(f.path)}">${fileIcon(f.mime_type, f.filename)} ${_esc(f.filename)}</div>
              <div style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint);margin-top:3px">
                ${_esc(f.swarm_display_name || f.swarm_name || "")} · ${fmtBytes(f.size_bytes)} · ${_esc(f.origin)}${
                  f.link_source ? ` · ↗ linked from ${_esc(f.link_source.swarm_display_name || f.link_source.swarm_name)}/${_esc(f.link_source.path)}` : ""}
              </div>
            </div>
            <button class="fv-act" data-close style="font-size:18px">✕</button>
          </div>
        </div>
        <div class="fv-preview-body" style="flex:1;overflow:auto;background:var(--color-panel)"></div>
        <div style="padding:10px 18px;border-top:1px dashed var(--color-cream-line);flex-shrink:0;
          display:flex;gap:8px;justify-content:flex-end">
          ${f.created_by_run_id ? `<button class="btn btn-ghost btn-sm" data-run style="margin:0">Open run</button>` : ""}
          <button class="btn btn-primary btn-sm" data-dl style="margin:0">Download</button>
        </div>
      </div>`;
    container.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector(".fv-backdrop").addEventListener("click", close);
    overlay.querySelector("[data-close]").addEventListener("click", close);
    overlay.querySelector("[data-dl]").addEventListener("click", () => {
      window.location.href = api.downloadSwarmFileUrl(f.swarm_id, f.path);
    });
    overlay.querySelector("[data-run]")?.addEventListener("click", () => {
      close(); window.swNav(`runs/${f.created_by_run_id}`);
    });

    fillFilePreview(overlay.querySelector(".fv-preview-body"), f);
  }

  // ── Link picker ─────────────────────────────────────────────────────────────

  async function _openLinkPicker(f) {
    const source = f.is_link && f.link_source ? f.link_source.path : f.path;
    const { close, body } = _modal(`
      <div style="font-family:var(--font-display);font-size:16px;margin-bottom:4px">Link file into a swarm</div>
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint);margin-bottom:14px">
        ${fileIcon(f.mime_type, f.filename)} ${_esc(source)} — the bytes stay where they are; the target swarm gets a reference.</div>
      <label class="form-label">Target swarm</label>
      <select class="form-select fv-link-swarm" style="width:100%;margin-bottom:12px"><option value="">Loading…</option></select>
      <label class="form-label">Path in target (optional)</label>
      <input class="fv-link-path" type="text" value="${_esc(f.filename)}"
        style="width:100%;font-family:var(--font-mono);font-size:12px;padding:7px 9px;
        border:1px solid var(--color-cream-line);border-radius:5px;background:var(--color-card);margin-bottom:16px">
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost btn-sm fv-cancel" style="margin:0">Cancel</button>
        <button class="btn btn-primary btn-sm fv-confirm" style="margin:0">Create link</button>
      </div>`);

    const swarmSel = body.querySelector(".fv-link-swarm");
    await _fillSwarmOptions(swarmSel, f.swarm_id);
    body.querySelector(".fv-cancel").addEventListener("click", close);
    body.querySelector(".fv-confirm").addEventListener("click", async () => {
      const targetSwarmId = swarmSel.value;
      const path = body.querySelector(".fv-link-path").value.trim();
      if (!targetSwarmId) { toastError("Pick a target swarm"); return; }
      try {
        await api.linkSwarmFile(targetSwarmId, { source_file_id: f.id, path: path || undefined });
        toastSuccess("Link created");
        close();
        reload();
      } catch (err) {
        toastError(err.message || "Could not create link");
      }
    });
  }

  // ── Upload ──────────────────────────────────────────────────────────────────

  const hiddenInput = document.createElement("input");
  hiddenInput.type = "file";
  hiddenInput.multiple = true;
  hiddenInput.style.display = "none";
  container.appendChild(hiddenInput);

  uploadBtn.addEventListener("click", async () => {
    const target = await _resolveUploadTarget();
    if (!target) return;
    hiddenInput.onchange = () => {
      if (hiddenInput.files.length) _uploadFiles(hiddenInput.files, target);
      hiddenInput.value = "";
    };
    hiddenInput.click();
  });

  // Drag-and-drop straight onto the body.
  bodyEl.addEventListener("dragover", (e) => { e.preventDefault(); bodyEl.style.outline = "2px dashed var(--color-accent)"; });
  bodyEl.addEventListener("dragleave", () => { bodyEl.style.outline = ""; });
  bodyEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    bodyEl.style.outline = "";
    if (!e.dataTransfer.files.length) return;
    if (!canDo("can_edit_swarm")) { toastError("You don't have permission to upload"); return; }
    const target = await _resolveUploadTarget();
    if (target) _uploadFiles(e.dataTransfer.files, target);
  });

  // Resolve where an upload should land: the swarm currently scoped in the tree,
  // or — if the scope spans multiple swarms — ask. Returns {swarmId, prefix} or null.
  async function _resolveUploadTarget() {
    if (selected.kind === "swarm" || selected.kind === "folder") {
      return { swarmId: selected.swarmId, prefix: selected.kind === "folder" ? selected.prefix : "" };
    }
    return await _pickUploadTarget();
  }

  function _pickUploadTarget() {
    return new Promise((resolve) => {
      const { close, body } = _modal(`
        <div style="font-family:var(--font-display);font-size:16px;margin-bottom:10px">Upload to which swarm?</div>
        <select class="form-select fv-up-swarm" style="width:100%;margin-bottom:16px"><option value="">Loading…</option></select>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm fv-cancel" style="margin:0">Cancel</button>
          <button class="btn btn-primary btn-sm fv-confirm" style="margin:0">Choose files</button>
        </div>`);
      const sel = body.querySelector(".fv-up-swarm");
      _fillSwarmOptions(sel, null);
      body.querySelector(".fv-cancel").addEventListener("click", () => { close(); resolve(null); });
      body.querySelector(".fv-confirm").addEventListener("click", () => {
        const swarmId = sel.value;
        if (!swarmId) { toastError("Pick a swarm"); return; }
        close();
        resolve({ swarmId, prefix: "" });
      });
    });
  }

  async function _uploadFiles(fileList, target) {
    let ok = 0;
    for (const file of fileList) {
      const path = target.prefix ? `${target.prefix}/${file.name}` : file.name;
      try {
        await api.uploadSwarmFile(target.swarmId, file, path);
        ok++;
      } catch (err) {
        if (err.code === "conflict") {
          if (!confirm(`"${path}" already exists. Overwrite?`)) continue;
          try { await api.uploadSwarmFile(target.swarmId, file, path, true); ok++; }
          catch (e2) { toastError(e2.message || "Upload failed"); }
        } else {
          toastError(err.message || "Upload failed");
        }
      }
    }
    if (ok) { toastSuccess(`Uploaded ${ok} file${ok !== 1 ? "s" : ""}`); reload(); }
  }

  // ── Shared helpers (need view state) ────────────────────────────────────────

  // Populate a <select> with every swarm, grouped by workspace via <optgroup>.
  async function _fillSwarmOptions(selectEl, defaultSwarmId) {
    try {
      const wss = await api.listWorkspaces();
      const lists = await Promise.all(wss.map(w => api.listSwarms(w.id).catch(() => [])));
      selectEl.innerHTML = "";
      wss.forEach((w, i) => {
        const swarms = lists[i];
        if (!swarms.length) return;
        const grp = document.createElement("optgroup");
        grp.label = w.display_name || w.name;
        for (const s of swarms) {
          const opt = document.createElement("option");
          opt.value = s.id;
          opt.textContent = s.display_name || s.name;
          if (s.id === defaultSwarmId) opt.selected = true;
          grp.appendChild(opt);
        }
        selectEl.appendChild(grp);
      });
      if (!selectEl.options.length) selectEl.innerHTML = `<option value="">No swarms</option>`;
    } catch {
      selectEl.innerHTML = `<option value="">Could not load swarms</option>`;
    }
  }

  function _modal(innerHtml) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute;inset:0;z-index:45;display:flex;align-items:center;justify-content:center";
    overlay.innerHTML = `
      <div class="fv-backdrop" style="position:absolute;inset:0;background:rgba(20,16,10,.32)"></div>
      <div style="position:relative;width:min(440px,92%);background:var(--color-card);border-radius:9px;
        padding:20px 22px;box-shadow:0 8px 30px rgba(0,0,0,.18)">${innerHtml}</div>`;
    container.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector(".fv-backdrop").addEventListener("click", close);
    return { close, body: overlay.lastElementChild };
  }

  // Escape closes the top-most overlay.
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    const overlays = container.querySelectorAll('[style*="z-index:4"]');
    if (overlays.length) overlays[overlays.length - 1].remove();
  };
  document.addEventListener("keydown", onKey);

  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(reload, 200);
  });
  wsEl.addEventListener("change", reload);

  reload();

  return () => {
    disposed = true;
    clearTimeout(searchTimer);
    document.removeEventListener("keydown", onKey);
  };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function _linkChips(f) {
  const chips = [];
  if (f.is_link) {
    const src = f.link_source
      ? `linked from ${f.link_source.swarm_display_name || f.link_source.swarm_name}/${f.link_source.path}`
      : "broken link";
    chips.push(`<span class="fv-chip" title="${_esc(src)}"
      style="background:var(--color-cream-line);color:var(--color-ink-soft)">↗ ${f.link_source ? "linked" : "broken"}</span>`);
  }
  if (!f.is_link && f.link_count > 0) {
    chips.push(`<span class="fv-chip" title="Linked into ${f.link_count} other swarm(s)"
      style="background:var(--color-accent);color:#fff">in ${f.link_count + 1}</span>`);
  }
  return chips.join(" ");
}

function _originDot(origin) {
  const c = origin === "agent" ? "var(--color-accent)"
    : origin === "human" ? "var(--color-ink-soft)" : "var(--color-cream-line)";
  return `<span title="${_esc(origin)}" style="display:inline-block;width:8px;height:8px;border-radius:50%;
    background:${c};border:1px solid var(--color-cream-line)"></span>`;
}

function _esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
