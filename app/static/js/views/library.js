import * as api from "../api.js";
import { toastError, toastSuccess } from "../components/toast.js";
import { _showModal } from "./org-design.js";

/**
 * Library view — skills and knowledge across scopes.
 *
 * Routes:
 *   library                       → knowledge, company scope
 *   library/knowledge             → knowledge, company scope
 *   library/knowledge/<wsId>      → knowledge, workspace scope
 *   library/skills                → skills, company scope
 *   library/skills/ws/<wsId>      → skills, workspace scope
 *   library/skills/sw/<swarmId>   → skills, swarm scope
 */
export function renderLibraryView(container, segments = []) {
  container.style.overflowY = "hidden";
  container.style.height = "100%";

  const tab = segments[0] || "knowledge";

  // Parse scope from segments. Knowledge supports company + workspace.
  // Skills support all three: company, workspace ("ws"), swarm ("sw").
  let scope = "company", workspaceId = null, swarmId = null;
  if (tab === "knowledge") {
    if (segments[1]) { scope = "workspace"; workspaceId = segments[1]; }
  } else if (tab === "skills") {
    if (segments[1] === "ws" && segments[2])      { scope = "workspace"; workspaceId = segments[2]; }
    else if (segments[1] === "sw" && segments[2]) { scope = "swarm";     swarmId     = segments[2]; }
  }

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden">
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

  // Company
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

    // Skills tab needs swarms-per-workspace; fetch them in parallel.
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

  const headerRow = document.createElement("div");
  headerRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:16px";
  headerRow.innerHTML = `
    <div class="sec-header" style="margin:0">Knowledge documents</div>
    <button class="btn btn-primary btn-sm" id="btn-new-doc">+ New document</button>`;
  content.appendChild(headerRow);

  const grid = document.createElement("div");
  grid.id = "kn-grid";
  content.appendChild(grid);

  const load = async () => {
    const params = wsId
      ? { scope: "workspace", workspace_id: wsId }
      : { scope: "company" };
    try {
      const docs = await api.listKnowledge(params);
      _renderKnowledgeGrid(grid, docs, load, params);
    } catch (err) { toastError(err); }
  };

  content.querySelector("#btn-new-doc").addEventListener("click", () => {
    _showCreateKnowledgeModal(wsId, load);
  });

  await load();
}

