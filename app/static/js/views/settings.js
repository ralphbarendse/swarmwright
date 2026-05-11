import * as api from "../api.js";
import { toastError, toastSuccess } from "../components/toast.js";
import { _showModal } from "./org-design.js";

/**
 * Settings view — Phase 5.
 *
 * Routes:
 *   settings                 → providers (default)
 *   settings/providers
 *   settings/models
 *   settings/branding        (Round B)
 *   settings/system
 *   settings/security        (Round B)
 *
 * Per spec, providers come first because nothing functional works without
 * credentials; security comes last because most users will rarely touch it.
 */

const TABS = [
  { id: "providers", label: "LLM Providers" },
  { id: "models",    label: "Models" },
  { id: "branding",  label: "Branding" },
  { id: "system",    label: "System" },
  { id: "security",  label: "Security" },
];

const RESTART_REQUIRED_KEYS = new Set([
  "system.scheduler_timezone",
  "system.log_level",
]);

const DEFAULT_PACKAGES = [
  "requests", "pypdf", "pdfplumber", "pandas", "openpyxl", "lxml", "beautifulsoup4",
];

const PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic",
    accent: "var(--color-policy)",
    keyPrefix: "sk-ant-",
    keySetting: "llm.anthropic.api_key",
  },
  {
    id: "openai",
    label: "OpenAI",
    accent: "var(--color-orchestrator)",
    keyPrefix: "sk-",
    keySetting: "llm.openai.api_key",
  },
];

// ── Module-scoped settings cache ─────────────────────────────────────────────
//
// Per spec line 282: "The frontend should call GET /api/v1/settings once on
// app load and cache the result, refreshing only after a known mutation."
let _cache = null;
let _cachePromise = null;

async function _loadSettings(force = false) {
  if (!force && _cache) return _cache;
  if (_cachePromise) return _cachePromise;
  _cachePromise = api.listSettings().then(rows => {
    _cache = new Map(rows.map(r => [r.key, r]));
    _cachePromise = null;
    return _cache;
  }).catch(err => {
    _cachePromise = null;
    throw err;
  });
  return _cachePromise;
}

function _invalidate() {
  _cache = null;
  _cachePromise = null;
}

function _get(key) {
  return _cache?.get(key) ?? null;
}

// ── Restart-required tracking ────────────────────────────────────────────────
// Set of keys whose value changed since this view was opened.
let _pendingRestart = new Set();

function _markChanged(key) {
  if (RESTART_REQUIRED_KEYS.has(key)) {
    _pendingRestart.add(key);
    _renderRestartBanner();
  }
}

