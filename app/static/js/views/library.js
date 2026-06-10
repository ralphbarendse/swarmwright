import * as api from "../api.js";
import { toastError, toastSuccess } from "../components/toast.js";
import { canDo } from "../auth.js";
import { renderMarkdown } from "../components/markdown.js";
import { icon } from "../icons.js";

/**
 * Library view — skills and knowledge across scopes.
 *
 * Routes:
 *   library                       → knowledge, company scope
 *   library/knowledge             → knowledge, company scope
 *   library/knowledge/<wsId>      → knowledge, workspace scope
 *   library/skills                → skills, company scope
 *   library/skills/builtin        → skills, builtin scope (read-only)
 *   library/skills/ws/<wsId>      → skills, workspace scope
 *   library/skills/sw/<swarmId>   → skills, swarm scope
 */
export function renderLibraryView(container, segments = []) {
  container.style.overflowY = "hidden";
  container.style.height = "100%";

  const tab = segments[0] || "knowledge";

  let scope = "company", workspaceId = null, swarmId = null;
  if (tab === "knowledge") {
    if (segments[1]) { scope = "workspace"; workspaceId = segments[1]; }
  } else if (tab === "skills") {
    if (segments[1] === "builtin")               { scope = "builtin"; }
    else if (segments[1] === "ws" && segments[2])      { scope = "workspace"; workspaceId = segments[2]; }
    else if (segments[1] === "sw" && segments[2]) { scope = "swarm";     swarmId     = segments[2]; }
  }

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden">
      <div class="crumbs" style="flex-shrink:0">
        <span class="crumb-link" onclick="swNav('org')">Workspaces</span>
        <span class="crumb-sep">›</span>
        <span class="crumb-here">Library</span>
      </div>
      <div class="page-header" style="flex-shrink:0">
        <div class="page-title">Library</div>
        <div class="page-sub">Skills and knowledge across all scopes</div>
      </div>
      <div style="display:flex;gap:0;border-bottom:1px dashed var(--color-cream-line);padding:0 24px;flex-shrink:0">
        <button class="topbar-tab ${tab === "knowledge" ? "active" : ""}" id="tab-knowledge" style="font-size:13px;padding:8px 16px">Knowledge</button>
        <button class="topbar-tab ${tab === "skills" ? "active" : ""}" id="tab-skills" style="font-size:13px;padding:8px 16px">Skills</button>
      </div>
      <div style="display:flex;flex:1;overflow:hidden">
        <div style="width:220px;border-right:1px dashed var(--color-cream-line);overflow-y:auto;padding:16px 12px;flex-shrink:0;background:var(--color-panel)">
          <div class="sec-header">Scope</div>
          <div id="scope-nav"></div>
        </div>
        <div style="flex:1;overflow-y:auto;padding:20px 24px">
          <div id="lib-content"></div>
        </div>
      </div>
    </div>`;

  container.querySelector("#tab-knowledge").addEventListener("click",
    () => window.swNav("library/knowledge" + (scope === "workspace" ? "/" + workspaceId : "")));
  container.querySelector("#tab-skills").addEventListener("click",
    () => window.swNav("library/skills"));

  _buildScopeNav(container, tab, { scope, workspaceId, swarmId });

  if (tab === "knowledge") {
    _renderKnowledge(container, scope === "workspace" ? workspaceId : null);
  } else {
    _renderSkills(container, { scope, workspaceId, swarmId });
  }

  return null;
}

// ── Scope nav ──────────────────────────────────────────────────────────────

async function _buildScopeNav(container, tab, active) {
  const nav = container.querySelector("#scope-nav");

  const baseStyle = "padding:6px 10px;border-radius:6px;cursor:pointer;font-family:var(--font-mono);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid transparent;margin-bottom:2px";
  const activeStyle = "background:rgba(201,124,42,.12);border-color:rgba(201,124,42,.35);color:var(--color-perceptionist)";

  const mkItem = (label, isActive, onClick, opts = {}) => {
    const el = document.createElement("div");
    el.textContent = label;
    el.style.cssText = baseStyle + (isActive ? ";" + activeStyle : "");
    if (opts.indent) el.style.paddingLeft = (10 + 12 * opts.indent) + "px";
    el.title = label;
    el.addEventListener("click", onClick);
    nav.appendChild(el);
    return el;
  };

  if (tab === "skills") {
    mkItem("Built-in", active.scope === "builtin",
      () => window.swNav("library/skills/builtin"));
  }

  mkItem("Company", active.scope === "company",
    () => window.swNav(`library/${tab}`));

  try {
    const workspaces = await api.listWorkspaces();
    if (!workspaces.length) return;

    const hdr = document.createElement("div");
    hdr.textContent = "Workspaces";
    hdr.className = "sec-header";
    hdr.style.cssText = "margin:14px 0 6px 4px";
    nav.appendChild(hdr);

    let detailed = workspaces;
    if (tab === "skills") {
      detailed = await Promise.all(workspaces.map(ws =>
        api.getWorkspace(ws.id).catch(() => ws)
      ));
    }

    for (const ws of detailed) {
      const wsActive = active.scope === "workspace" && active.workspaceId === ws.id;
      mkItem(ws.display_name, wsActive,
        () => window.swNav(tab === "skills" ? `library/skills/ws/${ws.id}` : `library/knowledge/${ws.id}`));

      if (tab === "skills" && (ws.swarms || []).length) {
        for (const sw of ws.swarms) {
          const swActive = active.scope === "swarm" && active.swarmId === sw.id;
          mkItem("↳ " + sw.display_name, swActive,
            () => window.swNav(`library/skills/sw/${sw.id}`),
            { indent: 1 });
        }
      }
    }
  } catch (_) {}
}

// ── Knowledge ──────────────────────────────────────────────────────────────

async function _renderKnowledge(container, wsId) {
  const content = container.querySelector("#lib-content");
  content.innerHTML = "";

  const scopeParams = wsId ? { scope: "workspace", workspace_id: wsId } : { scope: "company" };
  const reload = () => _renderKnowledge(container, wsId);

  const headerRow = document.createElement("div");
  headerRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:12px";
  headerRow.innerHTML = `
    <div class="sec-header" style="margin:0">Knowledge documents</div>
    ${canDo("can_manage_knowledge") ? `<button class="btn btn-primary btn-sm" id="btn-new-doc">+ New document</button>` : ""}`;
  content.appendChild(headerRow);

  const filterRow = document.createElement("div");
  filterRow.style.cssText = "margin-bottom:14px";
  filterRow.innerHTML = `<input class="form-input" id="kn-filter" placeholder="Filter documents…" style="font-size:12px;max-width:320px">`;
  content.appendChild(filterRow);

  const grid = document.createElement("div");
  grid.id = "kn-grid";
  content.appendChild(grid);

  content.querySelector("#btn-new-doc")?.addEventListener("click", () =>
    _openKnowledgeEditor({ isNew: true, scopeParams, onDone: reload }));

  content.querySelector("#kn-filter").addEventListener("input", e =>
    _filterCards(grid, e.target.value, "[data-kn-card]", "kn-no-match"));

  try {
    const docs = await api.listKnowledge(scopeParams);
    _renderKnowledgeGrid(grid, docs, reload, scopeParams);
  } catch (err) { toastError(err); }
}

function _renderKnowledgeGrid(grid, docs, reload, scopeParams) {
  grid.innerHTML = "";

  if (!docs.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-state-icon" style="color:var(--color-ink-faint)">${icon("file-text", { size: 30 })}</div><div class="empty-state-title">No documents</div><div class="empty-state-sub">Create a knowledge document to get started.</div></div>`;
    return;
  }

  docs.forEach(doc => {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.knCard = "1";
    card.dataset.knSearch = `${doc.title || ""} ${doc.name}`.toLowerCase();
    card.style.cssText = "margin-bottom:8px;display:flex;align-items:flex-start;gap:12px;padding:12px 16px;cursor:pointer";

    const age = doc.updated_at ? ` · ${_fmtAge(doc.updated_at)}` : "";
    const preview = doc.content_preview
      ? `<div style="font-size:11px;color:var(--color-ink-faint);margin-top:5px;font-style:italic;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${_esc(doc.content_preview)}</div>`
      : "";

    card.innerHTML = `
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;font-size:13px">${_esc(doc.title || doc.name)}</div>
        <div style="font-size:11px;color:var(--color-text-muted);margin-top:2px">${_esc(doc.name)}.md · ${_fmtBytes(doc.size_bytes)}${age}</div>
        ${preview}
      </div>
      ${canDo("can_manage_knowledge") ? `<div style="display:flex;gap:6px;flex-shrink:0;align-self:flex-start;margin-top:1px">
        <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
        <button class="btn btn-ghost btn-sm" data-action="transfer">Transfer</button>
        <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
      </div>` : ""}`;

    // Hover preview popover
    if (doc.content_preview) {
      let _tip = null;
      card.addEventListener("mouseenter", e => {
        _tip = document.createElement("div");
        _tip.style.cssText = `
          position:fixed;z-index:9999;
          max-width:360px;padding:12px 14px;
          background:var(--color-surface);border:1px solid var(--color-cream-line);
          border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.14);
          font-family:var(--font-mono);font-size:11px;line-height:1.6;
          color:var(--color-ink-soft);white-space:pre-wrap;word-break:break-word;
          pointer-events:none;
        `;
        _tip.textContent = doc.content_preview;
        document.body.appendChild(_tip);
        const r = card.getBoundingClientRect();
        const tipH = 160;
        const top = r.bottom + 6 + tipH > window.innerHeight ? r.top - tipH - 6 : r.bottom + 6;
        _tip.style.top  = top + "px";
        _tip.style.left = Math.min(r.left, window.innerWidth - 376) + "px";
      });
      card.addEventListener("mouseleave", () => { _tip?.remove(); _tip = null; });
    }

    const openEditor = () => _openKnowledgeEditor({ doc, isNew: false, scopeParams, onDone: reload });
    card.addEventListener("click", openEditor);
    card.querySelector("[data-action=edit]")?.addEventListener("click", e => { e.stopPropagation(); openEditor(); });
    card.querySelector("[data-action=transfer]")?.addEventListener("click", e => {
      e.stopPropagation();
      _showKnowledgeTransferModal(doc, reload);
    });
    card.querySelector("[data-action=delete]")?.addEventListener("click", async e => {
      e.stopPropagation();
      if (!confirm(`Delete "${doc.title || doc.name}"?`)) return;
      try {
        await api.deleteKnowledge(doc.id);
        toastSuccess("Deleted");
        reload();
      } catch (err) { toastError(err); }
    });

    grid.appendChild(card);
  });

  const noMatch = document.createElement("div");
  noMatch.id = "kn-no-match";
  noMatch.style.display = "none";
  noMatch.innerHTML = `<div class="empty-state"><div class="empty-state-title">No matching documents</div></div>`;
  grid.appendChild(noMatch);
}

