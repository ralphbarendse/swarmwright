import * as api from "../api.js";
import { toast, toastError, toastSuccess } from "../components/toast.js";
import { setLastAgent } from "../app.js";
import { _showAttachSkillModal } from "./swarm-canvas.js";

let _editor = null;

export function renderConstitutionEditor(container, agentId) {
  if (!agentId) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-title">No agent selected</div><div class="empty-state-sub">Open an agent from the Swarm canvas.</div></div>`;
    return null;
  }
  setLastAgent(agentId);

  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.height = "100%";
  container.style.overflow = "hidden";

  container.innerHTML = `
    <div class="crumbs" id="ed-crumbs">
      <span class="crumb-link" onclick="swNav('org')">Workspaces</span>
      <span class="crumb-sep">›</span>
      <span class="crumb-here" id="ed-crumb-name">…</span>
    </div>
    <div style="padding:10px 24px;border-bottom:1px solid var(--color-border-soft);background:var(--color-surface);display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
      <div style="display:flex;align-items:center;gap:10px;font-family:var(--font-mono);font-size:12px">
        <span id="ed-dirty-dot" style="width:8px;height:8px;border-radius:50%;background:var(--color-text-muted);display:inline-block;opacity:0" title="Unsaved changes"></span>
        <span id="ed-filename">…</span>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" id="btn-history">History</button>
        <button class="btn btn-ghost btn-sm" id="btn-discard">Discard</button>
        <button class="btn btn-primary btn-sm" id="btn-save">Save  ⌘S</button>
      </div>
    </div>
    <div style="flex:1;display:grid;grid-template-columns:1fr 1fr;overflow:hidden">
      <div style="display:flex;flex-direction:column;border-right:1px solid var(--color-border-soft);overflow:hidden">
        <div style="padding:12px 16px;border-bottom:1px solid var(--color-border-soft);background:var(--color-bg);flex-shrink:0">
          <div class="sec-header" style="margin-bottom:10px">Frontmatter</div>
          <div id="ed-fm-form"></div>
        </div>
        <div style="padding:12px 16px;border-bottom:1px solid var(--color-border-soft);background:var(--color-bg);flex-shrink:0;max-height:30%;overflow-y:auto">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div class="sec-header" style="margin:0">Skills used by this agent</div>
            <button class="btn btn-secondary btn-sm" id="ed-attach-skill">+ Attach skill</button>
          </div>
          <div style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono);margin-bottom:8px;line-height:1.5">
            Stored in <code>hierarchy.json</code>, not the constitution. Each connection records a purpose for the audit trail.
          </div>
          <div id="ed-skills-list"></div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
          <div style="padding:8px 16px;border-bottom:1px solid var(--color-border-soft);background:var(--color-bg);flex-shrink:0">
            <div class="sec-header" style="margin:0">Constitution body</div>
          </div>
          <div id="ed-cm" style="flex:1;overflow:hidden"></div>
        </div>
      </div>
      <div style="overflow-y:auto;padding:20px 24px;background:var(--color-bg)">
        <div class="sec-header" style="margin-bottom:12px">Preview</div>
        <div id="ed-preview" style="line-height:1.7;font-size:13px;color:var(--color-text)"></div>
      </div>
    </div>`;

  let _originalContent = "";
  let _dirty = false;

  const dirtyDot = container.querySelector("#ed-dirty-dot");
  const setDirty = (v) => { _dirty = v; dirtyDot.style.opacity = v ? "1" : "0"; dirtyDot.style.background = v ? "var(--color-amber)" : "var(--color-text-muted)"; };

  _load(container, agentId, (content) => {
    _originalContent = content;
    _initEditor(container, content, () => setDirty(true));
  });

  // Save
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
  container.querySelector("#btn-discard").addEventListener("click", () => {
    if (!_dirty) return;
    if (!confirm("Discard unsaved changes?")) return;
    _resetEditor(_originalContent, container);
    setDirty(false);
  });

  document.addEventListener("keydown", _kbdSave);
  function _kbdSave(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
  }

  // History button
  container.querySelector("#btn-history").addEventListener("click", async () => {
    try {
      const history = await api.getAgentHistory(agentId);
      if (!history.length) { toast("No history yet"); return; }
      // Simple history display — show list in a modal
      const { _showModal } = await import("./org-design.js");
      _showModal("Constitution history", `
        <div style="font-size:12px">
          ${history.map(h => `<div style="padding:6px 0;border-bottom:1px solid var(--color-border-soft);font-family:var(--font-mono)">${h.timestamp}</div>`).join("")}
        </div>`, async () => {});
    } catch (err) { toastError(err); }
  });

  return () => {
    document.removeEventListener("keydown", _kbdSave);
    if (_editor) { _editor.toTextArea?.(); _editor = null; }
  };
}

