/**
 * mobile-files.js — read-only file browser for the mobile shell.
 *
 * The desktop Files page (views/files.js) is a full org-wide browser with a
 * folder tree, upload, and cross-swarm linking. On a phone we only "consume":
 * a search box + a list grouped by swarm, tapping a file opens a full-screen
 * preview that reuses the shared renderer (markdown / CSV / code / image / PDF).
 *
 * Gated on `can_read_files`; never exposes write/edit endpoints.
 */
import * as api from "../api.js";
import { toastError } from "../components/toast.js";
import { fillFilePreview, fileIcon, fmtBytes } from "../components/file-preview.js";

export function renderMobileFilesView(container) {
  container.classList.add("mfiles");
  container.innerHTML = `
    <div class="mfiles-searchbar">
      <input class="mfiles-search" type="search" placeholder="Search files…" autocomplete="off">
    </div>
    <div class="mfiles-list"><div class="mfiles-hint">Loading…</div></div>`;

  const searchEl = container.querySelector(".mfiles-search");
  const listEl   = container.querySelector(".mfiles-list");
  let disposed = false;
  let searchTimer = null;
  let previewEl = null;

  async function reload() {
    const q = searchEl.value.trim();
    listEl.innerHTML = `<div class="mfiles-hint">Loading…</div>`;
    try {
      const resp = await api.listAllFiles(q ? { search: q } : {});
      if (disposed) return;
      _renderList(resp.rows || []);
    } catch (_) {
      if (disposed) return;
      toastError("Could not load files");
      listEl.innerHTML = `<div class="mfiles-hint mfiles-hint--err">Failed to load files.</div>`;
    }
  }

  function _renderList(rows) {
    if (!rows.length) {
      listEl.innerHTML = `<div class="mfiles-hint">No files found.</div>`;
      return;
    }
    // Group by swarm, preserving server order (most recent first).
    const groups = new Map();
    for (const f of rows) {
      const key = f.swarm_id;
      if (!groups.has(key)) {
        groups.set(key, { label: f.swarm_display_name || f.swarm_name || "Swarm", files: [] });
      }
      groups.get(key).files.push(f);
    }

    const html = [];
    for (const { label, files } of groups.values()) {
      html.push(`<div class="mfiles-group">${_esc(label)}</div>`);
      for (const f of files) {
        html.push(`<button class="mfiles-row" data-id="${_esc(f.id)}">
          <span class="mfiles-row-icon">${fileIcon(f.mime_type, f.filename)}</span>
          <span class="mfiles-row-main">
            <span class="mfiles-row-name">${_esc(f.filename)}</span>
            <span class="mfiles-row-meta">${fmtBytes(f.size_bytes)}${f.is_link ? " · ↗ linked" : ""}</span>
          </span>
          <span class="mfiles-row-chev">›</span>
        </button>`);
      }
    }
    listEl.innerHTML = html.join("");

    const byId = new Map(rows.map(f => [String(f.id), f]));
    listEl.querySelectorAll(".mfiles-row").forEach(row => {
      row.addEventListener("click", () => {
        const f = byId.get(row.dataset.id);
        if (f) _openPreview(f);
      });
    });
  }

  function _openPreview(f) {
    _closePreview();
    const el = document.createElement("div");
    el.className = "mfiles-preview";
    el.innerHTML = `
      <div class="mfiles-preview-head">
        <button class="mfiles-preview-back" title="Back">‹ Files</button>
        <span class="mfiles-preview-name" title="${_esc(f.path)}">${fileIcon(f.mime_type, f.filename)} ${_esc(f.filename)}</span>
        <a class="mfiles-preview-dl" href="${api.downloadSwarmFileUrl(f.swarm_id, f.path)}" title="Download" download>⬇</a>
      </div>
      <div class="mfiles-preview-sub">${_esc(f.swarm_display_name || f.swarm_name || "")} · ${fmtBytes(f.size_bytes)}</div>
      <div class="mfiles-preview-body"></div>`;
    document.body.appendChild(el);
    previewEl = el;
    el.querySelector(".mfiles-preview-back").addEventListener("click", _closePreview);
    fillFilePreview(el.querySelector(".mfiles-preview-body"), f);
  }

  function _closePreview() {
    previewEl?.remove();
    previewEl = null;
  }

  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(reload, 220);
  });

  reload();

  return () => {
    disposed = true;
    clearTimeout(searchTimer);
    _closePreview();
  };
}

function _esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