// ── Knowledge inline editor ────────────────────────────────────────────────

async function _openKnowledgeEditor({ doc, isNew, scopeParams, onDone }) {
  const root = document.querySelector("#lib-content");
  if (!root) return;

  let loadedDoc = doc;
  if (!isNew && doc && doc.content === undefined) {
    try {
      loadedDoc = await api.getKnowledge(doc.id);
    } catch (err) { toastError(err); return; }
  }

  const startName    = loadedDoc?.name  || "";
  const startTitle   = loadedDoc?.title || "";
  const startContent = loadedDoc?.content || "";

  root.innerHTML = `
    <style>
      #kn-preview-pane h1,#kn-preview-pane h2,#kn-preview-pane h3{color:var(--color-ink);font-weight:600;margin:1.2em 0 .4em}
      #kn-preview-pane h1{font-size:1.35em}#kn-preview-pane h2{font-size:1.15em}#kn-preview-pane h3{font-size:1.05em}
      #kn-preview-pane p{margin:.55em 0}
      #kn-preview-pane ul,#kn-preview-pane ol{padding-left:1.6em;margin:.5em 0}
      #kn-preview-pane li{margin:.2em 0}
      #kn-preview-pane code{font-family:var(--font-mono);font-size:.875em;background:var(--color-cream-deep);padding:1px 5px;border-radius:3px}
      #kn-preview-pane pre{background:var(--color-cream-deep);padding:12px 16px;border-radius:6px;overflow-x:auto;margin:.9em 0}
      #kn-preview-pane pre code{background:none;padding:0}
      #kn-preview-pane blockquote{border-left:3px solid var(--color-cream-line);padding-left:12px;color:var(--color-ink-soft);margin:.8em 0}
      #kn-preview-pane a{color:var(--color-perceptionist);text-decoration:underline}
      #kn-preview-pane hr{border:none;border-top:1px dashed var(--color-cream-line);margin:1.1em 0}
      #kn-preview-pane table{border-collapse:collapse;width:100%;margin:.9em 0}
      #kn-preview-pane th,#kn-preview-pane td{border:1px solid var(--color-cream-line);padding:6px 10px;font-size:12px}
      #kn-preview-pane th{background:var(--color-cream-deep)}
    </style>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px">
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" id="btn-back">‹ Back</button>
        <div class="page-title" style="font-size:18px">${isNew ? "New document" : _esc(startTitle || startName)}</div>
      </div>
      ${canDo("can_manage_knowledge") ? `<div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" id="btn-ai-draft">Draft with AI</button>
        <button class="btn btn-primary btn-sm" id="btn-save">Save  ⌘S</button>
      </div>` : ""}
    </div>

    <div id="kn-ai-row" style="display:none;margin-bottom:12px">
      <div style="display:flex;gap:8px;align-items:center">
        <input class="form-input" id="kn-ai-prompt" placeholder="Describe what this document should contain…" style="font-size:12px;flex:1">
        <button class="btn btn-primary btn-sm" id="btn-kn-ai-go" style="white-space:nowrap">Generate</button>
      </div>
    </div>

    ${isNew ? `
    <div class="form-group">
      <label class="form-label">Name <span style="font-size:10px;color:var(--color-text-muted)">(filename slug — no spaces)</span></label>
      <input class="form-input" id="kn-name" placeholder="e.g. invoice-policy" style="max-width:340px">
    </div>` : ""}

    <div class="form-group" style="margin-bottom:10px">
      <label class="form-label">Title</label>
      <input class="form-input" id="kn-title" value="${_esc(startTitle)}" placeholder="Human-readable title" style="max-width:480px">
    </div>

    <div style="display:flex;align-items:center;gap:0;margin-bottom:8px;border-bottom:1px solid var(--color-cream-line)">
      <button class="topbar-tab active" id="kn-tab-write" style="font-size:12px;padding:6px 14px">Write</button>
      <button class="topbar-tab" id="kn-tab-preview" style="font-size:12px;padding:6px 14px">Preview</button>
    </div>

    <div id="kn-write-pane" style="border:1px solid var(--color-cream-line);border-radius:6px;overflow:hidden;background:var(--color-card);height:calc(100vh - ${isNew ? "430px" : "370px"});min-height:260px">
      <textarea id="kn-textarea"></textarea>
    </div>

    <div id="kn-preview-pane" style="display:none;border:1px solid var(--color-cream-line);border-radius:6px;padding:20px 24px;overflow-y:auto;background:var(--color-card);height:calc(100vh - ${isNew ? "430px" : "370px"});min-height:260px;font-size:13px;line-height:1.7;color:var(--color-ink)">
    </div>`;

  // CodeMirror
  let editor = null;
  const textarea = document.getElementById("kn-textarea");
  if (typeof CodeMirror !== "undefined") {
    editor = CodeMirror.fromTextArea(textarea, {
      mode: "markdown",
      theme: "default",
      lineNumbers: true,
      lineWrapping: true,
      indentUnit: 2,
      tabSize: 2,
    });
    editor.setValue(startContent);
    editor.setSize("100%", "100%");
    setTimeout(() => editor.refresh(), 50);
  } else {
    textarea.value = startContent;
    textarea.style.cssText = "width:100%;height:100%;padding:12px;font-family:var(--font-mono);font-size:12px;border:none;resize:none;background:transparent";
  }

  const getContent = () => editor ? editor.getValue() : (textarea?.value || "");

  // Write / Preview toggle
  const writePaneEl   = document.getElementById("kn-write-pane");
  const previewPaneEl = document.getElementById("kn-preview-pane");
  const tabWrite      = document.getElementById("kn-tab-write");
  const tabPreview    = document.getElementById("kn-tab-preview");

  tabWrite.addEventListener("click", () => {
    writePaneEl.style.display = "";
    previewPaneEl.style.display = "none";
    tabWrite.classList.add("active");
    tabPreview.classList.remove("active");
    setTimeout(() => editor?.refresh(), 30);
  });

  tabPreview.addEventListener("click", () => {
    previewPaneEl.innerHTML = renderMarkdown(getContent());
    writePaneEl.style.display = "none";
    previewPaneEl.style.display = "";
    tabWrite.classList.remove("active");
    tabPreview.classList.add("active");
  });

  // Draft with AI
  let currentDoc = isNew ? null : loadedDoc;

  const ensureCreated = async () => {
    if (currentDoc) return currentDoc;
    const name = document.getElementById("kn-name")?.value.trim();
    if (!name) { toastError({ message: "Enter a name before drafting" }); return null; }
    const title = document.getElementById("kn-title")?.value.trim() || null;
    try {
      currentDoc = await api.createKnowledge({ ...scopeParams, name, title, content: getContent() });
      return currentDoc;
    } catch (err) { toastError(err); return null; }
  };

  const aiDraftBtn = document.getElementById("btn-ai-draft");
  const aiRow      = document.getElementById("kn-ai-row");
  const aiPrompt   = document.getElementById("kn-ai-prompt");
  const aiGo       = document.getElementById("btn-kn-ai-go");

  aiDraftBtn?.addEventListener("click", () => {
    const visible = aiRow.style.display !== "none";
    aiRow.style.display = visible ? "none" : "flex";
    aiRow.style.flexDirection = "column";
    if (!visible) aiPrompt?.focus();
  });

  const runDraft = async () => {
    const d = await ensureCreated();
    if (!d) return;
    const prompt = aiPrompt?.value.trim() || "";
    aiGo.disabled = true;
    aiGo.textContent = "Generating…";
    try {
      const result = await api.draftKnowledge(d.id, prompt);
      if (editor) editor.setValue(result.content || "");
      else if (textarea) textarea.value = result.content || "";
      aiRow.style.display = "none";
    } catch (err) {
      toastError(err);
    } finally {
      aiGo.disabled = false;
      aiGo.textContent = "Generate";
    }
  };

  aiGo.addEventListener("click", runDraft);
  aiPrompt.addEventListener("keydown", e => { if (e.key === "Enter") runDraft(); });

  // Back
  document.getElementById("btn-back").addEventListener("click", () => onDone && onDone());

  // Save
  const save = async () => {
    const title   = document.getElementById("kn-title")?.value.trim() || null;
    const content = getContent();

    if (!currentDoc) {
      const name = document.getElementById("kn-name")?.value.trim();
      if (!name) { toastError({ message: "Name is required" }); return; }
      try {
        await api.createKnowledge({ ...scopeParams, name, title, content });
        toastSuccess("Created");
        onDone?.();
      } catch (err) { toastError(err); }
    } else {
      try {
        await api.updateKnowledge(currentDoc.id, { title, content });
        toastSuccess("Saved");
        onDone?.();
      } catch (err) { toastError(err); }
    }
  };

  document.getElementById("btn-save")?.addEventListener("click", save);

  if (canDo("can_manage_knowledge")) {
    const kbd = e => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
    };
    document.addEventListener("keydown", kbd);
    setTimeout(() => {
      if (!document.getElementById("btn-save")) document.removeEventListener("keydown", kbd);
    }, 1000);
  }

  if (isNew) setTimeout(() => document.getElementById("kn-name")?.focus(), 50);
}

