import * as api from "../api.js";
import { toast, toastError, toastSuccess } from "../components/toast.js";
import { setLastAgent } from "../app.js";
import { _showModal } from "./org-design.js";
import { _showAttachSkillModal } from "./swarm-canvas.js";

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
      <span class="crumb-here" id="ed-crumb-name">…</span>
    </div>

    <!-- Toolbar -->
    <div style="
      padding:8px 20px;border-bottom:1px solid var(--color-border-soft);
      background:var(--color-surface);display:flex;align-items:center;
      justify-content:space-between;flex-shrink:0;gap:12px;
    ">
      <div style="display:flex;align-items:center;gap:8px;font-family:var(--font-mono);font-size:12px;overflow:hidden">
        <span id="ed-dirty-dot" style="
          width:8px;height:8px;border-radius:50%;
          background:var(--color-text-muted);display:inline-block;
          flex-shrink:0;opacity:0;transition:opacity .2s;
        " title="Unsaved changes"></span>
        <span id="ed-filename" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">…</span>
        <span id="ed-stats" style="
          color:var(--color-ink-faint);font-size:10px;white-space:nowrap;
          border-left:1px solid var(--color-cream-line);padding-left:8px;
        "></span>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-ghost btn-sm" id="btn-draft" style="font-size:11px">✦ Draft</button>
        <button class="btn btn-ghost btn-sm" id="btn-discard" style="font-size:11px">Discard</button>
        <button class="btn btn-primary btn-sm" id="btn-save" style="font-size:11px">Save  ⌘S</button>
      </div>
    </div>

    <!-- Body -->
    <div style="flex:1;display:grid;grid-template-columns:1fr 1fr;overflow:hidden">

      <!-- ── Left: form + editor ── -->
      <div style="display:flex;flex-direction:column;border-right:1px solid var(--color-border-soft);overflow:hidden">

        <!-- Frontmatter -->
        <div style="padding:12px 16px;border-bottom:1px solid var(--color-border-soft);background:var(--color-bg);flex-shrink:0">
          <div class="sec-header" style="margin-bottom:10px">Frontmatter</div>
          <div id="ed-fm-form"></div>
        </div>

        <!-- Skills -->
        <div style="padding:12px 16px;border-bottom:1px solid var(--color-border-soft);background:var(--color-bg);flex-shrink:0;max-height:28%;overflow-y:auto">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div class="sec-header" style="margin:0">Skills</div>
            <button class="btn btn-secondary btn-sm" id="ed-attach-skill" style="font-size:11px">+ Attach</button>
          </div>
          <div style="font-size:10px;color:var(--color-ink-faint);font-family:var(--font-mono);margin-bottom:6px;line-height:1.4">
            Stored in <code>hierarchy.json</code>, not the constitution.
          </div>
          <div id="ed-skills-list"></div>
        </div>

        <!-- Swarm agents reference panel (populated when swarm_id is known) -->
        <div id="ed-swarm-agents" style="display:none;border-bottom:1px solid var(--color-border-soft);background:var(--color-bg);flex-shrink:0">
          <div style="
            display:flex;align-items:center;justify-content:space-between;
            padding:6px 16px;cursor:pointer;user-select:none;
          " id="ed-swarm-agents-hdr">
            <div class="sec-header" style="margin:0">Swarm agents</div>
            <span id="ed-swarm-agents-arrow" style="font-size:10px;color:var(--color-ink-faint)">▾</span>
          </div>
          <div id="ed-swarm-agents-body" style="padding:0 16px 8px;max-height:140px;overflow-y:auto">
            <div id="ed-swarm-agents-list"></div>
          </div>
        </div>

        <!-- Section scaffold -->
        <div style="
          padding:5px 16px;border-bottom:1px solid var(--color-border-soft);
          background:var(--color-panel);display:flex;align-items:center;
          gap:4px;flex-wrap:wrap;flex-shrink:0;
        ">
          <span style="font-family:var(--font-mono);font-size:9px;color:var(--color-ink-faint);letter-spacing:.06em;text-transform:uppercase;margin-right:2px">Insert</span>
          ${["Role","Responsibilities","Behavior","Output Format","Constraints"].map(s =>
            `<button class="btn btn-ghost btn-sm scaffold-btn" data-section="${s}" style="font-size:10px;padding:2px 8px;letter-spacing:0">${s}</button>`
          ).join("")}
          <span style="display:inline-block;width:1px;height:14px;background:var(--color-cream-line);margin:0 4px;vertical-align:middle"></span>
          <button class="btn btn-ghost btn-sm" id="btn-insert-action" style="font-size:10px;padding:2px 8px;letter-spacing:0">↗ Action</button>
        </div>

        <!-- Action insert popover -->
        <div id="ed-action-popover" style="display:none;padding:10px 16px;border-bottom:1px solid var(--color-border-soft);background:var(--color-surface);flex-shrink:0">
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
            <button class="btn btn-ghost btn-sm" id="ap-cancel" style="font-size:11px">Cancel</button>
            <button class="btn btn-primary btn-sm" id="ap-insert" style="font-size:11px">Insert snippet</button>
          </div>
        </div>

        <!-- CodeMirror -->
        <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
          <div id="ed-cm" style="flex:1;overflow:hidden"></div>
        </div>
      </div>

      <!-- ── Right: preview + context ── -->
      <div style="display:flex;flex-direction:column;overflow:hidden">
        <div style="
          display:flex;gap:0;padding:0 20px;
          border-bottom:1px solid var(--color-border-soft);
          background:var(--color-surface);flex-shrink:0;
        ">
          <button id="tab-preview" class="topbar-tab active" style="font-size:12px;padding:8px 14px">Preview</button>
          <button id="tab-context" class="topbar-tab" style="font-size:12px;padding:8px 14px">Context</button>
        </div>
        <div id="panel-preview" style="flex:1;overflow-y:auto;padding:20px 24px;background:var(--color-bg)">
          <div id="ed-preview" style="line-height:1.7;font-size:13px;color:var(--color-text)"></div>
        </div>
        <div id="panel-context" style="flex:1;overflow-y:auto;padding:20px 24px;background:var(--color-bg);display:none">
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
  const save = async () => {
    if (!_editor) return;
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
      "✦ Draft constitution",
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
        btn.textContent = "✦ Drafting…";
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
        finally { btn.textContent = "✦ Draft"; btn.disabled = false; }
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
      <label class="form-label">Name</label>
      <input class="form-input readonly" value="${_esc(fm.name || agent.name)}" readonly>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="form-group" style="margin-bottom:8px">
        <label class="form-label">Layer</label>
        <select class="form-select" id="fm-layer">
          ${["policy","orchestrator","executioner","perceptionist"].map(l =>
            `<option value="${l}" ${(fm.layer || agent.layer) === l ? "selected" : ""}>${_cap(l)}</option>`).join("")}
        </select>
      </div>
      <div class="form-group" style="margin-bottom:8px">
        <label class="form-label">Model</label>
        <select class="form-select" id="fm-model">
          ${allModels.map(m =>
            `<option value="${_esc(m.id)}" ${currentModel === m.id ? "selected" : ""}>${_esc(m.display_name || m.id)}</option>`
          ).join("")}
        </select>
      </div>
    </div>
    <div class="form-group" style="margin-bottom:0;position:relative">
      <label class="form-label">Knowledge</label>
      <div class="form-chips" id="fm-knowledge" style="position:relative">
        ${(fm.knowledge || []).map(k => `<span class="chip">${_esc(k)}<button class="chip-remove" onclick="this.parentElement.remove()">×</button></span>`).join("")}
        <input style="border:none;outline:none;font-size:11px;min-width:80px;flex:1" id="fm-kn-input" placeholder="+ add" autocomplete="off">
      </div>
    </div>
    <div class="form-group" style="margin-bottom:0;margin-top:10px;display:flex;align-items:center;gap:8px">
      <label class="toggle-switch">
        <input type="checkbox" id="fm-web-search" ${(fm.web_search === "true" || fm.web_search === true) ? "checked" : ""}>
        <span class="toggle-slider"></span>
      </label>
      <span class="form-label" style="margin-bottom:0">Web Search</span>
    </div>`;

  // Cache models list on form element so _resetEditor can re-use it
  form._cachedModels = configuredModels;

  // Layer / model / web-search changes mark dirty
  form.querySelector("#fm-layer")?.addEventListener("change", () => setDirty && setDirty(true));
  form.querySelector("#fm-model")?.addEventListener("change", () => setDirty && setDirty(true));
  form.querySelector("#fm-web-search")?.addEventListener("change", () => setDirty && setDirty(true));

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

  const showDropdown = (query) => {
    if (!query.trim()) { dropdown.style.display = "none"; return; }
    const q = query.toLowerCase();
    const matches = items
      .filter(k => k.name.toLowerCase().includes(q) || (k.title || "").toLowerCase().includes(q))
      .slice(0, 8);
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
  const layer   = form.querySelector("#fm-layer")?.value || "executioner";
  const model   = form.querySelector("#fm-model")?.value || "claude-sonnet-4-6";
  const knChips = [...form.querySelectorAll(".chip")].map(c => c.textContent.trim().replace("×", "").trim());
  const name    = form.querySelector("input[readonly]")?.value || "";
  const wsOn    = form.querySelector("#fm-web-search")?.checked;
  const knYaml  = knChips.length ? `knowledge:\n${knChips.map(k => `  - ${k}`).join("\n")}` : "knowledge: []";
  const fm      = `---\nname: ${name}\nlayer: ${layer}\nmodel: ${model}\n${knYaml}${wsOn ? "\nweb_search: true" : ""}\n---\n`;
  const body    = _editor ? _editor.getValue() : "";
  return fm + body;
}

function _updatePreview(container) {
  const preview = container.querySelector("#ed-preview");
  if (!preview || typeof marked === "undefined") return;
  preview.innerHTML = marked.parse(_editor ? _editor.getValue() : "");
}

// ── Frontmatter parser ─────────────────────────────────────────────────────

function _parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  try {
    const lines = match[1].split("\n");
    const obj = {};
    let currentKey = null;
    for (const line of lines) {
      const kv = line.match(/^(\w+):\s*(.*)/);
      if (kv) {
        currentKey = kv[1];
        const val = kv[2].trim();
        if (val === "[]") { obj[currentKey] = []; }
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

// ── Utils ──────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function _cap(str) { return str.charAt(0).toUpperCase() + str.slice(1); }