function _renderRestartBanner() {
  const banner = document.getElementById("settings-restart-banner");
  if (!banner) return;
  if (_pendingRestart.size === 0) {
    banner.style.display = "none";
    banner.innerHTML = "";
    return;
  }
  const keys = [..._pendingRestart].join(", ");
  banner.style.display = "";
  banner.innerHTML = `
    <span style="font-weight:600">Restart required</span>
    <span style="color:var(--color-ink-soft);margin-left:8px">
      Container restart needed for these changes to take effect: <code>${_esc(keys)}</code>
    </span>`;
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function renderSettingsView(container, segments = []) {
  const tab = segments[0] || "providers";

  container.style.overflowY = "hidden";
  container.style.height = "100%";
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden">
      <div class="page-header" style="flex-shrink:0">
        <div class="page-title">Settings</div>
        <div class="page-sub">Credentials, models, branding, and operational defaults.</div>
      </div>
      <div id="settings-restart-banner"
           class="card"
           style="display:none;margin:0 24px 0 24px;padding:10px 14px;border-color:var(--color-warn);background:rgba(201,124,42,.08);font-size:12px;flex-shrink:0">
      </div>
      <div style="display:flex;gap:0;border-bottom:1px dashed var(--color-cream-line);padding:0 24px;flex-shrink:0;margin-top:12px"
           id="settings-tabs">
        ${TABS.map(t => `
          <button class="topbar-tab ${t.id === tab ? "active" : ""}"
                  data-tab="${t.id}"
                  style="font-size:13px;padding:8px 16px">${_esc(t.label)}</button>`).join("")}
      </div>
      <div style="flex:1;overflow-y:auto;padding:24px" id="settings-pane"></div>
    </div>`;

  container.querySelector("#settings-tabs").addEventListener("click", e => {
    const btn = e.target.closest("[data-tab]");
    if (!btn) return;
    window.swNav("settings/" + btn.dataset.tab);
  });

  _renderRestartBanner();

  const pane = container.querySelector("#settings-pane");
  pane.innerHTML = `<div style="color:var(--color-ink-faint);font-family:var(--font-mono);font-size:12px">Loading settings…</div>`;

  _loadSettings().then(() => {
    pane.innerHTML = "";
    switch (tab) {
      case "providers": _renderProvidersTab(pane); break;
      case "models":    _renderModelsTab(pane); break;
      case "branding":  _renderBrandingTab(pane); break;
      case "system":    _renderSystemTab(pane); break;
      case "security":  _renderSecurityTab(pane); break;
      default:          _renderProvidersTab(pane);
    }
  }).catch(err => {
    pane.innerHTML = "";
    toastError(err);
    _renderEmpty(pane, "Could not load settings", err.message || "");
  });

  return null;
}

// ── Providers tab ────────────────────────────────────────────────────────────

function _renderProvidersTab(pane) {
  const defaultProvider = _get("llm.default_provider")?.value || "anthropic";

  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:14px;max-width:760px";
  pane.appendChild(wrap);

  PROVIDERS.forEach(p => wrap.appendChild(_makeProviderCard(p, defaultProvider)));
}

function _makeProviderCard(provider, defaultProvider) {
  const setting = _get(provider.keySetting);
  const masked = setting?.value || "";
  const hasKey = !!masked;
  const isDefault = defaultProvider === provider.id;

  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "padding:18px 20px;display:flex;flex-direction:column;gap:14px";

  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <span class="provider-status-dot" data-status="${hasKey ? "untested" : "missing"}"
            style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${hasKey ? "var(--color-warn)" : "var(--color-ink-faint)"}"></span>
      <div style="font-weight:600;color:${provider.accent};font-size:14px">${_esc(provider.label)}</div>
      <div style="flex:1"></div>
      <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--color-ink-soft);font-family:var(--font-mono);cursor:pointer">
        <input type="radio" name="default-provider" data-provider="${provider.id}" ${isDefault ? "checked" : ""}>
        Set as default
      </label>
    </div>

    <div>
      <div style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">API key</div>
      <div style="display:flex;gap:8px;align-items:center">
        <code class="provider-key-display"
              style="flex:1;padding:8px 10px;background:var(--color-cream-deep);border-radius:4px;font-family:var(--font-mono);font-size:12px;color:${hasKey ? "var(--color-ink)" : "var(--color-ink-faint)"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(masked) || "(not configured)"}</code>
        <button class="btn btn-ghost btn-sm" data-action="edit">${hasKey ? "Replace" : "Add"}</button>
      </div>
      <div class="provider-edit-row" style="display:none;margin-top:8px">
        <div style="display:flex;gap:8px;align-items:center">
          <input class="form-input provider-key-input" type="password" autocomplete="off"
                 placeholder="${_esc(provider.keyPrefix)}…" style="flex:1;font-family:var(--font-mono)">
          <button class="btn btn-ghost btn-sm" data-action="cancel">Cancel</button>
          <button class="btn btn-ghost btn-sm" data-action="test">Test</button>
          <button class="btn btn-primary btn-sm" data-action="save">Save</button>
        </div>
        <div class="provider-test-msg" style="margin-top:6px;font-size:11px;font-family:var(--font-mono);color:var(--color-ink-faint);display:none"></div>
      </div>
    </div>`;

  const editBtn   = card.querySelector("[data-action=edit]");
  const editRow   = card.querySelector(".provider-edit-row");
  const cancelBtn = card.querySelector("[data-action=cancel]");
  const testBtn   = card.querySelector("[data-action=test]");
  const saveBtn   = card.querySelector("[data-action=save]");
  const input     = card.querySelector(".provider-key-input");
  const dot       = card.querySelector(".provider-status-dot");
  const msg       = card.querySelector(".provider-test-msg");
  const radio     = card.querySelector("input[type=radio]");

  const showMsg = (text, ok) => {
    msg.style.display = "";
    msg.textContent = text;
    msg.style.color = ok ? "var(--color-success)" : "var(--color-danger)";
  };

  editBtn.addEventListener("click", () => {
    editRow.style.display = "";
    input.value = "";
    input.focus();
  });

  cancelBtn.addEventListener("click", () => {
    if (input.value && !confirm("Discard the unsaved key?")) return;
    editRow.style.display = "none";
    msg.style.display = "none";
    input.value = "";
  });

  testBtn.addEventListener("click", async () => {
    const apiKey = input.value.trim();
    if (!apiKey) { showMsg("Enter a key first", false); return; }
    testBtn.disabled = true;
    msg.style.display = "";
    msg.style.color = "var(--color-ink-faint)";
    msg.textContent = "Testing connection…";
    try {
      const r = await api.testLlmConnection({ provider: provider.id, api_key: apiKey });
      if (r.ok) {
        showMsg("Connection successful", true);
        dot.style.background = "var(--color-success)";
        dot.dataset.status = "ok";
      } else {
        showMsg(r.message || "Connection failed", false);
        dot.style.background = "var(--color-danger)";
        dot.dataset.status = "failed";
      }
    } catch (err) {
      showMsg(err.message || "Connection failed", false);
      dot.style.background = "var(--color-danger)";
      dot.dataset.status = "failed";
    } finally {
      testBtn.disabled = false;
    }
  });

  saveBtn.addEventListener("click", async () => {
    const apiKey = input.value.trim();
    if (!apiKey) { showMsg("Enter a key first", false); return; }

    // Sanity check the prefix client-side. Server validates again.
    if (!apiKey.startsWith(provider.keyPrefix)) {
      showMsg(`Key should start with "${provider.keyPrefix}"`, false);
      return;
    }

    saveBtn.disabled = true;
    try {
      // Test first — failed connections must NOT be saved (spec line 137).
      const r = await api.testLlmConnection({ provider: provider.id, api_key: apiKey });
      if (!r.ok) {
        showMsg(r.message || "Connection failed — key not saved", false);
        dot.style.background = "var(--color-danger)";
        dot.dataset.status = "failed";
        return;
      }
      await api.putSetting(provider.keySetting, {
        value: apiKey,
        is_secret: true,
        value_type: "string",
      });
      _invalidate();
      toastSuccess(`${provider.label} key saved`);
      // Re-render the providers tab to refresh the masked display.
      const pane = document.getElementById("settings-pane");
      if (pane) {
        pane.innerHTML = "";
        await _loadSettings(true);
        _renderProvidersTab(pane);
      }
    } catch (err) {
      showMsg(err.message || "Save failed", false);
    } finally {
      saveBtn.disabled = false;
    }
  });

  radio.addEventListener("change", async () => {
    if (!radio.checked) return;
    try {
      await api.putSetting("llm.default_provider", {
        value: provider.id,
        value_type: "string",
        description: "Provider new agents use unless they override.",
      });
      _invalidate();
      toastSuccess(`Default provider set to ${provider.label}`);
    } catch (err) {
      toastError(err);
    }
  });

  return card;
}

// ── Models tab ───────────────────────────────────────────────────────────────

function _renderModelsTab(pane) {
  const models = _get("models.available")?.value || [];
  const defaultModel = _get("models.default")?.value || "";

  pane.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;max-width:960px">
      <div>
        <div class="sec-header" style="margin:0">Models</div>
        <div style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono);margin-top:4px">
          The set of models available to agents. Identifiers are not validated against provider catalogs — that fails at run time, by design.
        </div>
      </div>
      <button class="btn btn-primary btn-sm" id="btn-add-model">+ Add model</button>
    </div>
    <div id="models-table" style="max-width:960px"></div>`;

  pane.querySelector("#btn-add-model").addEventListener("click", () => _showAddModelModal());
  _drawModelsTable(pane.querySelector("#models-table"), models, defaultModel);
}

function _drawModelsTable(host, models, defaultModel) {
  if (!models.length) {
    host.innerHTML = `<div class="empty-state"><div class="empty-state-title">No models configured</div><div class="empty-state-sub">Click "+ Add model" to add a model identifier.</div></div>`;
    return;
  }

  host.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="text-align:left;border-bottom:1px solid var(--color-cream-line)">
          <th style="padding:8px 12px;font-family:var(--font-mono);font-size:11px;color:var(--color-ink-soft);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Display name</th>
          <th style="padding:8px 12px;font-family:var(--font-mono);font-size:11px;color:var(--color-ink-soft);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Identifier</th>
          <th style="padding:8px 12px;font-family:var(--font-mono);font-size:11px;color:var(--color-ink-soft);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Provider</th>
          <th style="padding:8px 12px;font-family:var(--font-mono);font-size:11px;color:var(--color-ink-soft);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Default</th>
          <th style="padding:8px 12px"></th>
        </tr>
      </thead>
      <tbody id="models-rows"></tbody>
    </table>`;

  const tbody = host.querySelector("#models-rows");
  models.forEach(m => {
    const tr = document.createElement("tr");
    tr.style.borderBottom = "1px dashed var(--color-cream-line)";
    tr.innerHTML = `
      <td style="padding:10px 12px">${_esc(m.display_name || m.id)}</td>
      <td style="padding:10px 12px"><code style="font-family:var(--font-mono);font-size:12px">${_esc(m.id)}</code></td>
      <td style="padding:10px 12px">${_esc(m.provider || "")}</td>
      <td style="padding:10px 12px">
        <input type="radio" name="default-model" ${defaultModel === m.id ? "checked" : ""} data-model="${_esc(m.id)}">
      </td>
      <td style="padding:10px 12px;text-align:right">
        <button class="btn btn-ghost btn-sm" data-action="remove" data-model="${_esc(m.id)}">Remove</button>
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.addEventListener("change", async e => {
    const radio = e.target.closest("input[type=radio][name=default-model]");
    if (!radio) return;
    try {
      await api.putSetting("models.default", {
        value: radio.dataset.model,
        value_type: "string",
        description: "Model new agents use when their constitution does not specify one.",
      });
      _invalidate();
      toastSuccess("Default model updated");
    } catch (err) { toastError(err); }
  });

  tbody.addEventListener("click", async e => {
    const btn = e.target.closest("[data-action=remove]");
    if (!btn) return;
    const id = btn.dataset.model;
    await _removeModel(id);
  });
}

function _showAddModelModal() {
  _showModal("Add model", `
    <div class="form-group">
      <label class="form-label">Identifier</label>
      <input class="form-input" id="m-model-id" placeholder="claude-opus-4-7">
      <div class="form-helper">Exact identifier the provider expects.</div>
    </div>
    <div class="form-group">
      <label class="form-label">Display name</label>
      <input class="form-input" id="m-model-display" placeholder="Claude Opus 4.7 (most capable)">
    </div>
    <div class="form-group">
      <label class="form-label">Provider</label>
      <select class="form-input" id="m-model-provider">
        ${PROVIDERS.map(p => `<option value="${p.id}">${_esc(p.label)}</option>`).join("")}
      </select>
    </div>`,
    async () => {
      const id = document.getElementById("m-model-id")?.value.trim();
      if (!id) throw { message: "Identifier is required" };
      const display_name = document.getElementById("m-model-display")?.value.trim() || id;
      const provider     = document.getElementById("m-model-provider")?.value || "anthropic";

      const existing = _get("models.available")?.value || [];
      if (existing.some(m => m.id === id)) throw { message: `Model "${id}" already configured` };
      const next = [...existing, { id, display_name, provider }];

      await api.putSetting("models.available", { value: next, value_type: "json" });
      _invalidate();
      toastSuccess("Model added");
      const pane = document.getElementById("settings-pane");
      if (pane) { pane.innerHTML = ""; await _loadSettings(true); _renderModelsTab(pane); }
    });
  setTimeout(() => document.getElementById("m-model-id")?.focus(), 50);
}

async function _removeModel(id) {
  // Spec line 167: removing a model with referenced agents must show a warning
  // listing the affected agents and offer a bulk replacement.
  let affected = [];
  try {
    affected = await _agentsUsingModel(id);
  } catch (_) { /* fall through; warning is best-effort */ }

  const others = (_get("models.available")?.value || []).filter(m => m.id !== id);

  if (affected.length === 0) {
    if (!confirm(`Remove model "${id}"?`)) return;
    await _writeModels(others);
    return;
  }

  // Show the warning modal listing affected agents + replacement picker.
  _showModal(`Remove "${id}"`, `
    <div style="margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:6px">${affected.length} agent${affected.length === 1 ? "" : "s"} reference this model</div>
      <ul style="margin:6px 0 0 18px;padding:0;font-size:12px;font-family:var(--font-mono);color:var(--color-ink-soft);max-height:160px;overflow-y:auto">
        ${affected.map(a => `<li>${_esc(a.swarm_name || "?")} / ${_esc(a.name)}</li>`).join("")}
      </ul>
    </div>
    <div class="form-group">
      <label class="form-label">Replace their model with</label>
      <select class="form-input" id="m-replace-model">
        <option value="">(leave their constitutions unchanged — they will fail at run time)</option>
        ${others.map(m => `<option value="${_esc(m.id)}">${_esc(m.display_name || m.id)}</option>`).join("")}
      </select>
    </div>`,
    async () => {
      const replacement = document.getElementById("m-replace-model")?.value || "";
      if (replacement) {
        // Best-effort bulk update: rewrite each constitution's `model:`
        // frontmatter field. We do this client-side by re-saving each
        // constitution with a regex replacement on the YAML frontmatter.
        await _bulkReplaceModelInAgents(affected, replacement);
      }
      await _writeModels(others);
    },
    "Remove");
}

async function _writeModels(models) {
  await api.putSetting("models.available", { value: models, value_type: "json" });
  _invalidate();
  toastSuccess("Model removed");
  const pane = document.getElementById("settings-pane");
  if (pane) { pane.innerHTML = ""; await _loadSettings(true); _renderModelsTab(pane); }
}

async function _agentsUsingModel(modelId) {
  // Walk all swarms via /workspaces → /workspaces/<id> (which embeds swarms),
  // then /swarms/<id>/agents per swarm. Match agents whose `model` equals
  // the target id. Phase 5 has no dedicated "agents-by-model" endpoint, so
  // this is a best-effort client-side sweep.
  const out = [];
  const workspaces = await api.listWorkspaces();
  for (const ws of workspaces) {
    let detailed;
    try { detailed = await api.getWorkspace(ws.id); } catch { continue; }
    for (const sw of (detailed.swarms || [])) {
      let agents = [];
      try { agents = await api.listAgents(sw.id); } catch { continue; }
      for (const a of agents) {
        if (a.model === modelId) {
          out.push({ id: a.id, name: a.name, swarm_name: sw.display_name || sw.name });
        }
      }
    }
  }
  return out;
}

async function _bulkReplaceModelInAgents(affected, newModel) {
  // Fetch each constitution, replace the `model:` line in the frontmatter,
  // and PUT back. If a constitution lacks a model: line, insert one.
  for (const a of affected) {
    try {
      const full = await api.getAgent(a.id);
      const text = full.constitution || "";
      const updated = _replaceModelInFrontmatter(text, newModel);
      await api.updateConstitution(a.id, updated);
    } catch (err) {
      console.warn("Could not update agent", a.id, err);
    }
  }
}

function _replaceModelInFrontmatter(md, newModel) {
  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return `---\nmodel: ${newModel}\n---\n\n${md}`;
  }
  let fm = fmMatch[1];
  if (/^model\s*:/m.test(fm)) {
    fm = fm.replace(/^model\s*:.*$/m, `model: ${newModel}`);
  } else {
    fm = fm + `\nmodel: ${newModel}`;
  }
  return md.replace(fmMatch[0], `---\n${fm}\n---`);
}

// ── System tab ───────────────────────────────────────────────────────────────

function _renderSystemTab(pane) {
  const tz       = _get("system.scheduler_timezone")?.value || "Europe/Amsterdam";
  const logLevel = _get("system.log_level")?.value || "INFO";
  const skillTo  = _get("system.default_skill_timeout_seconds")?.value ?? 30;
  const heartbeat= _get("system.default_heartbeat_schedule")?.value || "*/5 * * * *";
  const allowed  = _get("system.allowed_packages")?.value || DEFAULT_PACKAGES;
  const maxTurns = _get("runtime.max_agent_turns")?.value ?? 20;

  pane.innerHTML = `
    <div style="max-width:760px;display:flex;flex-direction:column;gap:18px">

      <div class="card" style="padding:18px 20px">
        <div class="sec-header" style="margin:0 0 10px 0">Scheduler timezone <span class="restart-pill">Requires restart</span></div>
        <input class="form-input" id="sys-tz" value="${_esc(tz)}" placeholder="Europe/Amsterdam">
        <div class="form-helper">Cron expressions on heartbeats are interpreted in this timezone.</div>
      </div>

      <div class="card" style="padding:18px 20px">
        <div class="sec-header" style="margin:0 0 10px 0">Log level <span class="restart-pill">Requires restart</span></div>
        <select class="form-input" id="sys-loglevel">
          ${["DEBUG", "INFO", "WARNING", "ERROR"].map(l => `<option ${l === logLevel ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>

      <div class="card" style="padding:18px 20px">
        <div class="sec-header" style="margin:0 0 10px 0">Default skill timeout (seconds)</div>
        <input class="form-input" id="sys-skill-timeout" type="number" min="1" max="600" value="${Number(skillTo) || 30}">
        <div class="form-helper">Used when a skill's <code style="font-family:var(--font-mono)">.yaml</code> doesn't specify <code style="font-family:var(--font-mono)">timeout_seconds</code>.</div>
      </div>

      <div class="card" style="padding:18px 20px">
        <div class="sec-header" style="margin:0 0 10px 0">Max agent turns per run</div>
        <input class="form-input" id="sys-max-turns" type="number" min="1" max="200" value="${Number(maxTurns) || 20}">
        <div class="form-helper">Maximum LLM calls a single agent can make before the run is aborted. Higher values allow complex multi-step agents (like the Swarm Architect) but increase cost and latency. Default: 20.</div>
      </div>

      <div class="card" style="padding:18px 20px">
        <div class="sec-header" style="margin:0 0 10px 0">Default heartbeat schedule</div>
        <input class="form-input" id="sys-heartbeat" value="${_esc(heartbeat)}" placeholder="*/5 * * * *">
        <div class="form-helper">Cron expression used when creating a new heartbeat trigger without one.</div>
      </div>

      <div class="card" style="padding:18px 20px">
        <div class="sec-header" style="margin:0 0 10px 0">Allowed Python packages for skills</div>
        <div class="form-helper" style="margin-bottom:8px">
          Skills' <code style="font-family:var(--font-mono)">.yaml</code> files must subset this list.
          A package must already be installed in the container's Python environment to actually be importable.
        </div>
        <div id="sys-pkg-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px"></div>
        <div style="display:flex;gap:8px">
          <input class="form-input" id="sys-pkg-input" placeholder="Add package…" style="flex:1">
          <button class="btn btn-ghost btn-sm" id="sys-pkg-add">Add</button>
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-primary" id="sys-save">Save</button>
      </div>
    </div>`;

  // Inject the restart-pill style once.
  if (!document.getElementById("sw-restart-pill-css")) {
    const s = document.createElement("style");
    s.id = "sw-restart-pill-css";
    s.textContent = `
      .restart-pill {
        display:inline-block;font-family:var(--font-mono);font-size:10px;
        text-transform:uppercase;letter-spacing:.06em;
        padding:2px 6px;margin-left:6px;border-radius:3px;
        background:rgba(201,124,42,.12);color:var(--color-warn);
        border:1px solid rgba(201,124,42,.35);
        vertical-align:middle;
      }
      .pkg-chip-installed { color:var(--color-success); }
      .pkg-chip-missing   { color:var(--color-warn); }
    `;
    document.head.appendChild(s);
  }

  // Render package chips with live "installed?" indicator.
  const chips = pane.querySelector("#sys-pkg-chips");
  let pkgs = [...allowed];
  const drawChips = () => {
    chips.innerHTML = "";
    pkgs.forEach((pkg, idx) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.style.cssText = "display:inline-flex;align-items:center;gap:6px;padding:4px 8px;font-family:var(--font-mono);font-size:11px";
      chip.innerHTML = `
        <span class="pkg-chip-status">…</span>
        <span>${_esc(pkg)}</span>
        <button style="background:none;border:none;cursor:pointer;color:var(--color-ink-faint);font-size:14px;line-height:1;padding:0 0 0 2px" title="Remove">×</button>`;
      chip.querySelector("button").addEventListener("click", () => {
        pkgs.splice(idx, 1);
        drawChips();
      });
      chips.appendChild(chip);

      const status = chip.querySelector(".pkg-chip-status");
      api.checkPackageInstalled(pkg).then(r => {
        if (r.installed) {
          status.textContent = "✓";
          status.className = "pkg-chip-status pkg-chip-installed";
          chip.title = "Installed in this container";
        } else {
          status.textContent = "!";
          status.className = "pkg-chip-status pkg-chip-missing";
          chip.title = "Allowed but NOT installed in this container — skills using it will fail at runtime";
        }
      }).catch(() => {
        status.textContent = "?";
      });
    });
  };
  drawChips();

  const addInput = pane.querySelector("#sys-pkg-input");
  const addBtn   = pane.querySelector("#sys-pkg-add");
  const tryAdd = () => {
    const v = addInput.value.trim();
    if (!v) return;
    if (pkgs.includes(v)) { toastError({ message: `${v} already in list` }); return; }
    pkgs.push(v);
    addInput.value = "";
    drawChips();
  };
  addBtn.addEventListener("click", tryAdd);
  addInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); tryAdd(); } });

  // Save handler — bulk update.
  pane.querySelector("#sys-save").addEventListener("click", async () => {
    const tzVal       = pane.querySelector("#sys-tz").value.trim();
    const llVal       = pane.querySelector("#sys-loglevel").value;
    const skVal       = parseInt(pane.querySelector("#sys-skill-timeout").value, 10);
    const hbVal       = pane.querySelector("#sys-heartbeat").value.trim();
    const mtVal       = parseInt(pane.querySelector("#sys-max-turns").value, 10);

    if (!tzVal) { toastError({ message: "Timezone required" }); return; }
    if (!Number.isFinite(skVal) || skVal < 1) { toastError({ message: "Skill timeout must be ≥ 1" }); return; }
    if (!hbVal) { toastError({ message: "Heartbeat schedule required" }); return; }
    if (!Number.isFinite(mtVal) || mtVal < 1) { toastError({ message: "Max agent turns must be ≥ 1" }); return; }

    const updates = [];
    const maybe = (key, value, value_type) => {
      const cur = _get(key)?.value;
      if (JSON.stringify(cur) !== JSON.stringify(value)) {
        updates.push({ key, value, value_type });
        _markChanged(key);
      }
    };
    maybe("system.scheduler_timezone", tzVal, "string");
    maybe("system.log_level", llVal, "string");
    maybe("system.default_skill_timeout_seconds", skVal, "number");
    maybe("system.default_heartbeat_schedule", hbVal, "string");
    maybe("system.allowed_packages", pkgs, "json");
    maybe("runtime.max_agent_turns", mtVal, "number");

    if (!updates.length) { toastSuccess("No changes"); return; }
    try {
      await api.bulkPutSettings({ updates, reason: "system tab save" });
      _invalidate();
      await _loadSettings(true);
      toastSuccess(`${updates.length} setting${updates.length === 1 ? "" : "s"} saved`);
    } catch (err) { toastError(err); }
  });
}

