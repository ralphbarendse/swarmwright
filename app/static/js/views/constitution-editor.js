import * as api from "../api.js";
import { toast, toastError, toastSuccess } from "../components/toast.js";
import { setLastAgent } from "../app.js";
import { _showModal } from "./org-design.js";
import { _showAttachSkillModal } from "./swarm-canvas.js";
import { canDo } from "../auth.js";
import { renderMarkdown } from "../components/markdown.js";
import { icon } from "../icons.js";

let _editor = null;
let _themeInjected = false;

// ── CodeMirror theme ──────────────────────────────────────────────────────────

function _injectTheme() {
  if (_themeInjected) return;
  _themeInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .cm-s-swarmwright.CodeMirror {
      background: #f5f0e8; color: #2b2418;
      font-family: 'IBM Plex Mono','Courier Prime','Courier New',monospace;
      font-size: 13px; line-height: 1.65; padding: 0;
    }
    .cm-s-swarmwright .CodeMirror-scroll { padding-bottom: 40px; }
    .cm-s-swarmwright .CodeMirror-gutters {
      background: #ede8df; border-right: 1px solid #d8cfb8;
    }
    .cm-s-swarmwright .CodeMirror-linenumber { color: #a09070; }
    .cm-s-swarmwright .CodeMirror-cursor { border-left: 2px solid #c97c2a; }
    .cm-s-swarmwright .CodeMirror-selected { background: rgba(201,124,42,.14) !important; }
    .cm-s-swarmwright .CodeMirror-activeline-background { background: rgba(43,36,24,.03); }
    .cm-s-swarmwright .cm-header { color: #2b2418; font-weight: 700; }
    .cm-s-swarmwright .cm-header-1 { font-size: 1.15em; }
    .cm-s-swarmwright .cm-header-2 { font-size: 1.05em; }
    .cm-s-swarmwright .cm-strong { font-weight: 700; color: #2b2418; }
    .cm-s-swarmwright .cm-em { font-style: italic; color: #5a5040; }
    .cm-s-swarmwright .cm-link { color: #2a6b6b; text-decoration: underline; }
    .cm-s-swarmwright .cm-comment { color: #a09070; }
    .cm-s-swarmwright .cm-keyword { color: #1e3a5f; }
    .cm-s-swarmwright .cm-hr { color: #d8cfb8; }
  `;
  document.head.appendChild(s);
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function renderConstitutionEditor(container, agentId) {
  if (!agentId) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-title">No agent selected</div><div class="empty-state-sub">Open an agent from the Swarm canvas.</div></div>`;
    return null;
  }
  setLastAgent(agentId);
  _injectTheme();

  container.style.cssText = "display:flex;flex-direction:column;height:100%;overflow:hidden";

  container.innerHTML = `
    <div class="crumbs" id="ed-crumbs">
      <span class="crumb-link" onclick="swNav('org')">Workspaces</span>
      <span class="crumb-sep">›</span>
      <span id="ed-crumb-swarm" style="display:none">
        <span class="crumb-link" id="ed-crumb-swarm-link"></span>
        <span class="crumb-sep">›</span>
      </span>
      <span class="crumb-here" id="ed-crumb-name">…</span>
    </div>

    <!-- Toolbar -->
    <div class="ed-toolbar">
      <div class="ed-toolbar-left">
        ${canDo("can_edit_constitution") ? `<span id="ed-dirty-dot" class="ed-dirty-dot" title="Unsaved changes"></span>` : ""}
        <span id="ed-filename" class="ed-filename">…</span>
        <span id="ed-stats" class="ed-stats"></span>
      </div>
      <div class="ed-toolbar-right">
        ${canDo("can_edit_constitution") ? `
          <button class="btn btn-ghost btn-sm" id="btn-draft">${icon("sparkles", { size: 13 })} Draft</button>
          <button class="btn btn-ghost btn-sm" id="btn-discard">Discard</button>
          <button class="btn btn-primary btn-sm" id="btn-save">Save ⌘S</button>
        ` : `<span style="font-family:var(--font-mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-ink-faint)">Read only</span>`}
      </div>
    </div>

    <!-- Three-pane body -->
    <div class="ed-body">

      <!-- ── Left sidebar: Config + Skills + Agents ── -->
      <aside class="ed-sidebar">
        <div class="ed-sidebar-inner">

          <div class="ed-sidebar-section">
            <span class="ed-sidebar-label">Config</span>
            <div id="ed-fm-form"></div>
          </div>

          <div class="ed-sidebar-section">
            <div class="ed-sidebar-label-row">
              <span class="ed-sidebar-label" style="margin-bottom:0">Skills</span>
              ${canDo("can_edit_constitution") ? `<button class="btn btn-secondary btn-sm" id="ed-attach-skill" style="font-size:10px;padding:2px 8px">+ Attach</button>` : ""}
            </div>
            <div class="ed-sidebar-hint">Stored in hierarchy.json</div>
            <div id="ed-skills-list"></div>
          </div>

          <div id="ed-swarm-agents" style="display:none" class="ed-sidebar-section">
            <div class="ed-sidebar-label-row" id="ed-swarm-agents-hdr" style="cursor:pointer;user-select:none">
              <span class="ed-sidebar-label" style="margin-bottom:0">Swarm agents</span>
              <span id="ed-swarm-agents-arrow" style="font-size:10px;color:var(--color-ink-faint)">▾</span>
            </div>
            <div id="ed-swarm-agents-body">
              <div id="ed-swarm-agents-list"></div>
            </div>
          </div>

        </div>
      </aside>

      <!-- ── Center: editor + scaffold bar ── -->
      <div class="ed-center">
        <div id="ed-cm" class="ed-cm"></div>

        <!-- Action insert popover (above scaffold) -->
        <div id="ed-action-popover" class="ed-action-popover" style="display:none">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label">Action</label>
              <select class="form-select" id="ap-action" style="font-size:11px;padding:5px 10px">
                <option value="delegate">delegate</option>
                <option value="report">report</option>
                <option value="skill_call">skill_call</option>
                <option value="escalate">escalate</option>
                <option value="consult">consult</option>
              </select>
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label">Target</label>
              <select class="form-select" id="ap-target" style="font-size:11px;padding:5px 10px">
                <option value="">— select —</option>
              </select>
            </div>
          </div>
          <div class="form-group" style="margin-bottom:8px">
            <label class="form-label">Purpose match</label>
            <input class="form-input" id="ap-purpose" placeholder="e.g. To summarize the document" style="font-size:11px;padding:5px 10px">
          </div>
          <div style="display:flex;gap:6px;justify-content:flex-end">
            <button class="btn btn-ghost btn-sm" id="ap-cancel">Cancel</button>
            <button class="btn btn-primary btn-sm" id="ap-insert">Insert snippet</button>
          </div>
        </div>

        ${canDo("can_edit_constitution") ? `
        <!-- Scaffold bar -->
        <div class="ed-scaffold">
          <span class="ed-scaffold-label">Insert</span>
          ${["Role","Responsibilities","Behavior","Output Format","Constraints"].map(s =>
            `<button class="btn btn-ghost btn-sm scaffold-btn" data-section="${s}" style="font-size:10px;padding:2px 8px;letter-spacing:0">${s}</button>`
          ).join("")}
          <span class="ed-scaffold-sep"></span>
          <button class="btn btn-ghost btn-sm" id="btn-insert-action" style="font-size:10px;padding:2px 8px;letter-spacing:0">${icon("plus", { size: 11 })} Action</button>
        </div>` : ""}
      </div>

      <!-- ── Right: Preview + Context tabs ── -->
      <div class="ed-right">
        <div class="ed-right-tabs">
          <button id="tab-preview" class="topbar-tab active" style="font-size:12px;padding:8px 14px">Preview</button>
          <button id="tab-context" class="topbar-tab" style="font-size:12px;padding:8px 14px">Context</button>
        </div>
        <div id="panel-preview" class="ed-right-panel">
          <div id="ed-preview" style="line-height:1.7;font-size:13px;color:var(--color-text)"></div>
        </div>
        <div id="panel-context" class="ed-right-panel" style="display:none">
          <div id="ed-context"><div style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint)">Loading…</div></div>
        </div>
      </div>

    </div>`;

  let _originalContent = "";
  let _dirty = false;

  const dirtyDot = container.querySelector("#ed-dirty-dot");
  const setDirty = (v) => {
    _dirty = v;
    dirtyDot.style.opacity = v ? "1" : "0";
    dirtyDot.style.background = v ? "var(--color-amber)" : "var(--color-text-muted)";
  };

  // ── Load ──────────────────────────────────────────────────────────────────
  _load(container, agentId, setDirty, (content, agent) => {
    _originalContent = content;
    _initEditor(container, content, () => {
      setDirty(true);
      _updateStats(container);
    });
    if (agent?.swarm_id) {
      _loadContext(container, agent);
    } else {
      const ctx = container.querySelector("#ed-context");
      if (ctx) ctx.innerHTML = `<div style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint)">No swarm context available.</div>`;
    }
  });

  // ── Save ──────────────────────────────────────────────────────────────────
  const _doSave = async () => {
    const constitution = _getFullContent(container);
    container.querySelector("#btn-save").disabled = true;
    try {
      await api.updateConstitution(agentId, constitution);
      _originalContent = constitution;
      setDirty(false);
      toastSuccess("Saved");
    } catch (err) { toastError(err); }
    finally { container.querySelector("#btn-save").disabled = false; }
  };

  const save = () => {
    if (!_editor) return;
    const newContent = _getFullContent(container);
    if (newContent === _originalContent) { _doSave(); return; }
    _showDiffModal(_originalContent, newContent, _doSave);
  };

  container.querySelector("#btn-save").addEventListener("click", save);

  // ── Discard (modal instead of confirm()) ─────────────────────────────────
  container.querySelector("#btn-discard").addEventListener("click", () => {
    if (!_dirty) return;
    _showModal(
      "Discard changes",
      `<p style="font-size:13px;color:var(--color-ink-soft)">Discard all unsaved changes and revert to the last saved version?</p>`,
      async () => {
        _resetEditor(_originalContent, container);
        setDirty(false);
        _updateStats(container);
      },
      "Discard"
    );
  });

  // ── Keyboard save ─────────────────────────────────────────────────────────
  function _kbdSave(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
  }
  document.addEventListener("keydown", _kbdSave);

  // ── AI Draft ─────────────────────────────────────────────────────────────
  container.querySelector("#btn-draft").addEventListener("click", () => {
    _showModal(
      `${icon("sparkles", { size: 13 })} Draft constitution`,
      `<div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Instructions (optional)</label>
        <textarea class="form-input" id="m-draft-prompt" rows="4"
          placeholder="e.g. Focus on strict data validation and rejection of malformed invoices…"
          style="font-size:12px;resize:vertical;line-height:1.5"></textarea>
      </div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label">Mode</label>
        <div style="display:flex;gap:12px;font-size:12px;font-family:var(--font-mono)">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="radio" name="draft-mode" value="replace" checked> Replace body
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="radio" name="draft-mode" value="append"> Append
          </label>
        </div>
      </div>`,
      async () => {
        const prompt = document.getElementById("m-draft-prompt")?.value.trim() || "";
        const mode = document.querySelector('input[name="draft-mode"]:checked')?.value || "replace";
        const btn = container.querySelector("#btn-draft");
        btn.innerHTML = `${icon("sparkles", { size: 13 })} Drafting…`;
        btn.disabled = true;
        try {
          const result = await api.draftConstitution(agentId, prompt);
          if (!_editor) return;
          if (mode === "replace") {
            _editor.setValue(result.content);
          } else {
            const cur = _editor.getValue();
            _editor.setValue(cur + (cur.endsWith("\n") ? "" : "\n") + "\n" + result.content);
          }
          setDirty(true);
          _updateStats(container);
          _updatePreview(container);
          toastSuccess("Draft inserted");
        } catch (err) { toastError(err); }
        finally { btn.innerHTML = `${icon("sparkles", { size: 13 })} Draft`; btn.disabled = false; }
      },
      "Generate"
    );
    setTimeout(() => document.getElementById("m-draft-prompt")?.focus(), 60);
  });

  // ── Section scaffold ─────────────────────────────────────────────────────
  container.querySelectorAll(".scaffold-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!_editor) return;
      const section = btn.dataset.section;
      const insert = `\n## ${section}\n\n`;
      const cursor = _editor.getCursor();
      _editor.replaceRange(insert, cursor);
      _editor.focus();
      setDirty(true);
      _updateStats(container);
    });
  });

  // ── Right-side tabs (Preview / Context) ──────────────────────────────────
  const tabPreview = container.querySelector("#tab-preview");
  const tabContext = container.querySelector("#tab-context");
  const panelPreview = container.querySelector("#panel-preview");
  const panelContext = container.querySelector("#panel-context");

  tabPreview.addEventListener("click", () => {
    tabPreview.classList.add("active");
    tabContext.classList.remove("active");
    panelPreview.style.display = "";
    panelContext.style.display = "none";
  });
  tabContext.addEventListener("click", () => {
    tabContext.classList.add("active");
    tabPreview.classList.remove("active");
    panelContext.style.display = "";
    panelPreview.style.display = "none";
  });

  return () => {
    document.removeEventListener("keydown", _kbdSave);
    if (_editor) { _editor.toTextArea?.(); _editor = null; }
    // Remove knowledge dropdown if it was appended to body
    document.getElementById("_kn-dropdown")?.remove();
  };
}

// ── Load agent data ────────────────────────────────────────────────────────

async function _load(container, agentId, setDirty, onContent) {
  try {
    const [agent, modelsSetting] = await Promise.all([
      api.getAgent(agentId),
      api.getSetting("models.available").catch(() => null),
    ]);
    container.querySelector("#ed-crumb-name").textContent = agent.name;
    container.querySelector("#ed-filename").textContent = `${agent.name}.md`;

    if (agent.swarm_id) {
      api.getSwarm(agent.swarm_id).then(swarm => {
        const crumbWrap = container.querySelector("#ed-crumb-swarm");
        const crumbLink = container.querySelector("#ed-crumb-swarm-link");
        if (crumbWrap && crumbLink) {
          crumbLink.textContent = swarm.name || "Swarm";
          crumbLink.onclick = () => window.swNav("swarm/" + agent.swarm_id);
          crumbWrap.style.display = "";
        }
      }).catch(() => {});
    }

    const configuredModels = modelsSetting?.value || [];
    const content = agent.constitution || _defaultConstitution(agent);
    _buildFrontmatterForm(container, content, agent, setDirty, configuredModels);
    onContent(content, agent);

    if (agent.swarm_id) {
      _wireSkillsPanel(container, agent);
      _refreshSkillsPanel(container, agent);
      _loadSwarmAgentsPanel(container, agent);
      _wireActionInsert(container, agent);
    }
  } catch (err) { toastError(err); }
}

// ── Context panel ──────────────────────────────────────────────────────────

async function _loadContext(container, agent) {
  const panel = container.querySelector("#ed-context");
  if (!panel) return;
  try {
    const h = await api.getHierarchy(agent.swarm_id);
    const edges    = h.edges || [];
    const callsTo  = edges.filter(e => e.from === agent.name);
    const calledBy = edges.filter(e => e.to   === agent.name);
    const mySkills = (h.skills || []).filter(s => s.agent === agent.name);
    const isEntry  = h.entry_point === agent.name;

    const EDGE_COLORS = {
      delegate: "var(--color-policy)",
      report:   "var(--color-ink-faint)",
      consult:  "var(--color-perceptionist)",
      escalate: "var(--color-amber)",
    };
    const edgeBadge = (e) => `<span style="
      font-family:var(--font-mono);font-size:9px;letter-spacing:.05em;
      text-transform:uppercase;
      color:${EDGE_COLORS[e.kind] || "var(--color-ink-faint)"};
      border:1px solid ${EDGE_COLORS[e.kind] || "var(--color-cream-line)"};
      border-radius:3px;padding:1px 5px;white-space:nowrap;
    ">${_esc(e.kind || "?")}</span>`;

    const edgeRow = (label, e) => `
      <div style="padding:8px;border:1px dashed var(--color-cream-line);border-radius:4px;margin-bottom:5px">
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:3px">
          ${edgeBadge(e)}
          <span style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--color-ink)">${_esc(label)}</span>
        </div>
        ${e.purpose ? `<div style="font-size:11px;color:var(--color-ink-soft);font-style:italic;margin-left:1px">"${_esc(e.purpose)}"</div>` : ""}
      </div>`;

    panel.innerHTML = `
      ${isEntry ? `<div style="margin-bottom:14px">
        <span style="background:var(--color-amber);color:var(--color-bg);font-family:var(--font-mono);font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px;letter-spacing:.05em">ENTRY POINT</span>
      </div>` : ""}

      <div class="sec-header" style="margin-bottom:7px">Called by</div>
      ${calledBy.length
        ? calledBy.map(e => edgeRow(e.from, e)).join("")
        : `<div style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint);margin-bottom:14px;padding-bottom:2px">Not called by any agent.</div>`}

      <div class="sec-header" style="margin-bottom:7px;margin-top:14px">Delegates to</div>
      ${callsTo.length
        ? callsTo.map(e => edgeRow(e.to, e)).join("")
        : `<div style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint);margin-bottom:14px;padding-bottom:2px">No outgoing delegations.</div>`}

      <div class="sec-header" style="margin-bottom:7px;margin-top:14px">Skills</div>
      ${mySkills.length
        ? mySkills.map(s => `
            <div style="padding:7px 8px;border:1px dashed var(--color-cream-line);border-radius:4px;margin-bottom:5px">
              <div style="font-family:var(--font-mono);font-size:12px;color:var(--color-ink)">${_esc(s.skill)}</div>
              ${s.purpose ? `<div style="font-size:10px;color:var(--color-ink-soft);font-style:italic;margin-top:2px">"${_esc(s.purpose)}"</div>` : ""}
            </div>`).join("")
        : `<div style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint)">No skills attached.</div>`}`;
  } catch {
    panel.innerHTML = `<div style="font-size:11px;color:var(--color-danger);font-family:var(--font-mono)">Could not load swarm context.</div>`;
  }
}

// ── Skills panel ───────────────────────────────────────────────────────────

function _wireSkillsPanel(container, agent) {
  const btn = container.querySelector("#ed-attach-skill");
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = "1";
  btn.addEventListener("click", () => {
    _showAttachSkillModal(agent.swarm_id, agent.name, () => _refreshSkillsPanel(container, agent));
  });
}

async function _refreshSkillsPanel(container, agent) {
  const list = container.querySelector("#ed-skills-list");
  if (!list) return;
  list.innerHTML = `<div style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono)">Loading…</div>`;
  try {
    const hierarchy = await api.getHierarchy(agent.swarm_id);
    const mine = (hierarchy.skills || []).filter(s => s.agent === agent.name);
    if (!mine.length) {
      list.innerHTML = `<div style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono);padding:4px 0">No skills attached yet.</div>`;
      return;
    }
    list.innerHTML = mine.map(s => `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:5px 8px;border:1px solid var(--color-cream-line);border-radius:5px;background:var(--color-card);margin-bottom:4px">
        <div style="flex:1;min-width:0">
          <div style="font-family:var(--font-mono);font-size:12px;color:var(--color-ink)">${_esc(s.skill)}</div>
          <div style="font-size:10px;color:var(--color-ink-soft);font-style:italic;margin-top:1px">"${_esc(s.purpose || "")}"</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-skill="${_esc(s.skill)}" style="font-size:10px">Detach</button>
      </div>`).join("");
    list.querySelectorAll("[data-skill]").forEach(b => {
      b.addEventListener("click", async () => {
        const skill = b.dataset.skill;
        if (!confirm(`Detach skill "${skill}" from ${agent.name}?`)) return;
        try {
          await api.patchTopology(agent.swarm_id, "remove_skill_connection", { agent: agent.name, skill });
          toastSuccess("Skill detached");
          _refreshSkillsPanel(container, agent);
        } catch (err) { toastError(err); }
      });
    });
  } catch (err) {
    list.innerHTML = `<div style="font-size:11px;color:var(--color-danger);font-family:var(--font-mono)">Could not load: ${_esc(err?.message || "")}</div>`;
  }
}

// ── Swarm agents reference panel ──────────────────────────────────────────

async function _loadSwarmAgentsPanel(container, agent) {
  const wrap   = container.querySelector("#ed-swarm-agents");
  const list   = container.querySelector("#ed-swarm-agents-list");
  const hdr    = container.querySelector("#ed-swarm-agents-hdr");
  const body   = container.querySelector("#ed-swarm-agents-body");
  const arrow  = container.querySelector("#ed-swarm-agents-arrow");
  if (!wrap || !list || !agent.swarm_id) return;

  const LAYER_COLOR = {
    policy:        "var(--color-policy)",
    orchestrator:  "var(--color-orchestrator)",
    executioner:   "var(--color-executioner)",
    perceptionist: "var(--color-perceptionist)",
  };

  try {
    const agents = await api.listAgents(agent.swarm_id);
    const others = agents.filter(a => a.id !== agent.id);
    if (!others.length) return;

    list.innerHTML = others.map(a => `
      <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--color-cream-line)">
        <span style="
          font-family:var(--font-mono);font-size:9px;letter-spacing:.04em;
          text-transform:uppercase;color:#fff;flex-shrink:0;white-space:nowrap;
          background:${LAYER_COLOR[a.layer] || "var(--color-ink-faint)"};
          border-radius:3px;padding:1px 5px;
        ">${_esc(a.layer || "?")}</span>
        <span style="
          font-family:var(--font-mono);font-size:11px;color:var(--color-ink);
          flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        " title="${_esc(a.name)}">${_esc(a.name)}</span>
        <button class="btn btn-ghost btn-sm" data-insert-agent="${_esc(a.name)}"
          style="font-size:10px;padding:1px 7px;flex-shrink:0">Insert</button>
      </div>`).join("");

    wrap.style.display = "";

    list.querySelectorAll("[data-insert-agent]").forEach(btn => {
      btn.addEventListener("click", () => {
        if (!_editor) return;
        _editor.replaceRange(btn.dataset.insertAgent, _editor.getCursor());
        _editor.focus();
      });
    });

    // Collapse toggle
    let collapsed = false;
    hdr.addEventListener("click", () => {
      collapsed = !collapsed;
      body.style.display = collapsed ? "none" : "";
      arrow.textContent  = collapsed ? "▸" : "▾";
    });
  } catch { /* silently skip if swarm has no agents yet */ }
}

// ── Action snippet insert ──────────────────────────────────────────────────

async function _wireActionInsert(container, agent) {
  const btnToggle = container.querySelector("#btn-insert-action");
  const popover   = container.querySelector("#ed-action-popover");
  const apAction  = container.querySelector("#ap-action");
  const apTarget  = container.querySelector("#ap-target");
  const apPurpose = container.querySelector("#ap-purpose");
  if (!btnToggle || !popover) return;

  let agentNames = [];
  let skillNames = [];
  try {
    const [agents, hier] = await Promise.all([
      api.listAgents(agent.swarm_id),
      api.getHierarchy(agent.swarm_id),
    ]);
    agentNames = agents.filter(a => a.id !== agent.id).map(a => a.name);
    skillNames = (hier.skills || [])
      .filter(s => s.agent === agent.name)
      .map(s => s.skill);
  } catch { }

  function _rebuildTargets() {
    const useSkills = apAction.value === "skill_call";
    const targets   = useSkills ? skillNames : agentNames;
    apTarget.innerHTML =
      `<option value="">— select —</option>` +
      targets.map(t => `<option value="${_esc(t)}">${_esc(t)}</option>`).join("");
  }

  apAction.addEventListener("change", _rebuildTargets);
  _rebuildTargets();

  btnToggle.addEventListener("click", () => {
    const open = popover.style.display !== "none";
    popover.style.display = open ? "none" : "";
    if (!open) setTimeout(() => apPurpose.focus(), 30);
  });

  container.querySelector("#ap-cancel").addEventListener("click", () => {
    popover.style.display = "none";
  });

  container.querySelector("#ap-insert").addEventListener("click", () => {
    if (!_editor) return;
    const action  = apAction.value  || "delegate";
    const target  = apTarget.value  || "<target>";
    const purpose = apPurpose.value.trim() || "<purpose>";
    const pad     = (s, n) => s + " ".repeat(Math.max(1, n - s.length));
    const snippet =
      "\n```\n" +
      `${pad("action:", 15)}${action}\n` +
      `${pad("target:", 15)}${target}\n` +
      `${pad("purpose_match:", 15)}${purpose}\n` +
      `${pad("input:", 15)}{}\n` +
      "```\n";
    _editor.replaceRange(snippet, _editor.getCursor());
    _editor.focus();
    popover.style.display = "none";
    apPurpose.value = "";
    _rebuildTargets();
  });
}

// ── Frontmatter form ───────────────────────────────────────────────────────

function _buildFrontmatterForm(container, content, agent, setDirty, configuredModels = []) {
  const fm = _parseFrontmatter(content);
  const currentModel = fm.model || agent.model || "";

  // Build model options: use configured models if available, otherwise fall back to defaults
  const FALLBACK_MODELS = [
    { id: "claude-sonnet-4-6",        display_name: "Sonnet 4.6" },
    { id: "claude-opus-4-7",          display_name: "Opus 4.7" },
    { id: "claude-haiku-4-5-20251001", display_name: "Haiku 4.5" },
  ];
  const modelList = configuredModels.length ? configuredModels : FALLBACK_MODELS;

  // Always ensure the agent's current model appears as an option
  const modelIds = modelList.map(m => m.id);
  const allModels = currentModel && !modelIds.includes(currentModel)
    ? [...modelList, { id: currentModel, display_name: currentModel }]
    : modelList;

  const form = container.querySelector("#ed-fm-form");
  form.innerHTML = `
    <div class="form-group" style="margin-bottom:8px">
      <label class="form-label">Layer</label>
      <select class="form-select" id="fm-layer" style="font-size:12px">
        ${["policy","orchestrator","executioner","perceptionist"].map(l =>
          `<option value="${l}" ${(fm.layer || agent.layer) === l ? "selected" : ""}>${_cap(l)}</option>`).join("")}
      </select>
    </div>
    <div class="form-group" style="margin-bottom:8px">
      <label class="form-label">Model</label>
      <select class="form-select" id="fm-model" style="font-size:12px">
        ${allModels.map(m =>
          `<option value="${_esc(m.id)}" ${currentModel === m.id ? "selected" : ""}>${_esc(m.display_name || m.id)}</option>`
        ).join("")}
      </select>
    </div>
    <div class="form-group" style="margin-bottom:8px;position:relative">
      <label class="form-label">Knowledge</label>
      <div class="form-chips" id="fm-knowledge" style="position:relative">
        ${(fm.knowledge || []).map(k => `<span class="chip">${_esc(k)}<button class="chip-remove" onclick="this.parentElement.remove()">×</button></span>`).join("")}
        <input style="border:none;outline:none;font-size:11px;min-width:60px;flex:1" id="fm-kn-input" placeholder="+ add" autocomplete="off">
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <label class="toggle-switch">
        <input type="checkbox" id="fm-web-search" ${(fm.web_search === "true" || fm.web_search === true) ? "checked" : ""}>
        <span class="toggle-slider"></span>
      </label>
      <span class="form-label" style="margin-bottom:0">Web Search</span>
    </div>
    <div class="form-group" style="margin-bottom:0">
      <label class="form-label">Inheritable directives</label>
      <textarea class="form-input" id="fm-inheritable" rows="3"
        placeholder="Constraints passed down to all child agents…"
        style="font-size:11px;font-family:var(--font-mono);resize:vertical;line-height:1.5"
      >${_esc(fm.inheritable || "")}</textarea>
      <div class="ed-sidebar-hint" style="margin-top:3px">Injected into every agent this one delegates to.</div>
    </div>`;

  // Cache models list on form element so _resetEditor can re-use it
  form._cachedModels = configuredModels;

  // Layer / model / web-search changes mark dirty
  form.querySelector("#fm-layer")?.addEventListener("change", () => setDirty && setDirty(true));
  form.querySelector("#fm-model")?.addEventListener("change", () => setDirty && setDirty(true));
  form.querySelector("#fm-web-search")?.addEventListener("change", () => setDirty && setDirty(true));
  form.querySelector("#fm-inheritable")?.addEventListener("input", () => setDirty && setDirty(true));

  // Knowledge autocomplete
  _setupKnowledgeAutocomplete(container, setDirty);
}

// ── Knowledge autocomplete ─────────────────────────────────────────────────

async function _setupKnowledgeAutocomplete(container, setDirty) {
  let items = [];
  try {
    items = await api.listKnowledge({ limit: 500 });
  } catch { return; }

  const knInput = container.querySelector("#fm-kn-input");
  if (!knInput) return;

  // Reuse existing dropdown or create new one
  document.getElementById("_kn-dropdown")?.remove();
  const dropdown = document.createElement("div");
  dropdown.id = "_kn-dropdown";
  dropdown.style.cssText = `
    position:fixed;z-index:9999;
    background:var(--color-card);
    border:1px solid var(--color-cream-line);
    border-radius:6px;box-shadow:var(--shadow);
    max-height:180px;overflow-y:auto;display:none;
    font-family:var(--font-mono);font-size:12px;min-width:200px;
  `;
  document.body.appendChild(dropdown);

  const showDropdown = (query, showAll = false) => {
    const q = query.toLowerCase().trim();
    const alreadyAdded = new Set(
      [...container.querySelectorAll(".chip")].map(c => c.textContent.trim().replace("×", "").trim())
    );
    const matches = items
      .filter(k => !alreadyAdded.has(k.name))
      .filter(k => !q || k.name.toLowerCase().includes(q) || (k.title || "").toLowerCase().includes(q))
      .slice(0, showAll && !q ? 20 : 8);
    if (!matches.length) { dropdown.style.display = "none"; return; }
    if (!matches.length) { dropdown.style.display = "none"; return; }
    const rect = knInput.getBoundingClientRect();
    Object.assign(dropdown.style, {
      left: rect.left + "px",
      top: (rect.bottom + 3) + "px",
      width: Math.max(rect.width, 200) + "px",
      display: "block",
    });
    dropdown.innerHTML = matches.map(k => `
      <div class="kn-opt" data-name="${_esc(k.name)}" style="
        padding:7px 12px;cursor:pointer;
        border-bottom:1px solid var(--color-cream-line)22;
      ">
        <div style="color:var(--color-ink)">${_esc(k.name)}</div>
        ${k.title ? `<div style="font-size:10px;color:var(--color-ink-faint);margin-top:1px">${_esc(k.title)}</div>` : ""}
      </div>`).join("");
    dropdown.querySelectorAll(".kn-opt").forEach(opt => {
      opt.addEventListener("mouseenter", () => { opt.style.background = "var(--color-panel)"; });
      opt.addEventListener("mouseleave", () => { opt.style.background = ""; });
      opt.addEventListener("mousedown", (e) => {
        e.preventDefault();
        _addKnowledgeChip(container, opt.dataset.name, setDirty);
        knInput.value = "";
        dropdown.style.display = "none";
      });
    });
  };

  knInput.addEventListener("focus", () => showDropdown(knInput.value, true));
  knInput.addEventListener("input", () => showDropdown(knInput.value));
  knInput.addEventListener("blur", () => setTimeout(() => { dropdown.style.display = "none"; }, 160));
  knInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const val = knInput.value.trim().replace(/,$/, "");
      if (val) { _addKnowledgeChip(container, val, setDirty); knInput.value = ""; }
      dropdown.style.display = "none";
    }
    if (e.key === "Escape") { dropdown.style.display = "none"; }
  });
}

function _addKnowledgeChip(container, name, setDirty) {
  const knInput = container.querySelector("#fm-kn-input");
  if (!knInput) return;
  const existing = [...container.querySelectorAll(".chip")]
    .map(c => c.textContent.trim().replace("×", "").trim());
  if (existing.includes(name)) return;
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.innerHTML = `${_esc(name)}<button class="chip-remove" onclick="this.parentElement.remove()">×</button>`;
  knInput.before(chip);
  if (setDirty) setDirty(true);
}

// ── Stats bar ──────────────────────────────────────────────────────────────

function _updateStats(container) {
  const el = container.querySelector("#ed-stats");
  if (!el || !_editor) return;
  const body = _editor.getValue();
  const words = body.match(/\S+/g)?.length || 0;
  const tokens = Math.ceil(body.length / 4);
  el.textContent = `${words.toLocaleString()} words · ~${tokens.toLocaleString()} tokens`;
}

// ── Default constitution ───────────────────────────────────────────────────

function _defaultConstitution(agent) {
  return `---\nname: ${agent.name}\nlayer: ${agent.layer}\nmodel: ${agent.model || "claude-sonnet-4-6"}\nknowledge: []\n---\n\nYou are the ${agent.name}.\n\n## Role\n\nDescribe this agent's role and responsibilities here.\n`;
}

// ── CodeMirror editor ──────────────────────────────────────────────────────

function _getBodyFromContent(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1] : content;
}