// ── Skills ─────────────────────────────────────────────────────────────────

const _scopeParams = (s) => {
  const p = { scope: s.scope };
  if (s.workspaceId) p.workspace_id = s.workspaceId;
  if (s.swarmId)     p.swarm_id     = s.swarmId;
  return p;
};

const _scopeLabel = (s) =>
  s.scope === "builtin"    ? "Built-in"
  : s.scope === "company"  ? "Company"
  : s.scope === "workspace" ? "Workspace"
  : "Swarm";

async function _renderSkills(container, scopeSel) {
  const content = container.querySelector("#lib-content");
  content.innerHTML = "";

  const reload = () => _renderSkills(container, scopeSel);

  const isBuiltin = scopeSel.scope === "builtin";

  const headerRow = document.createElement("div");
  headerRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:12px";
  headerRow.innerHTML = `
    <div>
      <div class="sec-header" style="margin:0">Skills · ${_scopeLabel(scopeSel)}</div>
      <div style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono);margin-top:4px">
        ${isBuiltin ? "Platform built-in skills. Read-only — override by creating a skill with the same name at any scope." : "Sandboxed Python scripts. Resolved most-local-first: swarm → workspace → company."}
      </div>
    </div>
    ${isBuiltin || !canDo("can_manage_skills") ? "" : `<button class="btn btn-primary btn-sm" id="btn-new-skill">+ New skill</button>`}`;
  content.appendChild(headerRow);

  const filterRow = document.createElement("div");
  filterRow.style.cssText = "margin-bottom:14px";
  filterRow.innerHTML = `<input class="form-input" id="sk-filter" placeholder="Filter skills…" style="font-size:12px;max-width:320px">`;
  content.appendChild(filterRow);

  const grid = document.createElement("div");
  grid.id = "sk-grid";
  content.appendChild(grid);

  if (!isBuiltin) {
    content.querySelector("#btn-new-skill").addEventListener("click", () =>
      _openSkillEditor({ scopeSel, skillName: undefined, isNew: true, onDone: reload }));
  }

  content.querySelector("#sk-filter").addEventListener("input", e =>
    _filterCards(grid, e.target.value, "[data-sk-card]", "sk-no-match"));

  try {
    const skills = await api.listSkills(_scopeParams(scopeSel));
    if (!skills.length) {
      grid.innerHTML = `<div class="empty-state"><div class="empty-state-icon" style="color:var(--color-ink-faint)">${icon("settings", { size: 30 })}</div><div class="empty-state-title">No skills at this scope</div><div class="empty-state-sub">Click "+ New skill" to create one. The editor opens with a working stub you can edit.</div></div>`;
      return;
    }

    skills.forEach(skill => {
      const card = document.createElement("div");
      card.className = "card";
      card.dataset.skCard = "1";
      card.dataset.skSearch = `${skill.name} ${skill.description || ""}`.toLowerCase();
      card.style.cssText = "margin-bottom:8px;display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer";

      const age = skill.updated_at ? ` · ${_fmtAge(skill.updated_at)}` : "";
      card.innerHTML = `
        <div class="card-icon card-icon-perceptionist" style="width:32px;height:32px;display:flex;align-items:center;justify-content:center">${icon("settings", { size: 16 })}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;font-family:var(--font-mono);color:var(--color-ink)">${_esc(skill.name)}</div>
          <div style="font-size:11px;color:var(--color-ink-soft);margin-top:2px">${_esc(skill.description || "No description")} · timeout ${skill.timeout_seconds ?? 30}s${age}</div>
          ${(skill.allowed_packages || []).length ? `<div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">${skill.allowed_packages.map(p => `<span class="chip" style="font-size:10px">${_esc(p)}</span>`).join("")}</div>` : ""}
        </div>
        ${isBuiltin
          ? `<span class="chip" style="font-size:10px;opacity:.7">built-in</span>`
          : canDo("can_manage_skills")
            ? `<button class="btn btn-secondary btn-sm" data-action="edit">Edit</button>
               <button class="btn btn-ghost btn-sm" data-action="transfer">Transfer</button>
               <button class="btn btn-ghost btn-sm" data-action="delete">Delete</button>`
            : ""}`;

      const openEditor = () => _openSkillEditor({ scopeSel, skillName: skill.name, isNew: false, onDone: reload });
      card.addEventListener("click", openEditor);
      if (!isBuiltin && canDo("can_manage_skills")) {
        card.querySelector("[data-action=edit]").addEventListener("click", e => { e.stopPropagation(); openEditor(); });
        card.querySelector("[data-action=transfer]").addEventListener("click", e => {
          e.stopPropagation();
          _showSkillTransferModal(skill, scopeSel, reload);
        });
        card.querySelector("[data-action=delete]").addEventListener("click", async e => {
          e.stopPropagation();
          if (!confirm(`Delete skill "${skill.name}"? This removes the .py and .yaml files.`)) return;
          try {
            await api.deleteSkill(skill.name, _scopeParams(scopeSel));
            toastSuccess("Skill deleted");
            reload();
          } catch (err) { toastError(err); }
        });
      }

      grid.appendChild(card);
    });

    const noMatch = document.createElement("div");
    noMatch.id = "sk-no-match";
    noMatch.style.display = "none";
    noMatch.innerHTML = `<div class="empty-state"><div class="empty-state-title">No matching skills</div></div>`;
    grid.appendChild(noMatch);
  } catch (err) { toastError(err); }
}

// ── Skill editor (full-pane, takes over #lib-content) ──────────────────────

const _DEFAULT_PY = (name) => `"""${name} — describe what this skill does in one line."""
import json
import sys


def run(input: dict, context: dict) -> dict:
    """Entry point for the skill.

    Args:
        input:   Validated against \`input_schema\` in the YAML config.
        context: Read-only metadata (run_id, agent_name, swarm_id, ...).

    Returns:
        A dict that will be validated against \`output_schema\`.
    """
    return {"ok": True, "echo": input}


if __name__ == "__main__":
    payload = json.loads(sys.argv[1])
    print(json.dumps(run(payload["input"], payload["context"])))
`;

const _DEFAULT_YAML = `description: Briefly describe what this skill does and when to use it.
timeout_seconds: 30
allowed_packages: []
input_schema:
  type: object
  additionalProperties: true
output_schema:
  type: object
  additionalProperties: true
`;

async function _openSkillEditor({ scopeSel, skillName, isNew, onDone }) {
  const root = document.querySelector("#lib-content");
  if (!root) return;

  let initial = { name: skillName || "", py_content: "", yaml_content: "" };
  if (!isNew && skillName) {
    try {
      initial = await api.getSkill(skillName, _scopeParams(scopeSel));
    } catch (err) { toastError(err); return; }
  }

  const startName = initial.name || "";
  const startPy   = initial.py_content   || _DEFAULT_PY(startName || "skill");
  const startYaml = initial.yaml_content || _DEFAULT_YAML;

  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px">
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" id="btn-back">‹ Back</button>
        <div class="page-title" style="font-size:18px">${isNew ? "New skill" : _esc(startName)}</div>
        <span class="badge badge-perceptionist">${_scopeLabel(scopeSel)}</span>
      </div>
      ${canDo("can_manage_skills") ? `<div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" id="btn-ai-draft">Draft with AI</button>
        ${!isNew ? `<button class="btn btn-ghost btn-sm" id="btn-test">Test</button>` : ""}
        <button class="btn btn-primary btn-sm" id="btn-save">Save  ⌘S</button>
      </div>` : ""}
    </div>

    <div id="sk-ai-row" style="display:none;margin-bottom:12px">
      <div style="display:flex;gap:8px;align-items:center">
        <input class="form-input" id="sk-ai-prompt" placeholder="Describe what this skill should do…" style="font-size:12px;flex:1">
        <button class="btn btn-primary btn-sm" id="btn-sk-ai-go" style="white-space:nowrap">Generate</button>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Name</label>
      <input class="form-input ${isNew ? "" : "readonly"}" id="sk-name" type="text"
        value="${_esc(startName)}" placeholder="lowercase-with-hyphens" ${isNew ? "" : "readonly"}>
      <div class="form-helper">Filename slug — lowercase letters, digits, and dashes. Becomes <code style="font-family:var(--font-mono)">&lt;name&gt;.py</code> + <code style="font-family:var(--font-mono)">&lt;name&gt;.yaml</code>.</div>
    </div>

    <details id="sk-runtime" style="margin-bottom:14px;border:1px solid var(--color-cream-line);border-radius:6px;background:var(--color-card);overflow:hidden">
      <summary style="padding:8px 12px;cursor:pointer;font-family:var(--font-mono);font-size:11px;color:var(--color-ink-soft);letter-spacing:.04em;background:var(--color-cream-deep)">
        Available Python libraries <span id="sk-runtime-pyver" style="color:var(--color-ink-faint)"></span>
      </summary>
      <div id="sk-runtime-body" style="padding:10px 14px;font-family:var(--font-mono);font-size:11px;color:var(--color-ink);line-height:1.6">
        Loading…
      </div>
    </details>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;height:calc(100vh - 360px);min-height:400px">
      <div style="display:flex;flex-direction:column;border:1px solid var(--color-cream-line);border-radius:6px;overflow:hidden;background:var(--color-card)">
        <div style="padding:8px 12px;border-bottom:1px dashed var(--color-cream-line);background:var(--color-cream-deep);font-family:var(--font-mono);font-size:11px;color:var(--color-ink-soft);letter-spacing:.06em;text-transform:uppercase">skill.py</div>
        <div id="sk-cm-py" style="flex:1;overflow:hidden"></div>
      </div>
      <div style="display:flex;flex-direction:column;border:1px solid var(--color-cream-line);border-radius:6px;overflow:hidden;background:var(--color-card)">
        <div style="padding:8px 12px;border-bottom:1px dashed var(--color-cream-line);background:var(--color-cream-deep);font-family:var(--font-mono);font-size:11px;color:var(--color-ink-soft);letter-spacing:.06em;text-transform:uppercase">config.yaml</div>
        <div id="sk-cm-yaml" style="flex:1;overflow:hidden"></div>
      </div>
    </div>

    ${!isNew ? `
    <div id="sk-test-panel" style="display:none;margin-top:16px;border:1px solid var(--color-cream-line);border-radius:6px;overflow:hidden;background:var(--color-card)">
      <div style="padding:8px 12px;border-bottom:1px dashed var(--color-cream-line);background:var(--color-cream-deep);font-family:var(--font-mono);font-size:11px;color:var(--color-ink-soft);letter-spacing:.06em;text-transform:uppercase;display:flex;align-items:center;justify-content:space-between">
        <span>Test run</span>
        <button class="btn btn-ghost btn-sm" id="btn-test-run" style="font-size:11px;padding:2px 10px">Run</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0">
        <div style="padding:10px 12px;border-right:1px dashed var(--color-cream-line)">
          <div style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint);margin-bottom:6px;letter-spacing:.04em">INPUT JSON</div>
          <textarea id="sk-test-input" spellcheck="false" style="width:100%;height:120px;resize:vertical;font-family:var(--font-mono);font-size:12px;background:transparent;border:none;outline:none;color:var(--color-ink);line-height:1.5">{}</textarea>
        </div>
        <div style="padding:10px 12px">
          <div style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint);margin-bottom:6px;letter-spacing:.04em">OUTPUT</div>
          <pre id="sk-test-output" style="margin:0;font-family:var(--font-mono);font-size:12px;color:var(--color-ink-soft);white-space:pre-wrap;word-break:break-all;min-height:120px">—</pre>
        </div>
      </div>
    </div>` : ""}`;

  const pyHost   = document.getElementById("sk-cm-py");
  const yamlHost = document.getElementById("sk-cm-yaml");
  pyHost.innerHTML   = '<textarea id="sk-py-textarea"></textarea>';
  yamlHost.innerHTML = '<textarea id="sk-yaml-textarea"></textarea>';

  let pyEditor = null, yamlEditor = null;
  if (typeof CodeMirror !== "undefined") {
    pyEditor = CodeMirror.fromTextArea(document.getElementById("sk-py-textarea"), {
      mode: "python", theme: "default", lineNumbers: true, lineWrapping: false,
      indentUnit: 4, tabSize: 4, autoCloseBrackets: true, matchBrackets: true,
    });
    pyEditor.setValue(startPy);
    pyEditor.setSize("100%", "100%");
    setTimeout(() => pyEditor.refresh(), 50);

    yamlEditor = CodeMirror.fromTextArea(document.getElementById("sk-yaml-textarea"), {
      mode: { name: "yaml" }, theme: "default", lineNumbers: true, lineWrapping: true,
      indentUnit: 2, tabSize: 2,
    });
    yamlEditor.setValue(startYaml);
    yamlEditor.setSize("100%", "100%");
    setTimeout(() => yamlEditor.refresh(), 50);
  } else {
    document.getElementById("sk-py-textarea").value   = startPy;
    document.getElementById("sk-yaml-textarea").value = startYaml;
  }

  document.getElementById("btn-back").addEventListener("click", () => onDone && onDone());

  if (!isNew) {
    const testBtn    = document.getElementById("btn-test");
    const testPanel  = document.getElementById("sk-test-panel");
    const testRunBtn = document.getElementById("btn-test-run");
    const testOutput = document.getElementById("sk-test-output");

    testBtn?.addEventListener("click", () => {
      const open = testPanel.style.display !== "none";
      testPanel.style.display = open ? "none" : "block";
    });

    testRunBtn?.addEventListener("click", async () => {
      const raw = document.getElementById("sk-test-input")?.value.trim() || "{}";
      let input;
      try { input = JSON.parse(raw); } catch { testOutput.textContent = "Invalid JSON in input."; return; }
      testRunBtn.disabled = true;
      testRunBtn.textContent = "Running…";
      testOutput.textContent = "…";
      try {
        const result = await api.testSkill(skillName, _scopeParams(scopeSel), input);
        testOutput.textContent = JSON.stringify(result, null, 2);
        testOutput.style.color = result.ok === false ? "var(--color-danger, #c0392b)" : "var(--color-ink)";
      } catch (err) {
        testOutput.textContent = err?.message || String(err);
        testOutput.style.color = "var(--color-danger, #c0392b)";
      } finally {
        testRunBtn.disabled = false;
        testRunBtn.textContent = "Run";
      }
    });
  }

  const aiDraftBtn = document.getElementById("btn-ai-draft");
  const aiRow      = document.getElementById("sk-ai-row");
  const aiPrompt   = document.getElementById("sk-ai-prompt");
  const aiGo       = document.getElementById("btn-sk-ai-go");

  aiDraftBtn?.addEventListener("click", () => {
    const visible = aiRow.style.display !== "none";
    aiRow.style.display = visible ? "none" : "flex";
    aiRow.style.flexDirection = "column";
    if (!visible) aiPrompt?.focus();
  });

  const runSkillDraft = async () => {
    const name   = (document.getElementById("sk-name")?.value || "").trim() || startName || "skill";
    const prompt = aiPrompt?.value.trim() || "";
    aiGo.disabled = true;
    aiGo.textContent = "Generating…";
    try {
      const result = await api.draftSkill(name, prompt);
      if (result.py_content) {
        if (pyEditor) pyEditor.setValue(result.py_content);
        else { const ta = document.getElementById("sk-py-textarea"); if (ta) ta.value = result.py_content; }
      }
      if (result.yaml_content) {
        if (yamlEditor) yamlEditor.setValue(result.yaml_content);
        else { const ta = document.getElementById("sk-yaml-textarea"); if (ta) ta.value = result.yaml_content; }
      }
      aiRow.style.display = "none";
    } catch (err) {
      toastError(err);
    } finally {
      aiGo.disabled = false;
      aiGo.textContent = "Generate";
    }
  };

  aiGo?.addEventListener("click", runSkillDraft);
  aiPrompt?.addEventListener("keydown", e => { if (e.key === "Enter") runSkillDraft(); });

  api.getSkillsRuntime().then(info => {
    const ver = document.getElementById("sk-runtime-pyver");
    if (ver) ver.textContent = `· Python ${info.python_version}`;
    const body = document.getElementById("sk-runtime-body");
    if (!body) return;
    const stdlib = (info.stdlib_highlights || []).map(m => `<code>${_esc(m)}</code>`).join(", ");
    const tp = (info.third_party || []);
    body.innerHTML = `
      <div style="margin-bottom:10px"><b>Standard library</b> — always allowed (no need to list in <code>allowed_packages</code>):<br>
        <span style="color:var(--color-ink-soft)">${stdlib}, …and the rest of the stdlib.</span>
      </div>
      ${tp.length ? `
      <div><b>Third-party</b> — installed in this container, must be added to <code>allowed_packages</code> in the YAML to use:<br>
        <ul style="margin:6px 0 0 18px;padding:0">
          ${tp.map(p => `<li><code>${_esc(p.name)}</code> <span style="color:var(--color-ink-faint)">${_esc(p.version)}</span> — <span style="color:var(--color-ink-soft)">${_esc(p.hint)}</span></li>`).join("")}
        </ul>
      </div>
      ` : ""}
      ${(info.context_keys || []).length ? `
      <div style="margin-top:10px"><b>Runtime context</b> — keys available in the <code>context</code> dict passed to <code>run()</code>:<br>
        <ul style="margin:6px 0 0 18px;padding:0">
          ${(info.context_keys).map(k => `<li><code>${_esc(k.key)}</code> — <span style="color:var(--color-ink-soft)">${_esc(k.description)}</span></li>`).join("")}
        </ul>
      </div>
      ` : ""}
      <div style="margin-top:10px;color:var(--color-ink-faint)">Skills run in a sandboxed subprocess. Imports outside stdlib + <code>allowed_packages</code> are rejected at save time by static analysis.</div>`;
  }).catch(() => {
    const body = document.getElementById("sk-runtime-body");
    if (body) body.innerHTML = `<span style="color:var(--color-ink-faint)">Could not load runtime info.</span>`;
  });

  const save = async () => {
    const name = (document.getElementById("sk-name")?.value || "").trim();
    const py   = pyEditor   ? pyEditor.getValue()   : (document.getElementById("sk-py-textarea")?.value   || "");
    const yml  = yamlEditor ? yamlEditor.getValue() : (document.getElementById("sk-yaml-textarea")?.value || "");

    if (!name) { toastError({ message: "Name is required" }); return; }

    const body = { ..._scopeParams(scopeSel), name, py_content: py, yaml_content: yml };
    try {
      if (isNew) await api.createSkill(body);
      else       await api.updateSkill(name, body);
      toastSuccess("Skill saved");
      onDone && onDone();
    } catch (err) { toastError(err); }
  };

  document.getElementById("btn-save")?.addEventListener("click", save);

  if (canDo("can_manage_skills")) {
    const kbd = e => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
    };
    document.addEventListener("keydown", kbd);
    setTimeout(() => {
      if (!document.getElementById("btn-save")) document.removeEventListener("keydown", kbd);
    }, 1000);
  }
}