// ── Branding tab ─────────────────────────────────────────────────────────────

const _BRANDING_DEFAULTS = {
  app_name:      "SwarmWright",
  color_primary: "#d99a3f",
  color_accent:  "#c97c2a",
  tagline:       "",
};

function _readBrandingFromCache() {
  return {
    app_name:      _get("branding.app_name")?.value      ?? _BRANDING_DEFAULTS.app_name,
    color_primary: _get("branding.color_primary")?.value ?? _BRANDING_DEFAULTS.color_primary,
    color_accent:  _get("branding.color_accent")?.value  ?? _BRANDING_DEFAULTS.color_accent,
    tagline:       _get("branding.tagline")?.value       ?? _BRANDING_DEFAULTS.tagline,
    logo_path:     _get("branding.logo_path")?.value     ?? null,
  };
}

/**
 * Apply branding (colours, app name, tagline, document title, custom logo)
 * to the live DOM so the entire app reflects the operator's settings without
 * a reload. Called from this view's editor on every input event, from the
 * Save handler after persistence, and from app bootstrap so persisted
 * branding sticks across pages.
 */
export function applyBranding(branding) {
  const root = document.documentElement;
  if (branding.color_primary) root.style.setProperty("--color-primary", branding.color_primary);
  if (branding.color_accent)  root.style.setProperty("--color-accent",  branding.color_accent);

  // App name — preserve the SwarmWright default if no custom name is set.
  const nameHost = document.getElementById("brand-name-host");
  if (nameHost) {
    if (branding.app_name && branding.app_name !== _BRANDING_DEFAULTS.app_name) {
      nameHost.textContent = branding.app_name;
    } else {
      nameHost.innerHTML = `Swarm<span class="logo-wright">Wright</span>`;
    }
  }

  // Tagline — hide the slot when empty so it doesn't reserve vertical space.
  const tagHost = document.getElementById("brand-tagline-host");
  if (tagHost) {
    if (branding.tagline) {
      tagHost.textContent = branding.tagline;
      tagHost.hidden = false;
    } else {
      tagHost.textContent = "";
      tagHost.hidden = true;
    }
  }

  // Document title — small touch but it shows up in the browser tab.
  document.title = branding.app_name && branding.app_name !== _BRANDING_DEFAULTS.app_name
    ? branding.app_name
    : "SwarmWright";

  // Logo — swap the default SVG mark for the uploaded image when one exists.
  const defaultLogo = document.getElementById("brand-logo-default");
  const customLogo  = document.getElementById("brand-logo-custom");
  if (defaultLogo && customLogo) {
    if (branding.logo_path) {
      // Cache-bust on every apply so a re-upload to the same path picks up.
      customLogo.src = `/api/v1/settings/branding/logo?t=${Date.now()}`;
      customLogo.hidden = false;
      defaultLogo.style.display = "none";
    } else {
      customLogo.hidden = true;
      customLogo.removeAttribute("src");
      defaultLogo.style.display = "";
    }
  }
}