function _initEditor(container, content, onChange) {
  const cmEl = container.querySelector("#ed-cm");
  cmEl.innerHTML = '<textarea id="ed-textarea"></textarea>';
  const body = _getBodyFromContent(content);

  if (typeof CodeMirror === "undefined") {
    cmEl.querySelector("textarea").value = body;
    return;
  }

  _editor = CodeMirror.fromTextArea(cmEl.querySelector("#ed-textarea"), {
    mode: "markdown",
    theme: "swarmwright",
    lineNumbers: true,
    lineWrapping: true,
    autofocus: false,
    styleActiveLine: true,
    readOnly: canDo("can_edit_constitution") ? false : "nocursor",
    extraKeys: { "Ctrl-Space": "autocomplete" },
  });
  _editor.setValue(body);
  _editor.on("change", () => {
    onChange();
    _updatePreview(container);
    _updateStats(container);
  });
  _editor.setSize("100%", "100%");
  setTimeout(() => _editor.refresh(), 50);
  _updatePreview(container);
  _updateStats(container);
}

function _resetEditor(content, container) {
  const body = _getBodyFromContent(content);
  if (_editor) _editor.setValue(body);
  // Re-use models cached on the form element to avoid a second fetch
  const form = container.querySelector("#ed-fm-form");
  const cached = form?._cachedModels || [];
  _buildFrontmatterForm(container, content, {}, null, cached);
  _updatePreview(container);
}