// ── Transfer modal ─────────────────────────────────────────────────────────

function _showModal(title, bodyHtml, onConfirm, confirmLabel = "Save", danger = false) {
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
  return { close };
}

const _TRANSFER_DST_HTML = `
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
    <label class="form-label">Destination scope</label>
    <select class="form-input" id="m-scope">
      <option value="company">Company</option>
      <option value="workspace">Workspace</option>
      <option value="swarm">Swarm</option>
    </select>
  </div>
  <div id="m-ws-row" class="form-group" style="display:none">
    <label class="form-label">Workspace</label>
    <select class="form-input" id="m-workspace"><option>Loading…</option></select>
  </div>
  <div id="m-sw-row" class="form-group" style="display:none">
    <label class="form-label">Swarm</label>
    <select class="form-input" id="m-swarm"><option>Loading…</option></select>
  </div>`;

async function _wireTransferDst() {
  const scopeSel = document.getElementById("m-scope");
  const wsRow    = document.getElementById("m-ws-row");
  const wsSelect = document.getElementById("m-workspace");
  const swRow    = document.getElementById("m-sw-row");
  const swSelect = document.getElementById("m-swarm");

  let workspaces = [];
  try { workspaces = await api.listWorkspaces(); } catch (_) {}
  wsSelect.innerHTML = workspaces.map(ws =>
    `<option value="${_esc(ws.id)}">${_esc(ws.display_name)}</option>`).join("");

  const populateSwarms = async () => {
    const wsId = wsSelect.value;
    if (!wsId) return;
    swSelect.innerHTML = "<option>Loading…</option>";
    try {
      const swarms = await api.listSwarms(wsId);
      swSelect.innerHTML = swarms.length
        ? swarms.map(s => `<option value="${_esc(s.id)}">${_esc(s.display_name)}</option>`).join("")
        : "<option disabled>No swarms in this workspace</option>";
    } catch (_) { swSelect.innerHTML = "<option>Error loading</option>"; }
  };

  const updateRows = async () => {
    const scope = scopeSel.value;
    wsRow.style.display = scope !== "company" ? "" : "none";
    swRow.style.display = scope === "swarm" ? "" : "none";
    if (scope === "swarm") await populateSwarms();
  };

  scopeSel.addEventListener("change", updateRows);
  wsSelect.addEventListener("change", () => { if (scopeSel.value === "swarm") populateSwarms(); });
}