/** Public bootstrap helper — loads settings once and applies stored branding. */
export async function applyBrandingOnBoot() {
  try {
    await _loadSettings();
    applyBranding(_readBrandingFromCache());
  } catch {
    // Boot continues with default colours if settings can't be reached.
  }
}

function _renderBrandingTab(pane) {
  const b = _readBrandingFromCache();

  pane.innerHTML = `
    <div style="display:grid;grid-template-columns:minmax(320px, 1fr) minmax(320px, 1fr);gap:24px;max-width:1080px">

      <!-- ── Form column ─────────────────────────────────────────────── -->
      <div style="display:flex;flex-direction:column;gap:14px">

        <div class="card" style="padding:18px 20px">
          <div class="sec-header" style="margin:0 0 10px 0">App name</div>
          <input class="form-input" id="brand-name" value="${_esc(b.app_name)}">
          <div class="form-helper">Shown in the top bar.</div>
        </div>

        <div class="card" style="padding:18px 20px">
          <div class="sec-header" style="margin:0 0 10px 0">Tagline</div>
          <input class="form-input" id="brand-tagline" value="${_esc(b.tagline)}" placeholder="(optional)">
          <div class="form-helper">Small subtitle shown under the app name.</div>
        </div>

        <div class="card" style="padding:18px 20px">
          <div class="sec-header" style="margin:0 0 12px 0">Colours</div>
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
            <input type="color" id="brand-primary" value="${_esc(b.color_primary)}" style="width:42px;height:42px;border:1px solid var(--color-cream-line);border-radius:6px;background:var(--color-card);padding:2px;cursor:pointer">
            <div style="flex:1">
              <div style="font-size:12px;font-family:var(--font-mono);color:var(--color-ink-soft)">Primary</div>
              <div style="font-size:11px;font-family:var(--font-mono);color:var(--color-ink-faint)" id="brand-primary-hex">${_esc(b.color_primary)}</div>
            </div>
            <div style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono);max-width:160px;text-align:right">Active states, primary buttons.</div>
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <input type="color" id="brand-accent" value="${_esc(b.color_accent)}" style="width:42px;height:42px;border:1px solid var(--color-cream-line);border-radius:6px;background:var(--color-card);padding:2px;cursor:pointer">
            <div style="flex:1">
              <div style="font-size:12px;font-family:var(--font-mono);color:var(--color-ink-soft)">Accent</div>
              <div style="font-size:11px;font-family:var(--font-mono);color:var(--color-ink-faint)" id="brand-accent-hex">${_esc(b.color_accent)}</div>
            </div>
            <div style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono);max-width:160px;text-align:right">Highlights, live state, perceptionist accents.</div>
          </div>
        </div>

        <div class="card" style="padding:18px 20px">
          <div class="sec-header" style="margin:0 0 10px 0">Logo</div>
          <div class="form-helper" style="margin-bottom:8px">PNG or SVG, ≤ 200KB, ≤ 400×100 px.</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="file" id="brand-logo" accept=".png,.svg" style="flex:1">
            <button class="btn btn-ghost btn-sm" id="brand-logo-clear">Reset</button>
          </div>
          <div id="brand-logo-msg" style="margin-top:6px;font-size:11px;font-family:var(--font-mono);color:var(--color-ink-faint);min-height:14px">${b.logo_path ? "Current: " + _esc(b.logo_path) : "No logo uploaded."}</div>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
          <button class="btn btn-ghost" id="brand-reset">Reset to defaults</button>
          <button class="btn btn-primary" id="brand-save">Save</button>
        </div>
      </div>

      <!-- ── Preview column ──────────────────────────────────────────── -->
      <div>
        <div class="sec-header" style="margin:0 0 8px 0">Preview</div>
        <div class="card" style="padding:0;overflow:hidden">

          <!-- Fake topbar -->
          <div id="brand-preview-topbar"
               style="background:var(--color-parchment);
                      border-bottom:1px dashed var(--color-cream-line);
                      padding:12px 16px;display:flex;align-items:center;gap:10px">
            <div id="brand-preview-logo-host"
                 style="width:28px;height:28px;border-radius:50%;background:var(--color-primary);
                        display:flex;align-items:center;justify-content:center;color:#fff;
                        font-family:var(--font-display);font-size:14px">⬡</div>
            <div>
              <div id="brand-preview-name" style="font-family:var(--font-display);font-size:16px">${_esc(b.app_name)}</div>
              <div id="brand-preview-tagline" style="font-family:var(--font-mono);font-size:10px;color:var(--color-ink-faint)">${_esc(b.tagline)}</div>
            </div>
          </div>

          <div style="padding:18px;display:flex;flex-direction:column;gap:14px;background:var(--color-card)">

            <div>
              <div style="font-size:11px;font-family:var(--font-mono);color:var(--color-ink-soft);margin-bottom:6px">Primary button</div>
              <button class="btn btn-primary" style="pointer-events:none">Save</button>
            </div>

            <div>
              <div style="font-size:11px;font-family:var(--font-mono);color:var(--color-ink-soft);margin-bottom:6px">Accent highlight</div>
              <span class="badge badge-perceptionist" style="background:rgba(201,124,42,.12);color:var(--color-accent);border:1px solid var(--color-accent)">live · perceptionist</span>
            </div>

            <div>
              <div style="font-size:11px;font-family:var(--font-mono);color:var(--color-ink-soft);margin-bottom:6px">Layered swatches</div>
              <div style="display:flex;gap:6px">
                <span style="display:inline-block;width:38px;height:24px;background:var(--color-primary);border-radius:4px"></span>
                <span style="display:inline-block;width:38px;height:24px;background:var(--color-accent);border-radius:4px"></span>
                <span style="display:inline-block;width:38px;height:24px;background:var(--color-policy);border-radius:4px"></span>
                <span style="display:inline-block;width:38px;height:24px;background:var(--color-orchestrator);border-radius:4px"></span>
              </div>
              <div style="font-size:10px;font-family:var(--font-mono);color:var(--color-ink-faint);margin-top:4px">primary · accent · policy · orchestrator</div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const nameInput    = pane.querySelector("#brand-name");
  const taglineInput = pane.querySelector("#brand-tagline");
  const primaryInput = pane.querySelector("#brand-primary");
  const accentInput  = pane.querySelector("#brand-accent");
  const logoInput    = pane.querySelector("#brand-logo");
  const logoClear    = pane.querySelector("#brand-logo-clear");
  const logoMsg      = pane.querySelector("#brand-logo-msg");
  const previewName  = pane.querySelector("#brand-preview-name");
  const previewTag   = pane.querySelector("#brand-preview-tagline");
  const primaryHex   = pane.querySelector("#brand-primary-hex");
  const accentHex    = pane.querySelector("#brand-accent-hex");

  // Live preview wiring — colours mutate root custom properties immediately.
  primaryInput.addEventListener("input", () => {
    document.documentElement.style.setProperty("--color-primary", primaryInput.value);
    primaryHex.textContent = primaryInput.value;
  });
  accentInput.addEventListener("input", () => {
    document.documentElement.style.setProperty("--color-accent", accentInput.value);
    accentHex.textContent = accentInput.value;
  });
  nameInput.addEventListener("input", () => previewName.textContent = nameInput.value);
  taglineInput.addEventListener("input", () => previewTag.textContent = taglineInput.value);

  logoInput.addEventListener("change", async () => {
    const file = logoInput.files?.[0];
    if (!file) return;
    if (file.size > 200 * 1024) {
      logoMsg.textContent = "File too large (>200KB)";
      logoMsg.style.color = "var(--color-danger)";
      logoInput.value = "";
      return;
    }
    try {
      const r = await api.uploadLogo(file);
      logoMsg.textContent = `Uploaded ${r.path} (${r.width}×${r.height}px, ${r.size_bytes} bytes)`;
      logoMsg.style.color = "var(--color-success)";
      _invalidate();
      await _loadSettings(true);
      applyBranding(_readBrandingFromCache());
    } catch (err) {
      logoMsg.textContent = err.message || "Upload failed";
      logoMsg.style.color = "var(--color-danger)";
    }
  });

  logoClear.addEventListener("click", async () => {
    if (!confirm("Remove the uploaded logo? The default mark will be used.")) return;
    try {
      await api.putSetting("branding.logo_path", { value: "", value_type: "string" });
      _invalidate();
      await _loadSettings(true);
      applyBranding(_readBrandingFromCache());
      logoMsg.textContent = "No logo uploaded.";
      logoMsg.style.color = "var(--color-ink-faint)";
      logoInput.value = "";
    } catch (err) { toastError(err); }
  });

  pane.querySelector("#brand-reset").addEventListener("click", () => {
    nameInput.value    = _BRANDING_DEFAULTS.app_name;
    taglineInput.value = _BRANDING_DEFAULTS.tagline;
    primaryInput.value = _BRANDING_DEFAULTS.color_primary;
    accentInput.value  = _BRANDING_DEFAULTS.color_accent;
    primaryInput.dispatchEvent(new Event("input"));
    accentInput.dispatchEvent(new Event("input"));
    nameInput.dispatchEvent(new Event("input"));
    taglineInput.dispatchEvent(new Event("input"));
  });

  pane.querySelector("#brand-save").addEventListener("click", async () => {
    const updates = [];
    const maybe = (key, value, value_type = "string") => {
      const cur = _get(key)?.value;
      if (JSON.stringify(cur) !== JSON.stringify(value)) updates.push({ key, value, value_type });
    };
    maybe("branding.app_name",      nameInput.value.trim());
    maybe("branding.tagline",       taglineInput.value.trim());
    maybe("branding.color_primary", primaryInput.value);
    maybe("branding.color_accent",  accentInput.value);

    if (!updates.length) { toastSuccess("No changes"); return; }
    try {
      await api.bulkPutSettings({ updates, reason: "branding tab save" });
      _invalidate();
      await _loadSettings(true);
      applyBranding(_readBrandingFromCache());
      toastSuccess(`${updates.length} branding setting${updates.length === 1 ? "" : "s"} saved`);
    } catch (err) { toastError(err); }
  });
}

// ── Security tab ─────────────────────────────────────────────────────────────

function _renderSecurityTab(pane) {
  const fingerprint = _get("security.encryption_key_id")?.value || null;
  const retention   = _get("security.audit_retention_days")?.value ?? 365;

  pane.innerHTML = `
    <div style="max-width:880px;display:flex;flex-direction:column;gap:18px">

      <div class="card" style="padding:18px 20px">
        <div class="sec-header" style="margin:0 0 10px 0">Master encryption key</div>
        <div style="font-size:12px;color:var(--color-ink-soft);font-family:var(--font-mono);margin-bottom:10px">
          Fingerprint: <code>${_esc(fingerprint || "(unrotated — derived on first boot)")}</code>
        </div>
        <div class="form-helper" style="margin-bottom:12px">
          Rotation re-encrypts every secret in <code>swarm.db</code> in one transaction.
          The new key is shown to you exactly once — copy it before continuing,
          and update <code>SWARM_ENCRYPTION_KEY</code> (or <code>&lt;DATA_DIR&gt;/.encryption_key</code>)
          before the next container restart.
        </div>
        <button class="btn btn-primary" id="sec-rotate">Rotate encryption key</button>
      </div>

      <div class="card" style="padding:18px 20px">
        <div class="sec-header" style="margin:0 0 10px 0">Audit-log retention</div>
        <input class="form-input" id="sec-retention" type="number" min="90" max="36500" value="${Number(retention) || 365}" style="max-width:120px;display:inline-block">
        <span style="font-family:var(--font-mono);font-size:12px;color:var(--color-ink-soft);margin-left:8px">days (min 90, max 36500)</span>
        <div class="form-helper" style="margin-top:8px">Older <code>settings_audit</code> rows are pruned by a background job.</div>
        <div style="margin-top:10px">
          <button class="btn btn-primary btn-sm" id="sec-save-retention">Save</button>
        </div>
      </div>

      <div class="card" style="padding:18px 20px">
        <div class="sec-header" style="margin:0 0 10px 0">API access</div>
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--color-ink-soft)">
          Not configured — local-only access.
          <span style="color:var(--color-ink-faint)">(Authentication is added in a later phase.)</span>
        </div>
      </div>

      <div class="card" style="padding:18px 20px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px">
          <div class="sec-header" style="margin:0">Audit log</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input class="form-input" id="audit-key-filter" placeholder="Filter by key…" style="font-family:var(--font-mono);font-size:12px;max-width:240px">
            <button class="btn btn-ghost btn-sm" id="audit-refresh">Refresh</button>
          </div>
        </div>
        <div id="audit-table" style="font-family:var(--font-mono);font-size:11px"></div>
      </div>
    </div>`;

  pane.querySelector("#sec-rotate").addEventListener("click", () => _showRotationModal());

  pane.querySelector("#sec-save-retention").addEventListener("click", async () => {
    const v = parseInt(pane.querySelector("#sec-retention").value, 10);
    if (!Number.isFinite(v) || v < 90 || v > 36500) {
      toastError({ message: "Retention must be between 90 and 36500 days" });
      return;
    }
    try {
      await api.putSetting("security.audit_retention_days", { value: v, value_type: "number" });
      _invalidate();
      toastSuccess("Retention saved");
    } catch (err) { toastError(err); }
  });

  // Audit table
  const auditHost = pane.querySelector("#audit-table");
  const filterInput = pane.querySelector("#audit-key-filter");
  const refresh = async () => {
    const params = {};
    const k = filterInput.value.trim();
    if (k) params.key = k;
    params.limit = "100";
    auditHost.innerHTML = `<div style="color:var(--color-ink-faint);padding:12px">Loading…</div>`;
    try {
      const rows = await api.getSettingsAudit(params);
      _drawAuditTable(auditHost, rows);
    } catch (err) {
      auditHost.innerHTML = `<div style="color:var(--color-danger);padding:12px">Failed to load: ${_esc(err.message || "")}</div>`;
    }
  };
  pane.querySelector("#audit-refresh").addEventListener("click", refresh);
  filterInput.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); refresh(); }
  });
  refresh();
}

function _drawAuditTable(host, rows) {
  if (!rows.length) {
    host.innerHTML = `<div class="empty-state" style="padding:24px"><div class="empty-state-title">No audit entries</div></div>`;
    return;
  }
  host.innerHTML = `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="text-align:left;border-bottom:1px solid var(--color-cream-line)">
          <th style="padding:8px 10px;color:var(--color-ink-soft);font-weight:500;text-transform:uppercase;letter-spacing:.05em">When</th>
          <th style="padding:8px 10px;color:var(--color-ink-soft);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Key</th>
          <th style="padding:8px 10px;color:var(--color-ink-soft);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Actor</th>
          <th style="padding:8px 10px;color:var(--color-ink-soft);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Reason</th>
          <th style="padding:8px 10px;color:var(--color-ink-soft);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Prev hash</th>
          <th style="padding:8px 10px;color:var(--color-ink-soft);font-weight:500;text-transform:uppercase;letter-spacing:.05em">New hash</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr style="border-bottom:1px dashed var(--color-cream-line)">
            <td style="padding:8px 10px;white-space:nowrap;color:var(--color-ink-soft)">${_esc(r.changed_at?.replace("T", " ").slice(0, 19) || "")}</td>
            <td style="padding:8px 10px"><code>${_esc(r.key)}</code></td>
            <td style="padding:8px 10px;color:var(--color-ink-soft)">${_esc(r.actor || "—")}</td>
            <td style="padding:8px 10px;color:var(--color-ink-soft);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(r.reason || "")}">${_esc(r.reason || "—")}</td>
            <td style="padding:8px 10px;color:var(--color-ink-faint)">${_esc((r.previous_value_hash || "—").slice(0, 12))}${r.previous_value_hash ? "…" : ""}</td>
            <td style="padding:8px 10px;color:var(--color-ink-faint)">${_esc((r.new_value_hash || "—").slice(0, 12))}${r.new_value_hash ? "…" : ""}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