// ── Load agent data ────────────────────────────────────────────────────────

async function _load(container, agentId, onContent) {
  try {
    const agent = await api.getAgent(agentId);
    container.querySelector("#ed-crumb-name").textContent = agent.name;
    container.querySelector("#ed-filename").textContent = `${agent.name}.md`;

    const content = agent.constitution || _defaultConstitution(agent);
    _buildFrontmatterForm(container, content, agent);
    onContent(content);

    if (agent.swarm_id) {
      _wireSkillsPanel(container, agent);
      _refreshSkillsPanel(container, agent);
    }
  } catch (err) { toastError(err); }
}

// ── Skills panel (reads/writes hierarchy.json, NOT the constitution) ──────

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
      list.innerHTML = `<div style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono);padding:6px 0">No skills attached yet.</div>`;
      return;
    }
    list.innerHTML = mine.map(s => `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border:1px solid var(--color-cream-line);border-radius:6px;background:var(--color-card);margin-bottom:4px">
        <div style="flex:1;min-width:0">
          <div style="font-family:var(--font-mono);font-size:12px;color:var(--color-ink)">${_esc(s.skill)}</div>
          <div style="font-size:10px;color:var(--color-ink-soft);font-style:italic;margin-top:2px">"${_esc(s.purpose || "")}"</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-skill="${_esc(s.skill)}">Detach</button>
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

function _defaultConstitution(agent) {
  return `---\nname: ${agent.name}\nlayer: ${agent.layer}\nmodel: ${agent.model || "claude-sonnet-4-6"}\nknowledge: []\n---\n\nYou are the ${agent.name}.\n\n## Role\n\nDescribe this agent's role and responsibilities here.\n`;
}

// ── Frontmatter form ───────────────────────────────────────────────────────

function _buildFrontmatterForm(container, content, agent) {
  const fm = _parseFrontmatter(content);
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
          ${["claude-sonnet-4-6","claude-opus-4-7","claude-haiku-4-5-20251001"].map(m =>
            `<option value="${m}" ${(fm.model || agent.model) === m ? "selected" : ""}>${m.split("-").slice(1, 3).join(" ")}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="form-group" style="margin-bottom:0">
      <label class="form-label">Knowledge</label>
      <div class="form-chips" id="fm-knowledge">
        ${(fm.knowledge || []).map(k => `<span class="chip">${_esc(k)}<button class="chip-remove" onclick="this.parentElement.remove()">×</button></span>`).join("")}
        <input style="border:none;outline:none;font-size:11px;min-width:80px;flex:1" id="fm-kn-input" placeholder="+ add">
      </div>
    </div>`;

  const knInput = form.querySelector("#fm-kn-input");
  knInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const val = knInput.value.trim().replace(/,$/, "");
      if (val) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.innerHTML = `${_esc(val)}<button class="chip-remove" onclick="this.parentElement.remove()">×</button>`;
        knInput.before(chip);
        knInput.value = "";
      }
    }
  });
}

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
    theme: "default",
    lineNumbers: true,
    lineWrapping: true,
    autofocus: false,
    extraKeys: { "Ctrl-Space": "autocomplete" },
  });
  _editor.setValue(body);
  _editor.on("change", () => {
    onChange();
    _updatePreview(container);
  });
  _editor.setSize("100%", "100%");
  setTimeout(() => _editor.refresh(), 50);
  _updatePreview(container);
}

function _resetEditor(content, container) {
  const body = _getBodyFromContent(content);
  if (_editor) _editor.setValue(body);
  _buildFrontmatterForm(container, content, {});
  _updatePreview(container);
}

function _getFullContent(container) {
  // Rebuild frontmatter from form
  const form = container.querySelector("#ed-fm-form");
  const layer  = form.querySelector("#fm-layer")?.value || "executioner";
  const model  = form.querySelector("#fm-model")?.value || "claude-sonnet-4-6";
  const knChips = [...form.querySelectorAll(".chip")].map(c => c.textContent.trim().replace("×", "").trim());
  const name = form.querySelector("input[readonly]")?.value || "";
  const knYaml = knChips.length ? `knowledge:\n${knChips.map(k => `  - ${k}`).join("\n")}` : "knowledge: []";

  const fm = `---\nname: ${name}\nlayer: ${layer}\nmodel: ${model}\n${knYaml}\n---\n`;
  const body = _editor ? _editor.getValue() : "";
  return fm + body;
}

function _updatePreview(container) {
  const preview = container.querySelector("#ed-preview");
  if (!preview || typeof marked === "undefined") return;
  const body = _editor ? _editor.getValue() : "";
  preview.innerHTML = marked.parse(body);
}

// ── Utils ──────────────────────────────────────────────────────────────────

function _esc(str) { return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function _cap(str) { return str.charAt(0).toUpperCase() + str.slice(1); }
