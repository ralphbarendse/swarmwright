import * as api from "../api.js";
import { onEvent } from "../sse.js";
import { toastError, toastSuccess } from "../components/toast.js";

// Tab definitions. "notifications" routes to /informs; others route to /inbox.
const TABS = [
  { id: "pending",       label: "Awaiting",      apiStatus: "pending" },
  { id: "notifications", label: "Notifications",  apiStatus: "unread"  },
  { id: "yes",           label: "Approved",       apiStatus: "yes"     },
  { id: "no",            label: "Rejected",       apiStatus: "no"      },
];

let _selectedId   = null;
let _selectedKind = "action";   // "action" | "inform"
let _tab          = "pending";

// ── Topbar pip ───────────────────────────────────────────────────────────────

let _pipBound = false;
export async function refreshInboxPip() {
  if (!_pipBound) {
    onEvent("human_action.pending",  () => _updatePipFromServer());
    onEvent("human_action.resolved", () => _updatePipFromServer());
    onEvent("run.awaiting_human",    () => _updatePipFromServer());
    onEvent("run.resumed",           () => _updatePipFromServer());
    onEvent("human_inform.pending",  () => _updatePipFromServer());
    onEvent("human_inform.acked",    () => _updatePipFromServer());
    _pipBound = true;
  }
  _updatePipFromServer();
}

async function _updatePipFromServer() {
  try {
    const [actions, informs] = await Promise.all([
      api.listInbox({ status: "pending", limit: "200" }),
      api.listInforms({ status: "unread", limit: "200" }),
    ]);
    const total = (actions?.length ?? 0) + (informs?.length ?? 0);
    const pip = document.getElementById("inbox-count-pip");
    if (!pip) return;
    if (!total) {
      pip.hidden = true;
      pip.textContent = "";
    } else {
      pip.hidden = false;
      pip.textContent = String(total);
    }
  } catch {
    // Offline / boot — silently ignore.
  }
}

// ── View entry ───────────────────────────────────────────────────────────────