function _getFullContent(container) {
  const form = container.querySelector("#ed-fm-form");
  const layer      = form.querySelector("#fm-layer")?.value || "executioner";
  const model      = form.querySelector("#fm-model")?.value || "claude-sonnet-4-6";
  const knChips    = [...form.querySelectorAll(".chip")].map(c => c.textContent.trim().replace("×", "").trim());
  const name       = container.querySelector("#ed-crumb-name")?.textContent.trim() || "";
  const wsOn       = form.querySelector("#fm-web-search")?.checked;
  const inheritable = (form.querySelector("#fm-inheritable")?.value || "").trim();
  const knYaml     = knChips.length ? `knowledge:\n${knChips.map(k => `  - ${k}`).join("\n")}` : "knowledge: []";
  const inhYaml    = inheritable
    ? (inheritable.includes("\n")
        ? `inheritable: |\n${inheritable.split("\n").map(l => `  ${l}`).join("\n")}`
        : `inheritable: ${inheritable}`)
    : "";
  const fm = `---\nname: ${name}\nlayer: ${layer}\nmodel: ${model}\n${knYaml}${wsOn ? "\nweb_search: true" : ""}${inhYaml ? "\n" + inhYaml : ""}\n---\n`;
  const body = _editor ? _editor.getValue() : "";
  return fm + body;
}