function _renderKnowledgeGrid(grid, docs, reload, params) {
  grid.innerHTML = "";
  if (!docs.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-state-title">No documents</div><div class="empty-state-sub">Create a knowledge document to get started.</div></div>`;
    return;
  }

  docs.forEach(doc => {
    const card = document.createElement("div");
    card.className = "card";
    card.style.cssText = "margin-bottom:8px;display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer";
    card.innerHTML = `
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;font-size:13px">${_esc(doc.title || doc.name)}</div>
        <div style="font-size:11px;color:var(--color-text-muted);margin-top:2px">${_esc(doc.name)}.md · ${_fmtBytes(doc.size_bytes)}</div>
      </div>
      <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
      <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>`;

    card.querySelector("[data-action=edit]").addEventListener("click", e => {
      e.stopPropagation();
      _showEditKnowledgeModal(doc, reload);
    });
    card.querySelector("[data-action=delete]").addEventListener("click", async e => {
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
}

function _showCreateKnowledgeModal(wsId, onDone) {
  _showModal("New knowledge document", `
    <div class="form-group">
      <label class="form-label">Name <span style="font-size:10px;color:var(--color-text-muted)">(filename, no spaces)</span></label>
      <input class="form-input" id="m-kn-name" placeholder="e.g. invoice-policy">
    </div>
    <div class="form-group">
      <label class="form-label">Title</label>
      <input class="form-input" id="m-kn-title" placeholder="Human-readable title">
    </div>`,
    async () => {
      const name = document.getElementById("m-kn-name")?.value.trim();
      if (!name) throw { message: "Name is required" };
      const body = {
        scope: wsId ? "workspace" : "company",
        workspace_id: wsId || null,
        name,
        title: document.getElementById("m-kn-title")?.value.trim() || null,
        content: "",
      };
      const doc = await api.createKnowledge(body);
      toastSuccess("Created");
      _showEditKnowledgeModal(doc, onDone);
      onDone();
    }
  );
  setTimeout(() => document.getElementById("m-kn-name")?.focus(), 50);
}

function _showEditKnowledgeModal(doc, onDone) {
  _showModal(`Edit: ${doc.title || doc.name}`, `
    <div class="form-group">
      <label class="form-label">Title</label>
      <input class="form-input" id="m-kn-title" value="${_esc(doc.title || "")}">
    </div>
    <div class="form-group" style="flex:1">
      <label class="form-label">Content (Markdown)</label>
      <textarea class="form-input" id="m-kn-body" style="min-height:300px;font-family:var(--font-mono);font-size:12px;resize:vertical">${_esc(doc.content || "")}</textarea>
    </div>`,
    async () => {
      await api.updateKnowledge(doc.id, {
        title: document.getElementById("m-kn-title")?.value.trim() || null,
        content: document.getElementById("m-kn-body")?.value || "",
      });
      toastSuccess("Saved");
      onDone();
    },
    "Save"
  );

  // Load actual content if not already embedded
  if (!doc.content) {
    api.getKnowledge(doc.id).then(full => {
      const ta = document.getElementById("m-kn-body");
      if (ta) ta.value = full.content || "";
    }).catch(() => {});
  }
}

// ── Skills ─────────────────────────────────────────────────────────────────

const _scopeParams = (s) => {
  const p = { scope: s.scope };
  if (s.workspaceId) p.workspace_id = s.workspaceId;
  if (s.swarmId)     p.swarm_id     = s.swarmId;
  return p;
};

const _scopeLabel = (s) =>
  s.scope === "company" ? "Company"
  : s.scope === "workspace" ? "Workspace"
  : "Swarm";

async function _renderSkills(container, scopeSel) {
  const content = container.querySelector("#lib-content");

  const headerRow = document.createElement("div");
  headerRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:16px";
  headerRow.innerHTML = `
    <div>
      <div class="sec-header" style="margin:0">Skills · ${_scopeLabel(scopeSel)}</div>
      <div style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono);margin-top:4px">
        Sandboxed Python scripts. Resolved most-local-first: swarm → workspace → company.
      </div>
    </div>
    <button class="btn btn-primary btn-sm" id="btn-new-skill">+ New skill</button>`;
  content.appendChild(headerRow);

  const grid = document.createElement("div");
  grid.id = "sk-grid";
  content.appendChild(grid);

  const reload = () => _renderSkills(container, scopeSel);
  content.querySelector("#btn-new-skill").addEventListener("click", () =>
    _openSkillEditor({ scopeSel, isNew: true, onDone: reload }));

  try {
    const skills = await api.listSkills(_scopeParams(scopeSel));
    if (!skills.length) {
      grid.innerHTML = `<div class="empty-state"><div class="empty-state-title">No skills at this scope</div><div class="empty-state-sub">Click "+ New skill" to create one. The editor opens with a working stub you can edit.</div></div>`;
      return;
    }
    skills.forEach(skill => {
      const card = document.createElement("div");
      card.className = "card";
      card.style.cssText = "margin-bottom:8px;display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer";
      card.innerHTML = `
        <div class="card-icon card-icon-perceptionist" style="width:32px;height:32px;font-size:14px">⚙</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;font-family:var(--font-mono);color:var(--color-ink)">${_esc(skill.name)}</div>
          <div style="font-size:11px;color:var(--color-ink-soft);margin-top:2px">${_esc(skill.description || "No description")} · timeout ${skill.timeout_seconds ?? 30}s</div>
          ${(skill.allowed_packages || []).length ? `<div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">${skill.allowed_packages.map(p => `<span class="chip" style="font-size:10px">${_esc(p)}</span>`).join("")}</div>` : ""}
        </div>
        <button class="btn btn-secondary btn-sm" data-action="edit">Edit</button>
        <button class="btn btn-ghost btn-sm" data-action="delete">Delete</button>`;

      card.querySelector("[data-action=edit]").addEventListener("click", e => {
        e.stopPropagation();
        _openSkillEditor({ scopeSel, skillName: skill.name, isNew: false, onDone: reload });
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

      grid.appendChild(card);
    });
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
  // Render an inline editor inside the library's right pane. We don't navigate
  // to a new route so the user can hit "Back" and stay in context.
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
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" id="btn-save">Save  ⌘S</button>
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
    </div>`;

  // Initialize CodeMirror editors
  const pyHost = document.getElementById("sk-cm-py");
  const yamlHost = document.getElementById("sk-cm-yaml");
  pyHost.innerHTML = '<textarea id="sk-py-textarea"></textarea>';
  yamlHost.innerHTML = '<textarea id="sk-yaml-textarea"></textarea>';

  let pyEditor = null, yamlEditor = null;
  if (typeof CodeMirror !== "undefined") {
    pyEditor = CodeMirror.fromTextArea(document.getElementById("sk-py-textarea"), {
      mode: "python",
      theme: "default",
      lineNumbers: true,
      lineWrapping: false,
      indentUnit: 4,
      tabSize: 4,
      autoCloseBrackets: true,
      matchBrackets: true,
    });
    pyEditor.setValue(startPy);
    pyEditor.setSize("100%", "100%");
    setTimeout(() => pyEditor.refresh(), 50);

    yamlEditor = CodeMirror.fromTextArea(document.getElementById("sk-yaml-textarea"), {
      mode: { name: "yaml" },
      theme: "default",
      lineNumbers: true,
      lineWrapping: true,
      indentUnit: 2,
      tabSize: 2,
    });
    yamlEditor.setValue(startYaml);
    yamlEditor.setSize("100%", "100%");
    setTimeout(() => yamlEditor.refresh(), 50);
  } else {
    document.getElementById("sk-py-textarea").value = startPy;
    document.getElementById("sk-yaml-textarea").value = startYaml;
  }

  document.getElementById("btn-back").addEventListener("click", () => onDone && onDone());

  // Populate the runtime-info panel once the editor is mounted.
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
      <div style="margin-top:10px;color:var(--color-ink-faint)">Skills run in a sandboxed subprocess. Imports outside stdlib + <code>allowed_packages</code> are rejected at save time by static analysis.</div>`;
  }).catch(() => {
    const body = document.getElementById("sk-runtime-body");
    if (body) body.innerHTML = `<span style="color:var(--color-ink-faint)">Could not load runtime info.</span>`;
  });

  const save = async () => {
    const name = (document.getElementById("sk-name")?.value || "").trim();
    const py   = pyEditor   ? pyEditor.getValue()   : (document.getElementById("sk-py-textarea")?.value || "");
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

  document.getElementById("btn-save").addEventListener("click", save);

  const kbd = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
  };
  document.addEventListener("keydown", kbd);
  // Tear down listener when the user navigates away (best-effort).
  setTimeout(() => {
    if (!document.getElementById("btn-save")) document.removeEventListener("keydown", kbd);
  }, 1000);
}

// ── Utils ──────────────────────────────────────────────────────────────────

function _fmtBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function _esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