export function renderInboxView(container, segments = []) {
  container.style.overflowY = "hidden";
  container.style.height = "100%";

  if (segments[0]) {
    _selectedId = segments[0];
    _selectedKind = segments[1] === "inform" ? "inform" : "action";
  }

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden">
      <div class="page-header" style="flex-shrink:0">
        <div class="page-title">Inbox</div>
        <div class="page-sub">Human-in-the-loop actions and notifications from running swarms.</div>
      </div>

      <div style="display:flex;gap:0;border-bottom:1px dashed var(--color-cream-line);padding:0 24px;flex-shrink:0;margin-top:6px"
           id="inbox-tabs">
        ${TABS.map(t => `
          <button class="topbar-tab ${t.id === _tab ? "active" : ""}"
                  data-tab="${t.id}"
                  style="font-size:13px;padding:8px 16px">${_esc(t.label)}</button>`).join("")}
      </div>

      <div style="display:flex;flex:1;overflow:hidden">
        <div id="inbox-list" style="width:380px;border-right:1px dashed var(--color-cream-line);overflow-y:auto;padding:14px 12px;background:var(--color-panel)">
          <div style="color:var(--color-ink-faint);font-family:var(--font-mono);font-size:12px">Loading…</div>
        </div>
        <div id="inbox-detail" style="flex:1;overflow-y:auto;padding:24px"></div>
      </div>
    </div>`;

  container.querySelector("#inbox-tabs").addEventListener("click", e => {
    const btn = e.target.closest("[data-tab]");
    if (!btn) return;
    _tab = btn.dataset.tab;
    _selectedId = null;
    window.swNav("inbox");
  });

  _loadList(container);

  onEvent("human_action.pending",  () => _loadList(container));
  onEvent("human_action.resolved", () => _loadList(container));
  onEvent("human_inform.pending",  () => _loadList(container));
  onEvent("human_inform.acked",    () => _loadList(container));

  return null;
}

// ── List loading ─────────────────────────────────────────────────────────────

async function _loadList(container) {
  const host = container.querySelector("#inbox-list");
  const tabDef = TABS.find(t => t.id === _tab) || TABS[0];
  try {
    let items;
    if (_tab === "notifications") {
      items = await api.listInforms({ status: "unread", limit: "100" });
    } else {
      items = await api.listInbox({ status: tabDef.apiStatus, limit: "100" });
    }

    if (!items.length) {
      host.innerHTML = `
        <div class="empty-state" style="margin-top:40px">
          <div class="empty-state-title">Nothing here</div>
          <div class="empty-state-sub">No ${_esc(tabDef.label.toLowerCase())} items.</div>
        </div>`;
      _renderEmptyDetail(container);
      return;
    }
    host.innerHTML = "";
    const makeCard = _tab === "notifications" ? _makeInformCard : _makeActionCard;
    items.forEach(item => host.appendChild(makeCard(item, container)));

    if (_selectedId) {
      _renderDetail(container, _selectedId, _selectedKind);
    } else {
      _renderEmptyDetail(container);
    }
  } catch (err) {
    host.innerHTML = `<div style="color:var(--color-danger);font-family:var(--font-mono);font-size:12px">Could not load: ${_esc(err.message || "")}</div>`;
  }
}

// ── Cards ─────────────────────────────────────────────────────────────────────

function _makeActionCard(item, container) {
  const card = document.createElement("div");
  card.className = "card inbox-card";
  card.dataset.id = item.id;
  card.style.cssText = "padding:12px 14px;margin-bottom:8px;cursor:pointer;border-color:" +
    (item.id === _selectedId ? "var(--color-perceptionist)" : "var(--color-cream-line)");

  const statusColor = item.status === "pending"
    ? "var(--color-warn)" : item.status === "yes"
    ? "var(--color-success)" : "var(--color-danger)";
  const statusLabel = item.status === "yes" ? "approved" : item.status === "no" ? "rejected" : item.status;

  card.innerHTML = `
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px">
      <div style="font-family:'Caveat','Architects Daughter',cursive;font-size:18px;color:var(--color-perceptionist);font-weight:600">
        ✋ ${_esc(item.caller_display_name || item.caller_name || "")}
      </div>
      <span style="font-family:var(--font-mono);font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:${statusColor}">${_esc(statusLabel)}</span>
    </div>
    <div style="font-size:12px;color:var(--color-ink-soft);font-family:var(--font-mono);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
      ${_esc(item.purpose || "")}
    </div>
    <div style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono)">
      run ${_esc((item.run_id || "").slice(0, 8))} · ${_reltime(item.created_at)}
    </div>`;

  card.addEventListener("click", () => {
    _selectedId = item.id;
    _selectedKind = "action";
    _renderDetail(container, item.id, "action");
    container.querySelectorAll(".inbox-card").forEach(c => {
      c.style.borderColor = c.dataset.id === _selectedId
        ? "var(--color-perceptionist)" : "var(--color-cream-line)";
    });
  });
  return card;
}

function _makeInformCard(item, container) {
  const card = document.createElement("div");
  card.className = "card inbox-card";
  card.dataset.id = item.id;
  card.style.cssText = "padding:12px 14px;margin-bottom:8px;cursor:pointer;border-color:" +
    (item.id === _selectedId ? "var(--color-perceptionist)" : "var(--color-cream-line)");

  card.innerHTML = `
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px">
      <div style="font-family:'Caveat','Architects Daughter',cursive;font-size:18px;color:#3a5570;font-weight:600">
        📢 ${_esc(item.informer_display_name || item.informer_name || "")}
      </div>
      <span style="font-family:var(--font-mono);font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--color-ink-faint)">notify</span>
    </div>
    <div style="font-size:12px;color:var(--color-ink-soft);font-family:var(--font-mono);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
      ${_esc(item.purpose || "")}
    </div>
    <div style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono)">
      run ${_esc((item.run_id || "").slice(0, 8))} · ${_reltime(item.created_at)}
    </div>`;

  card.addEventListener("click", () => {
    _selectedId = item.id;
    _selectedKind = "inform";
    _renderDetail(container, item.id, "inform");
    container.querySelectorAll(".inbox-card").forEach(c => {
      c.style.borderColor = c.dataset.id === _selectedId
        ? "var(--color-perceptionist)" : "var(--color-cream-line)";
    });
  });
  return card;
}

// ── Detail panel ──────────────────────────────────────────────────────────────

async function _renderDetail(container, id, kind) {
  const host = container.querySelector("#inbox-detail");
  host.innerHTML = `<div style="color:var(--color-ink-faint);font-family:var(--font-mono)">Loading…</div>`;
  try {
    if (kind === "inform") {
      const item = await api.getInformItem(id);
      _drawInformDetail(host, item, container);
    } else {
      const item = await api.getInboxItem(id);
      _drawActionDetail(host, item, container);
    }
  } catch (err) {
    host.innerHTML = `<div style="color:var(--color-danger);font-family:var(--font-mono)">Could not load item: ${_esc(err.message || "")}</div>`;
  }
}

function _renderEmptyDetail(container) {
  container.querySelector("#inbox-detail").innerHTML = `
    <div class="empty-state" style="margin-top:80px">
      <div class="empty-state-title">No item selected</div>
      <div class="empty-state-sub">Pick something from the list on the left.</div>
    </div>`;
}

function _drawActionDetail(host, item, container) {
  const isPending = item.status === "pending";
  const statusLabel = item.status === "yes" ? "approved" : item.status === "no" ? "rejected" : item.status;
  const statusColor = item.status === "pending"
    ? "var(--color-warn)" : item.status === "yes"
    ? "var(--color-success)" : "var(--color-danger)";

  host.innerHTML = `
    <div style="max-width:760px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px">
        <div style="font-family:'Caveat','Architects Daughter',cursive;font-size:28px;color:var(--color-perceptionist);font-weight:600">
          ✋ ${_esc(item.caller_display_name || item.caller_name || "")}
        </div>
        <span style="font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:3px 8px;border-radius:3px;background:${item.status === "pending" ? "rgba(201,124,42,.12)" : item.status === "yes" ? "rgba(79,122,74,.15)" : "rgba(168,66,58,.15)"};color:${statusColor}">${_esc(statusLabel)}</span>
      </div>

      <div class="card" style="padding:14px 16px;margin-bottom:14px">
        <div class="sec-header" style="margin:0 0 6px 0">Purpose</div>
        <div style="font-size:13px;color:var(--color-ink)">${_esc(item.purpose || "")}</div>
      </div>

      ${item.caller_briefing ? `
        <div class="card" style="padding:14px 16px;margin-bottom:14px">
          <div class="sec-header" style="margin:0 0 6px 0">Briefing</div>
          <div style="font-size:13px;line-height:1.5;color:var(--color-ink-soft);white-space:pre-wrap">${_esc(item.caller_briefing)}</div>
        </div>` : ""}

      <div class="card" style="padding:14px 16px;margin-bottom:14px">
        <div class="sec-header" style="margin:0 0 6px 0">Proposed payload</div>
        <textarea id="inbox-payload" ${isPending ? "" : "readonly"}
          style="width:100%;min-height:120px;font-family:var(--font-mono);font-size:12px;padding:8px 10px;background:var(--color-cream-deep);border:1px solid var(--color-cream-line);border-radius:4px;color:var(--color-ink);resize:vertical">${_esc(JSON.stringify(item.payload ?? {}, null, 2))}</textarea>
      </div>

      ${isPending ? `
        <div class="card" style="padding:14px 16px;margin-bottom:14px">
          <div class="sec-header" style="margin:0 0 6px 0">Reason / message back to agent <span style="color:var(--color-ink-faint);font-weight:normal;text-transform:none;letter-spacing:0">(optional)</span></div>
          <input class="form-input" id="inbox-reason" placeholder="e.g. Approved but use PO #1182">
          <div class="form-helper" style="margin-top:6px">
            Forwarded to the agent's next turn as <code style="font-family:var(--font-mono)">action_result.reason</code>.
          </div>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn btn-ghost" id="inbox-reject">Reject</button>
          <button class="btn btn-secondary" id="inbox-edit-approve">Edit &amp; Approve</button>
          <button class="btn btn-primary" id="inbox-approve">Approve</button>
        </div>` : `
        <div class="card" style="padding:14px 16px">
          <div class="sec-header" style="margin:0 0 6px 0">Decision</div>
          <div style="font-size:12px;color:var(--color-ink-soft);font-family:var(--font-mono)">
            ${_esc(statusLabel)} ${item.decided_by ? "by " + _esc(item.decided_by) : ""}
            ${item.decided_at ? "· " + _esc(item.decided_at.replace("T", " ").slice(0, 19)) : ""}
          </div>
          ${item.decision_reason ? `<div style="margin-top:8px;font-size:13px;color:var(--color-ink)">"${_esc(item.decision_reason)}"</div>` : ""}
        </div>`}

      <div style="margin-top:14px;font-size:11px;font-family:var(--font-mono);color:var(--color-ink-faint)">
        run <code>${_esc((item.run_id || "").slice(0, 8))}</code> · created ${_esc((item.created_at || "").replace("T", " ").slice(0, 19))}
      </div>
    </div>`;

  if (!isPending) return;

  const payloadEl = host.querySelector("#inbox-payload");
  const reasonEl  = host.querySelector("#inbox-reason");

  const decide = async (mode) => {
    const reason = reasonEl?.value?.trim() || null;
    let body;
    if (mode === "reject") {
      body = { decision: "no", reason };
    } else if (mode === "edit-approve") {
      let amend;
      try {
        amend = JSON.parse(payloadEl.value || "null");
      } catch (err) {
        toastError({ message: "Invalid JSON in payload: " + err.message });
        return;
      }
      body = { decision: "yes", reason, amend };
    } else {
      body = { decision: "yes", reason };
    }

    try {
      await api.decideInboxItem(item.id, body);
      toastSuccess(mode === "reject" ? "Rejected" : "Approved");
      _selectedId = null;
      _loadList(container.closest(".view") || container);
      refreshInboxPip();
    } catch (err) {
      toastError(err);
    }
  };

  host.querySelector("#inbox-approve").addEventListener("click", () => decide("approve"));
  host.querySelector("#inbox-edit-approve").addEventListener("click", () => decide("edit-approve"));
  host.querySelector("#inbox-reject").addEventListener("click", () => {
    if (!confirm("Reject this item? The run will continue with a rejection result.")) return;
    decide("reject");
  });
}

function _drawInformDetail(host, item, container) {
  const isUnread = item.status === "unread";
  host.innerHTML = `
    <div style="max-width:760px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px">
        <div style="font-family:'Caveat','Architects Daughter',cursive;font-size:28px;color:#3a5570;font-weight:600">
          📢 ${_esc(item.informer_display_name || item.informer_name || "")}
        </div>
        <span style="font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:3px 8px;border-radius:3px;background:rgba(91,127,166,.12);color:#3a5570">${_esc(item.status)}</span>
      </div>

      <div class="card" style="padding:14px 16px;margin-bottom:14px">
        <div class="sec-header" style="margin:0 0 6px 0">Purpose</div>
        <div style="font-size:13px;color:var(--color-ink)">${_esc(item.purpose || "")}</div>
      </div>

      ${item.informer_briefing ? `
        <div class="card" style="padding:14px 16px;margin-bottom:14px">
          <div class="sec-header" style="margin:0 0 6px 0">Briefing</div>
          <div style="font-size:13px;line-height:1.5;color:var(--color-ink-soft);white-space:pre-wrap">${_esc(item.informer_briefing)}</div>
        </div>` : ""}

      <div class="card" style="padding:14px 16px;margin-bottom:14px">
        <div class="sec-header" style="margin:0 0 6px 0">Notification payload</div>
        <pre style="font-family:var(--font-mono);font-size:12px;background:var(--color-cream-deep);border:1px solid var(--color-cream-line);border-radius:4px;padding:8px 10px;white-space:pre-wrap;color:var(--color-ink);margin:0">${_esc(JSON.stringify(item.payload ?? {}, null, 2))}</pre>
      </div>

      ${isUnread ? `
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn btn-ghost" id="inform-dismiss">Dismiss</button>
          <button class="btn btn-primary" id="inform-read">Mark as read</button>
        </div>` : `
        <div class="card" style="padding:14px 16px">
          <div class="sec-header" style="margin:0 0 6px 0">Acknowledged</div>
          <div style="font-size:12px;color:var(--color-ink-soft);font-family:var(--font-mono)">
            ${_esc(item.status)} ${item.read_by ? "by " + _esc(item.read_by) : ""}
            ${item.read_at ? "· " + _esc(item.read_at.replace("T", " ").slice(0, 19)) : ""}
          </div>
        </div>`}

      <div style="margin-top:14px;font-size:11px;font-family:var(--font-mono);color:var(--color-ink-faint)">
        run <code>${_esc((item.run_id || "").slice(0, 8))}</code> · created ${_esc((item.created_at || "").replace("T", " ").slice(0, 19))}
      </div>
    </div>`;

  if (!isUnread) return;

  const ack = async (action) => {
    try {
      if (action === "read") {
        await api.readInformItem(item.id, {});
        toastSuccess("Marked as read");
      } else {
        await api.dismissInformItem(item.id, {});
        toastSuccess("Dismissed");
      }
      _selectedId = null;
      _loadList(container.closest(".view") || container);
      refreshInboxPip();
    } catch (err) {
      toastError(err);
    }
  };

  host.querySelector("#inform-read").addEventListener("click", () => ack("read"));
  host.querySelector("#inform-dismiss").addEventListener("click", () => ack("dismiss"));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _reltime(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60)    return "just now";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function _esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