function _readTransferDst() {
  const op           = document.querySelector('[name="m-op"]:checked')?.value || "copy";
  const scope        = document.getElementById("m-scope")?.value || "company";
  const workspace_id = scope !== "company" ? (document.getElementById("m-workspace")?.value || null) : null;
  const swarm_id     = scope === "swarm"   ? (document.getElementById("m-swarm")?.value    || null) : null;
  if (scope === "workspace" && !workspace_id) throw { message: "Select a workspace" };
  if (scope === "swarm"     && !swarm_id)     throw { message: "Select a swarm" };
  return { op, scope, workspace_id, swarm_id };
}

function _showKnowledgeTransferModal(doc, reload) {
  _showModal(
    `Transfer · ${_esc(doc.title || doc.name)}`,
    `<p style="margin:0 0 14px;font-size:12px;color:var(--color-ink-soft)">
       Copy or move <b>${_esc(doc.title || doc.name)}</b> to another scope.
     </p>${_TRANSFER_DST_HTML}`,
    async () => {
      const { op, scope, workspace_id, swarm_id } = _readTransferDst();
      await api.transferKnowledge(doc.id, { op, scope, workspace_id, swarm_id });
      toastSuccess(op === "copy" ? "Document copied" : "Document moved");
      reload();
    },
    "Transfer"
  );
  _wireTransferDst();
}