function _updatePreview(container) {
  const preview = container.querySelector("#ed-preview");
  if (!preview) return;
  preview.innerHTML = renderMarkdown(_editor ? _editor.getValue() : "");
}

// ── Frontmatter parser ─────────────────────────────────────────────────────

function _parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  try {
    const lines = match[1].split("\n");
    const obj = {};
    let currentKey = null;
    let blockScalar = false;
    for (const line of lines) {
      if (blockScalar) {
        if (line.match(/^\s+/)) {
          obj[currentKey] = (obj[currentKey] ? obj[currentKey] + "\n" : "") + line.trim();
          continue;
        }
        blockScalar = false;
      }
      const kv = line.match(/^(\w+):\s*(.*)/);
      if (kv) {
        currentKey = kv[1];
        const val = kv[2].trim();
        if (val === "|" || val === ">") {
          obj[currentKey] = "";
          blockScalar = true;
        } else if (val === "[]") { obj[currentKey] = []; }
        else if (val) { obj[currentKey] = val.replace(/^['"]|['"]$/g, ""); }
        else { obj[currentKey] = []; }
      } else if (line.match(/^\s+-\s+(.+)/) && currentKey) {
        if (!Array.isArray(obj[currentKey])) obj[currentKey] = [];
        obj[currentKey].push(line.match(/^\s+-\s+(.*)/)[1].trim());
      }
    }
    return obj;
  } catch (_) { return {}; }
}

// ── Diff helpers ───────────────────────────────────────────────────────────

function _computeLineDiff(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length, n = b.length;
  const dp = Array.from({length: m + 1}, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);

  const result = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      result.unshift({ type: "eq",  text: a[i-1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      result.unshift({ type: "add", text: b[j-1] }); j--;
    } else {
      result.unshift({ type: "del", text: a[i-1] }); i--;
    }
  }
  return result;
}

function _showDiffModal(oldContent, newContent, onConfirm) {
  const diff = _computeLineDiff(oldContent, newContent);

  // Collapse long runs of unchanged lines (keep 3 context lines each side)
  const CONTEXT = 3;
  const changed = new Set();
  diff.forEach((d, i) => { if (d.type !== "eq") changed.add(i); });
  const visible = new Set();
  changed.forEach(i => {
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(diff.length - 1, i + CONTEXT); k++)
      visible.add(k);
  });

  const linesHtml = [];
  let collapsed = 0;
  diff.forEach((d, i) => {
    if (!visible.has(i)) { collapsed++; return; }
    if (collapsed > 0) {
      linesHtml.push(`<div style="
        font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint);
        background:var(--color-surface);padding:2px 10px;
        border-top:1px dashed var(--color-cream-line);
        border-bottom:1px dashed var(--color-cream-line);
        user-select:none;
      ">··· ${collapsed} unchanged line${collapsed > 1 ? "s" : ""}</div>`);
      collapsed = 0;
    }
    const bg  = d.type === "add" ? "rgba(50,160,80,.12)"  : d.type === "del" ? "rgba(200,50,50,.10)"  : "";
    const col = d.type === "add" ? "var(--color-success)" : d.type === "del" ? "var(--color-danger)"  : "var(--color-ink-faint)";
    const pfx = d.type === "add" ? "+"                    : d.type === "del" ? "−"                    : " ";
    linesHtml.push(`<div style="
      display:flex;gap:0;background:${bg};
      border-left:3px solid ${d.type === "eq" ? "transparent" : col};
    ">
      <span style="
        font-family:var(--font-mono);font-size:11px;
        color:${col};flex-shrink:0;width:20px;text-align:center;
        padding:1px 0;user-select:none;
      ">${pfx}</span>
      <pre style="
        font-family:var(--font-mono);font-size:11px;
        color:${d.type === "eq" ? "var(--color-ink-soft)" : "var(--color-ink)"};
        margin:0;padding:1px 8px;white-space:pre-wrap;word-break:break-all;flex:1;
      ">${_esc(d.text)}</pre>
    </div>`);
  });
  if (collapsed > 0) {
    linesHtml.push(`<div style="
      font-family:var(--font-mono);font-size:11px;color:var(--color-ink-faint);
      background:var(--color-surface);padding:2px 10px;
      border-top:1px dashed var(--color-cream-line);
    ">··· ${collapsed} unchanged line${collapsed > 1 ? "s" : ""}</div>`);
  }

  const added   = diff.filter(d => d.type === "add").length;
  const removed = diff.filter(d => d.type === "del").length;

  const body = `
    <div style="
      font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint);
      margin-bottom:10px;display:flex;gap:12px;
    ">
      <span style="color:var(--color-success)">+${added} added</span>
      <span style="color:var(--color-danger)">−${removed} removed</span>
    </div>
    <div style="
      border:1px solid var(--color-cream-line);border-radius:5px;
      overflow-y:auto;max-height:55vh;background:var(--color-bg);
    ">
      ${linesHtml.join("")}
    </div>`;

  _showModal("Review changes", body, onConfirm, "Save");
}

// ── Utils ──────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function _cap(str) { return str.charAt(0).toUpperCase() + str.slice(1); }