// ── Rotation modal (5 deliberately friction-heavy steps) ─────────────────────

function _showRotationModal() {
  let step = 1;
  let mode = "generate";   // "generate" | "paste"
  let pastedKey = "";
  let confirmedKey = null; // the key we'll send to the server
  let serverResult = null; // { new_key, encryption_key_id, rotated_count }

  const veil = document.createElement("div");
  veil.className = "modal-veil";
  veil.innerHTML = `<div class="modal" role="dialog" style="max-width:560px">
    <div class="modal-header">
      <span id="rot-title">Rotate encryption key — Step 1 of 5</span>
      <button class="modal-close" id="rot-x">✕</button>
    </div>
    <div class="modal-body" id="rot-body" style="min-height:160px"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="rot-back">Back</button>
      <button class="btn btn-primary" id="rot-next">Next</button>
    </div>
  </div>`;
  document.body.appendChild(veil);

  const close = () => veil.remove();
  veil.querySelector("#rot-x").addEventListener("click", close);

  const titleEl = veil.querySelector("#rot-title");
  const bodyEl  = veil.querySelector("#rot-body");
  const backBtn = veil.querySelector("#rot-back");
  const nextBtn = veil.querySelector("#rot-next");

  const draw = () => {
    titleEl.textContent = `Rotate encryption key — Step ${step} of 5`;
    backBtn.style.visibility = (step === 1 || step === 5) ? "hidden" : "visible";

    if (step === 1) {
      bodyEl.innerHTML = `
        <p style="margin:0 0 10px 0;font-family:var(--font-mono);font-size:13px;line-height:1.6">
          Rotation re-encrypts <strong>every secret</strong> stored in <code>swarm.db</code>
          with a new master key, in one transaction.
        </p>
        <p style="margin:0 0 10px 0;font-family:var(--font-mono);font-size:13px;line-height:1.6">
          After rotation you must update <code>SWARM_ENCRYPTION_KEY</code> in your environment
          (or <code>&lt;DATA_DIR&gt;/.encryption_key</code>) to the new key
          <em>before the next container restart</em>, or the system will not be able to decrypt.
        </p>
        <p style="margin:0;color:var(--color-warn);font-family:var(--font-mono);font-size:13px">
          The new key is shown to you <strong>exactly once</strong>. Lose it and the secrets are unrecoverable.
        </p>`;
      nextBtn.textContent = "I understand, continue";
    }
    else if (step === 2) {
      bodyEl.innerHTML = `
        <p style="margin:0 0 12px 0;font-family:var(--font-mono);font-size:13px">Choose how to supply the new key:</p>
        <label style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;cursor:pointer">
          <input type="radio" name="rot-mode" value="generate" ${mode === "generate" ? "checked" : ""}>
          <span style="flex:1">
            <span style="font-weight:600">Generate a new key</span>
            <div style="font-size:11px;font-family:var(--font-mono);color:var(--color-ink-faint);margin-top:2px">Server-generated Fernet key. Shown once on the next step.</div>
          </span>
        </label>
        <label style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;cursor:pointer">
          <input type="radio" name="rot-mode" value="paste" ${mode === "paste" ? "checked" : ""}>
          <span style="flex:1">
            <span style="font-weight:600">Paste an existing key</span>
            <div style="font-size:11px;font-family:var(--font-mono);color:var(--color-ink-faint);margin-top:2px">For when you've already prepared one out-of-band.</div>
          </span>
        </label>
        <textarea class="form-input" id="rot-paste" placeholder="44-char URL-safe base64 key…"
          style="margin-top:10px;font-family:var(--font-mono);font-size:12px;min-height:60px;resize:vertical;display:${mode === "paste" ? "block" : "none"}">${_esc(pastedKey)}</textarea>`;
      bodyEl.querySelectorAll("input[name=rot-mode]").forEach(r => {
        r.addEventListener("change", () => {
          mode = r.value;
          draw();
        });
      });
      const ta = bodyEl.querySelector("#rot-paste");
      if (ta) ta.addEventListener("input", () => pastedKey = ta.value.trim());
      nextBtn.textContent = "Next";
    }
    else if (step === 3) {
      // Reveal the key (one-time display).
      const display = confirmedKey || (mode === "paste" ? pastedKey : "(server will generate)");
      bodyEl.innerHTML = `
        <p style="margin:0 0 10px 0;font-family:var(--font-mono);font-size:13px">
          ${mode === "paste"
            ? "You'll commit this key as the new master."
            : "The server will generate a new key when you continue. The result is shown on the next step."}
        </p>
        ${confirmedKey ? `
          <p style="margin:0 0 6px 0;font-family:var(--font-mono);font-size:12px;color:var(--color-ink-soft)">New key (copy it now):</p>
          <code style="display:block;padding:10px 12px;background:var(--color-cream-deep);border-radius:4px;font-family:var(--font-mono);font-size:12px;word-break:break-all">${_esc(confirmedKey)}</code>` : ""}
        <p style="margin:12px 0 0 0;color:var(--color-warn);font-family:var(--font-mono);font-size:13px">
          ⚠ This is the only time you'll see this value.
        </p>`;
      nextBtn.textContent = "Re-encrypt now";
    }
    else if (step === 4) {
      bodyEl.innerHTML = `
        <p style="margin:0 0 10px 0;font-family:var(--font-mono);font-size:13px">Re-encrypting all secrets…</p>
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--color-ink-faint)">
          This usually completes in well under a second on a normal SQLite.
        </div>`;
      nextBtn.textContent = "Working…";
      nextBtn.disabled = true;
    }
    else if (step === 5) {
      bodyEl.innerHTML = `
        <p style="margin:0 0 12px 0;font-family:var(--font-mono);font-size:14px">
          ✓ Rotation succeeded — ${serverResult?.rotated_count ?? 0} secret${serverResult?.rotated_count === 1 ? "" : "s"} re-encrypted.
        </p>
        <p style="margin:0 0 8px 0;font-family:var(--font-mono);font-size:12px;color:var(--color-ink-soft)">
          New fingerprint: <code>${_esc(serverResult?.encryption_key_id || "")}</code>
        </p>
        <p style="margin:0;color:var(--color-warn);font-family:var(--font-mono);font-size:13px">
          Update <code>SWARM_ENCRYPTION_KEY</code> in your environment now.
          The next container restart will fail without it.
        </p>`;
      backBtn.style.visibility = "hidden";
      nextBtn.textContent = "Done";
      nextBtn.disabled = false;
    }
  };

  backBtn.addEventListener("click", () => { if (step > 1) { step -= 1; draw(); } });

  nextBtn.addEventListener("click", async () => {
    if (step === 1) { step = 2; draw(); return; }
    if (step === 2) {
      if (mode === "paste") {
        if (!/^[A-Za-z0-9_\-]{43}=$/.test(pastedKey)) {
          toastError({ message: "Pasted key must be 44-char URL-safe base64" });
          return;
        }
        confirmedKey = pastedKey;
      } else {
        confirmedKey = null; // server generates on step 4
      }
      step = 3; draw();
      return;
    }
    if (step === 3) { step = 4; draw(); _performRotation(); return; }
    if (step === 5) { close(); return; }
  });

  async function _performRotation() {
    try {
      const body = confirmedKey ? { new_key: confirmedKey, reason: "ui rotation" } : { reason: "ui rotation" };
      const r = await api.rotateMasterKey(body);
      serverResult = r;
      // For "generate" mode, this is the only time we see the key — capture it.
      if (!confirmedKey) confirmedKey = r.new_key;
      _invalidate();
      step = 5; draw();
    } catch (err) {
      bodyEl.innerHTML = `<p style="color:var(--color-danger);font-family:var(--font-mono)">Rotation failed: ${_esc(err.message || "")}</p>`;
      nextBtn.disabled = false;
      nextBtn.textContent = "Close";
      backBtn.style.visibility = "hidden";
      nextBtn.onclick = close;
    }
  }

  draw();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _renderEmpty(host, title, sub) {
  host.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-title">${_esc(title)}</div>
      <div class="empty-state-sub">${_esc(sub)}</div>
    </div>`;
}

function _esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