function _showSkillTransferModal(skill, scopeSel, reload) {
  _showModal(
    `Transfer · ${_esc(skill.name)}`,
    `<p style="margin:0 0 14px;font-size:12px;color:var(--color-ink-soft)">
       Copy or move skill <b>${_esc(skill.name)}</b> to another scope.
     </p>${_TRANSFER_DST_HTML}`,
    async () => {
      const { op, scope, workspace_id, swarm_id } = _readTransferDst();
      const src = _scopeParams(scopeSel);
      await api.transferSkill(skill.name, {
        op,
        src_scope: src.scope,
        src_workspace_id: src.workspace_id || null,
        src_swarm_id: src.swarm_id || null,
        dst_scope: scope,
        dst_workspace_id: workspace_id,
        dst_swarm_id: swarm_id,
      });
      toastSuccess(op === "copy" ? "Skill copied" : "Skill moved");
      reload();
    },
    "Transfer"
  );
  _wireTransferDst();
}

// ── Utils ──────────────────────────────────────────────────────────────────

function _filterCards(grid, query, cardSelector, noMatchId) {
  const q = query.toLowerCase();
  grid.querySelectorAll(cardSelector).forEach(card => {
    const text = (card.dataset.knSearch || card.dataset.skSearch || "").toLowerCase();
    card.style.display = text.includes(q) ? "" : "none";
  });
  const noMatch = document.getElementById(noMatchId);
  if (noMatch) {
    const visible = [...grid.querySelectorAll(cardSelector)].some(c => c.style.display !== "none");
    noMatch.style.display = visible ? "none" : "";
  }
}

function _fmtAge(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (isNaN(d)) return "";
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60)        return "just now";
  if (secs < 3600)      return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400)     return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 86400 * 7) return `${Math.floor(secs / 86400)}d ago`;
  return d.toLocaleDateString();
}

function _fmtBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function _esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
