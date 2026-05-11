import * as api from "../api.js";
import { toastError, toastSuccess } from "../components/toast.js";

/**
 * Swarm Files view.
 * Route: #files/<swarm_id>
 */
export function renderSwarmFilesView(container, swarmId) {
  container.style.cssText = "overflow:hidden;height:100%;display:flex;flex-direction:column";

  if (!swarmId) {
    container.innerHTML = `
      <div class="empty-state" style="margin:auto">
        <div class="empty-state-title">No swarm selected</div>
        <div class="empty-state-body">Navigate to a swarm and click Files to browse its file store.</div>
      </div>`;
    return () => {};
  }

  container.innerHTML = `
    <div style="
      padding:16px 24px 12px;
      border-bottom:1px dashed var(--color-cream-line);
      background:var(--color-parchment);
      flex-shrink:0;
      display:flex;align-items:center;gap:12px;
    ">
      <div>
        <div id="sf-swarm-name" style="
          font-family:var(--font-display);font-size:18px;
          color:var(--color-ink);letter-spacing:-0.3px;
        ">…</div>
        <div style="
          font-family:var(--font-mono);font-size:10px;
          color:var(--color-ink-soft);letter-spacing:.08em;
          text-transform:uppercase;margin-top:2px;
        ">File Store</div>
      </div>
      <div style="flex:1"></div>
      <label id="sf-upload-btn" class="btn btn-primary btn-sm" style="cursor:pointer;margin:0">
        Upload
        <input id="sf-file-input" type="file" multiple style="display:none">
      </label>
    </div>

    <div style="display:flex;flex:1;overflow:hidden">

      <!-- ── Left: directory tree ── -->
      <div id="sf-tree" style="
        width:200px;flex-shrink:0;
        border-right:1px dashed var(--color-cream-line);
        background:var(--color-panel);
        overflow-y:auto;
        padding:10px 0;
      "></div>

      <!-- ── Right: file table ── -->
      <div style="flex:1;overflow-y:auto;padding:0 0 24px">
        <div id="sf-drop-zone" style="
          margin:16px 24px 0;
          border:2px dashed var(--color-cream-line);
          border-radius:6px;
          padding:18px;
          text-align:center;
          font-family:var(--font-mono);
          font-size:11px;
          color:var(--color-ink-soft);
          letter-spacing:.04em;
          transition:background .15s,border-color .15s;
        ">Drop files here to upload</div>

        <div id="sf-table-wrap" style="margin:12px 24px 0"></div>
      </div>
    </div>`;

  let _files = [];
  let _selectedPrefix = null;
  let _swarmName = "";

  // Load swarm name
  api.getSwarm(swarmId).then(s => {
    _swarmName = s.display_name || s.name;
    document.getElementById("sf-swarm-name").textContent = _swarmName;
  }).catch(() => {});

  async function reload() {
    try {
      _files = await api.listSwarmFiles(swarmId);
      _renderTree();
      _renderTable();
    } catch (err) {
      toastError(err.message || "Could not load files");
    }
  }

  function _renderTree() {
    const tree = document.getElementById("sf-tree");
    const dirs = new Set(["/"]);
    for (const f of _files) {
      const parts = f.path.split("/");
      let acc = "";
      for (let i = 0; i < parts.length - 1; i++) {
        acc += (acc ? "/" : "") + parts[i];
        dirs.add(acc);
      }
    }

    const sorted = [...dirs].sort();
    tree.innerHTML = sorted.map(d => {
      const label = d === "/" ? "/ root" : d;
      const active = _selectedPrefix === (d === "/" ? null : d);
      return `<div class="sf-tree-item${active ? " sf-tree-item-active" : ""}"
        data-prefix="${d === "/" ? "" : d}"
        style="
          padding:5px 14px;
          font-family:var(--font-mono);
          font-size:11px;
          color:${active ? "var(--color-accent)" : "var(--color-ink)"};
          cursor:pointer;
          background:${active ? "var(--color-parchment)" : "transparent"};
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        "
      >${label}</div>`;
    }).join("");

    tree.querySelectorAll(".sf-tree-item").forEach(el => {
      el.addEventListener("click", () => {
        const p = el.dataset.prefix || null;
        _selectedPrefix = p;
        _renderTree();
        _renderTable();
      });
    });
  }

  function _renderTable() {
    const wrap = document.getElementById("sf-table-wrap");
    const visible = _selectedPrefix
      ? _files.filter(f => f.path.startsWith(_selectedPrefix + "/") || f.path === _selectedPrefix)
      : _files;

    if (!visible.length) {
      wrap.innerHTML = `
        <div class="empty-state" style="margin-top:40px">
          <div class="empty-state-title">No files</div>
          <div class="empty-state-body">Upload a file or configure a file-watcher trigger to let agents produce files automatically.</div>
        </div>`;
      return;
    }

    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="border-bottom:1px solid var(--color-cream-line)">
            <th style="text-align:left;padding:8px 12px;font-family:var(--font-mono);font-size:10px;color:var(--color-ink-soft);letter-spacing:.06em;text-transform:uppercase;font-weight:600">File</th>
            <th style="text-align:left;padding:8px 12px;font-family:var(--font-mono);font-size:10px;color:var(--color-ink-soft);letter-spacing:.06em;text-transform:uppercase;font-weight:600">Size</th>
            <th style="text-align:left;padding:8px 12px;font-family:var(--font-mono);font-size:10px;color:var(--color-ink-soft);letter-spacing:.06em;text-transform:uppercase;font-weight:600">Origin</th>
            <th style="text-align:left;padding:8px 12px;font-family:var(--font-mono);font-size:10px;color:var(--color-ink-soft);letter-spacing:.06em;text-transform:uppercase;font-weight:600">Updated</th>
            <th style="text-align:left;padding:8px 12px;font-family:var(--font-mono);font-size:10px;color:var(--color-ink-soft);letter-spacing:.06em;text-transform:uppercase;font-weight:600">Run</th>
            <th style="width:64px"></th>
          </tr>
        </thead>
        <tbody>
          ${visible.map(f => _fileRow(f)).join("")}
        </tbody>
      </table>`;

    wrap.querySelectorAll("[data-delete]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const path = btn.dataset.delete;
        if (!confirm(`Delete "${path}"?`)) return;
        try {
          await api.deleteSwarmFile(swarmId, path);
          toastSuccess("Deleted");
          reload();
        } catch (err) {
          toastError(err.message || "Delete failed");
        }
      });
    });

    wrap.querySelectorAll("[data-download]").forEach(btn => {
      btn.addEventListener("click", () => {
        const path = btn.dataset.download;
        window.location.href = api.downloadSwarmFileUrl(swarmId, path);
      });
    });
  }

  function _fileRow(f) {
    const originBadge = f.origin === "agent"
      ? `<span style="background:var(--color-accent);color:#fff;border-radius:3px;padding:1px 6px;font-size:10px;font-family:var(--font-mono)">agent</span>`
      : f.origin === "human"
        ? `<span style="background:var(--color-ink-soft);color:#fff;border-radius:3px;padding:1px 6px;font-size:10px;font-family:var(--font-mono)">human</span>`
        : `<span style="background:var(--color-cream-line);color:var(--color-ink-soft);border-radius:3px;padding:1px 6px;font-size:10px;font-family:var(--font-mono)">unknown</span>`;

    const runLink = f.created_by_run_id
      ? `<a href="#" onclick="swNav('runs/${f.created_by_run_id}');return false"
           style="font-family:var(--font-mono);font-size:11px;color:var(--color-accent);text-decoration:none"
         >${f.created_by_run_id.slice(0, 8)}…</a>`
      : `<span style="color:var(--color-ink-soft);font-size:11px">—</span>`;

    const updated = f.updated_at
      ? new Date(f.updated_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
      : "—";

    const size = _fmtBytes(f.size_bytes);

    return `<tr style="border-bottom:1px dashed var(--color-cream-line);transition:background .1s" onmouseover="this.style.background='var(--color-parchment)'" onmouseout="this.style.background=''">
      <td style="padding:9px 12px;font-family:var(--font-mono);font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(f.path)}">${_esc(f.path)}</td>
      <td style="padding:9px 12px;font-family:var(--font-mono);font-size:12px;white-space:nowrap;color:var(--color-ink-soft)">${size}</td>
      <td style="padding:9px 12px">${originBadge}</td>
      <td style="padding:9px 12px;font-family:var(--font-mono);font-size:11px;color:var(--color-ink-soft);white-space:nowrap">${updated}</td>
      <td style="padding:9px 12px">${runLink}</td>
      <td style="padding:9px 8px;white-space:nowrap">
        <button class="btn btn-ghost btn-sm" data-download="${_esc(f.path)}" title="Download" style="padding:3px 7px;margin-right:4px">↓</button>
        <button class="btn btn-ghost btn-sm" data-delete="${_esc(f.path)}" title="Delete" style="padding:3px 7px;color:var(--color-danger,#c0392b)">✕</button>
      </td>
    </tr>`;
  }

  // ── Upload ──────────────────────────────────────────────────────────────────

  async function _uploadFiles(fileList) {
    for (const file of fileList) {
      const path = _selectedPrefix ? `${_selectedPrefix}/${file.name}` : file.name;
      try {
        await api.uploadSwarmFile(swarmId, file, path);
      } catch (err) {
        if (err.code === "conflict") {
          if (!confirm(`"${path}" already exists. Overwrite?`)) continue;
          try {
            await api.uploadSwarmFile(swarmId, file, path, true);
          } catch (e2) {
            toastError(e2.message || "Upload failed");
            continue;
          }
        } else {
          toastError(err.message || "Upload failed");
          continue;
        }
      }
    }
    toastSuccess(`Uploaded ${fileList.length} file${fileList.length > 1 ? "s" : ""}`);
    reload();
  }

  // File input trigger
  const fileInput = document.getElementById("sf-file-input");
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) _uploadFiles(fileInput.files);
    fileInput.value = "";
  });

  // Drag-and-drop
  const dropZone = document.getElementById("sf-drop-zone");
  dropZone.addEventListener("dragover", e => {
    e.preventDefault();
    dropZone.style.background = "var(--color-parchment)";
    dropZone.style.borderColor = "var(--color-accent)";
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.style.background = "";
    dropZone.style.borderColor = "";
  });
  dropZone.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.style.background = "";
    dropZone.style.borderColor = "";
    const files = e.dataTransfer.files;
    if (files.length) _uploadFiles(files);
  });

  reload();
  return () => {};
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _fmtBytes(n) {
  if (n === 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function _esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
