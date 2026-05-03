import * as api from "../api.js";
import { toast, toastError, toastSuccess } from "../components/toast.js";
import { onEvent, offEvent } from "../sse.js";
import { setLastSwarm } from "../app.js";
import { _showModal } from "./org-design.js";

let _cy = null; // Cytoscape instance (module-level so cleanup can destroy it)
let _connectSource = null; // when set, the next agent click creates a new edge from this node
let _connectCleanup = null; // resets connect-mode visuals

// ── Main entry ────────────────────────────────────────────────────────────

export function renderSwarmCanvas(container, swarmId) {
  if (!swarmId) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-title">No swarm selected</div><div class="empty-state-sub">Choose a swarm from the Org view.</div></div>`;
    return null;
  }
  setLastSwarm(swarmId);

  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.height = "100%";
  container.style.overflow = "hidden";

  container.innerHTML = `
    <div class="canvas-topbar">
      <div class="canvas-crumbs" id="canvas-crumbs">Loading…</div>
      <div class="flex-row">
        <button class="btn btn-ghost btn-sm" id="btn-fit">⊡ Fit</button>
        <button class="btn btn-ghost btn-sm" id="btn-layout">⟳ Re-layout</button>
        <button class="btn btn-primary btn-sm" id="btn-run">▶ Run</button>
      </div>
    </div>
    <div class="canvas-shell" style="flex:1;overflow:hidden">
      <aside class="canvas-palette" id="canvas-palette"></aside>
      <div id="cy-container"></div>
      <aside class="canvas-inspector" id="canvas-inspector">
        <div class="insp-header"><div class="sec-header">Inspector</div></div>
        <div class="insp-section" id="insp-content">
          <div class="text-muted" style="font-size:var(--text-xs)">Click a node or edge to inspect it.</div>
        </div>
      </aside>
    </div>
    <div class="stream-bar" id="stream-bar">
      <span id="stream-label">Live event stream</span>
      <span id="stream-chev">▴ expand</span>
    </div>`;

  _buildPalette(container.querySelector("#canvas-palette"), swarmId);
  _initStreamBar(container.querySelector("#stream-bar"), container);

  let streamLog = [];
  const sseHandler = (msg) => {
    if (msg.run_id) {
      streamLog.push(msg);
      _updateStream(container, streamLog);
    }
    if (msg.type === "run.step" && msg.swarm_id === swarmId && _cy) {
      _pulseNode(msg.step_name);
    }
    if (msg.type === "run.completed" || msg.type === "run.failed") {
      setTimeout(() => { if (_cy) _cy.elements().removeClass("live"); }, 2000);
    }
  };
  onEvent("*", sseHandler);

  _loadCanvas(container, swarmId);

  container.querySelector("#btn-fit").addEventListener("click", () => _cy?.fit(undefined, 40));
  container.querySelector("#btn-layout").addEventListener("click", () => _cy && _runLayout(_cy));
  container.querySelector("#btn-run").addEventListener("click", () => _showRunModal(swarmId, container));

  // Esc cancels connect-mode; cleaned up on view teardown.
  const onKey = (e) => { if (e.key === "Escape" && _connectSource) _exitConnectMode(container); };
  document.addEventListener("keydown", onKey);

  return () => {
    offEvent("*", sseHandler);
    document.removeEventListener("keydown", onKey);
    _exitConnectMode(container);
    if (_cy) { _cy.destroy(); _cy = null; }
  };
}

// ── Connect mode ──────────────────────────────────────────────────────────
function _enterConnectMode(container, sourceNode) {
  _exitConnectMode(container);
  _connectSource = sourceNode;
  if (_cy) sourceNode.addClass("connect-source");

  const banner = document.createElement("div");
  banner.id = "connect-banner";
  banner.innerHTML = `
    <span style="font-family:var(--font-mono);font-size:12px;color:#2b2418">
      Connecting from <b>${_esc(sourceNode.data("name"))}</b> — click target agent, caller, or informer.
    </span>
    <button class="btn btn-ghost btn-sm" id="connect-cancel" style="margin-left:auto">Cancel · Esc</button>`;
  banner.style.cssText = `
    position:absolute;left:50%;top:14px;transform:translateX(-50%);
    display:flex;align-items:center;gap:12px;
    padding:8px 14px;border-radius:999px;
    background:#fffaf0;border:1.5px solid var(--color-perceptionist);
    box-shadow:0 2px 8px rgba(43,36,24,.18);
    z-index:50;`;
  const cy = container.querySelector("#cy-container");
  if (cy) cy.appendChild(banner);
  banner.querySelector("#connect-cancel")?.addEventListener("click", () => _exitConnectMode(container));

  _connectCleanup = () => {
    if (_cy && _connectSource) _connectSource.removeClass("connect-source");
    _connectSource = null;
    banner.remove();
  };
}

function _exitConnectMode(container) {
  if (_connectCleanup) { try { _connectCleanup(); } catch (_) {} _connectCleanup = null; }
  _connectSource = null;
  // Defensive cleanup of any lingering banner
  container?.querySelector("#connect-banner")?.remove();
}

// ── Load hierarchy + build graph ───────────────────────────────────────────

async function _loadCanvas(container, swarmId) {
  try {
    const [swarm, hierarchy, agents, triggers] = await Promise.all([
      api.getSwarm(swarmId),
      api.getHierarchy(swarmId),
      api.listAgents(swarmId).catch(() => []),
      api.listTriggers(swarmId).catch(() => []),
    ]);
    hierarchy.triggers = triggers || [];

    // Update breadcrumbs
    const crumbs = container.querySelector("#canvas-crumbs");
    if (crumbs) crumbs.innerHTML = `
      <span class="crumb-link" onclick="swNav('org')">Workspaces</span>
      <span class="crumb-sep">›</span>
      <span class="crumb-link">${_esc(swarm.display_name)}</span>`;

    const positions = hierarchy._gui?.positions || {};
    const agentMap = {};
    for (const a of agents) agentMap[a.name] = { id: a.id, layer: a.layer, model: a.model };
    const elements = _buildElements(hierarchy, positions, agentMap);

    // Destroy previous instance
    if (_cy) { _cy.destroy(); _cy = null; }

    _cy = window.cytoscape({
      container: container.querySelector("#cy-container"),
      elements,
      style: _cyStyles(),
      layout: { name: "preset" },
      minZoom: 0.2,
      maxZoom: 3,
    });

    // Register edgehandles for drag-to-create edges. The plugin self-registers
    // with cytoscape, so check the instance method (window.cytoscapeEdgehandles
    // is not set as a global by the UMD bundle).
    // Click-to-connect: an agent's "Connect to…" button puts the canvas in
    // connect-mode; the next agent tap opens the New connection modal. No
    // hover-handles, no edgehandles plugin — just clicks.
    _exitConnectMode(container);

    // Always re-layout on every mount — positions are ephemeral within a
    // session (dragging a node still moves it; refreshing resets the graph).
    _runLayout(_cy);

    // Belt-and-suspenders: also set the sketchify filter inline on every
    // canvas Cytoscape mounted. The CSS rule should already do this, but
    // older browsers and aggressive caches sometimes drop the cascade.
    setTimeout(() => {
      const cyEl = container.querySelector("#cy-container");
      if (!cyEl) return;
      cyEl.querySelectorAll("canvas").forEach(c => {
        c.style.filter = "url(#sketchify)";
      });
    }, 50);

    // DOM-overlay node labels — Cytoscape's own labels are rendered onto
    // the same canvas as the shapes, so they get displaced by sketchify.
    // Labels in the DOM live above the canvas and aren't filtered, so
    // they stay crisp while the shapes wobble.
    _mountLabelOverlay(container);

    // Click handlers
    _cy.on("tap", "node", e => {
      if (_connectSource) {
        const tgt = e.target;
        const srcType = _connectSource.data("type");
        if (tgt.hasClass("agent") && tgt.id() !== _connectSource.id()) {
          const sourceName = _connectSource.data("name");
          const targetName = tgt.data("name");
          _exitConnectMode(container);
          _showEdgeModal(swarmId, sourceName, targetName, hierarchy, () => _loadCanvas(container, swarmId));
          return;
        }
        if (srcType === "agent" && tgt.hasClass("caller")) {
          const sourceName = _connectSource.data("name");
          const callerName = tgt.data("name");
          _exitConnectMode(container);
          _showConnectToHumanModal(swarmId, "call", sourceName, callerName, () => _loadCanvas(container, swarmId));
          return;
        }
        if (srcType === "agent" && tgt.hasClass("informer")) {
          const sourceName = _connectSource.data("name");
          const informerName = tgt.data("name");
          _exitConnectMode(container);
          _showConnectToHumanModal(swarmId, "inform", sourceName, informerName, () => _loadCanvas(container, swarmId));
          return;
        }
        // Tapped same node or incompatible target: cancel
        _exitConnectMode(container);
      }
      _showNodeInspector(container, e.target, swarmId, hierarchy, () => _loadCanvas(container, swarmId));
    });
    _cy.on("tap", "edge", e => {
      if (_connectSource) { _exitConnectMode(container); return; }
      _showEdgeInspector(container, e.target, swarmId, hierarchy, () => _loadCanvas(container, swarmId));
    });
    _cy.on("tap", e => {
      if (e.target === _cy) {
        if (_connectSource) { _exitConnectMode(container); return; }
        _showSwarmInspector(container, swarm, swarmId, hierarchy, () => _loadCanvas(container, swarmId));
      }
    });
    _cy.on("dbltap", "node", e => {
      const d = e.target.data();
      if (d.agent_id) window.swNav(`constitution/${d.agent_id}`);
    });

    // Positions are ephemeral — drags persist for the session but the next
    // canvas mount re-runs dagre. (`_savePositions` and the `save_positions`
    // topology op are kept dormant in case we want pinning back later.)

    _showSwarmInspector(container, swarm, swarmId, hierarchy, () => _loadCanvas(container, swarmId));

  } catch (err) { toastError(err); }
}

// ── Cytoscape elements ─────────────────────────────────────────────────────

// Glyph prefix per layer / trigger kind. Geometric Unicode that renders
// reliably in IBM Plex Mono and Courier Prime — no emoji-font dependency.
const LAYER_GLYPH = {
  policy:        "◆",
  orchestrator:  "✦",
  executioner:   "◈",
  perceptionist: "◎",
};

const TRIGGER_GLYPH = {
  heartbeat:  "⏱",
  listener:   "⌬",
  invocation: "▶",
};

const CALLER_GLYPH   = "✋";   // Phase 6 — humans-in-the-loop (blocking)
const INFORMER_GLYPH = "📢";  // Phase 6.1 — fire-and-forget notifications

function _buildElements(h, positions, agentMap = {}) {
  const els = [];

  // Agent nodes
  for (const name of (h.agents || [])) {
    const pos = positions[name] || {};
    const meta = agentMap[name] || {};
    const layer = meta.layer || "executioner";
    const glyph = LAYER_GLYPH[layer] || "•";
    els.push({
      data: {
        id: name, name,
        label: `${glyph}  ${name}`,
        type: "agent",
        agent_id: meta.id,
        layer,
        model: meta.model || null,
      },
      position: pos.x ? pos : undefined,
      classes: `agent layer-${layer}`,
    });
  }

  // Trigger nodes (real DB-backed records). Each becomes a hexagon node;
  // when there's an entry_point agent we render a "fires" edge into it so
  // the dataflow is visible.
  const entryPoint = h.entry_point;
  for (const trigger of (h.triggers || [])) {
    const tname = (typeof trigger === "string") ? trigger : trigger.name;
    const tid   = (typeof trigger === "string") ? `trigger__${tname}` : `trigger__${trigger.id || tname}`;
    const kind  = (typeof trigger === "string") ? "" : (trigger.kind || "");
    const pos   = positions[tid] || {};
    const tglyph = TRIGGER_GLYPH[kind] || "✺";
    els.push({
      data: {
        id: tid,
        name: tname,
        // Single-line label; the trigger kind is rendered as a meta line by
        // the DOM overlay so we don't need the inline `[kind]` tag any more.
        label: `${tglyph}  ${tname}`,
        type: "trigger",
        trigger_id: (typeof trigger === "object") ? trigger.id : null,
        trigger_kind: kind,
        trigger_enabled: (typeof trigger === "object") ? trigger.enabled : true,
        trigger_config: (typeof trigger === "object") ? trigger.config : {},
      },
      position: pos.x ? pos : undefined,
      classes: "trigger",
    });
    // Phase 6.1: each trigger may declare its own target_agent in config.
    // Fall back to the swarm entry_point if not set.
    const triggerCfg = (typeof trigger === "object") ? (trigger.config || {}) : {};
    const fireTarget = triggerCfg.target_agent || entryPoint;
    if (fireTarget) {
      els.push({
        data: {
          id: `tedge_${tid}`,
          source: tid,
          target: fireTarget,
          kind: "fires",
          purpose: `${kind || "trigger"} fires event into ${fireTarget}`,
          label: "fires",
        },
        classes: "edge-fires",
      });
    }
  }

  // Skill nodes (one per unique skill reference)
  const skills = new Set((h.skills || []).map(s => s.skill));
  for (const skill of skills) {
    const sid = `skill__${skill}`;
    els.push({ data: { id: sid, name: skill, label: skill.split("/").pop(), type: "skill" }, classes: "skill" });
  }

  // Perceptionist nodes
  const percs = new Set((h.consultations || []).map(c => c.perceptionist));
  for (const perc of percs) {
    const pid = `perc__${perc}`;
    els.push({ data: { id: pid, name: perc, label: perc.split("/").pop(), type: "perceptionist" }, classes: "perceptionist" });
  }

  // Hierarchical edges
  for (const e of (h.edges || [])) {
    els.push({ data: { id: `e_${e.from}_${e.to}_${e.kind}`, source: e.from, target: e.to, kind: e.kind, purpose: e.purpose, label: _truncate(e.purpose, 28) }, classes: `edge-${e.kind}` });
  }

  // Consultation edges
  for (const c of (h.consultations || [])) {
    els.push({ data: { id: `c_${c.agent}_${c.perceptionist}`, source: c.agent, target: `perc__${c.perceptionist}`, kind: "consult", purpose: c.purpose, label: _truncate(c.purpose, 24) }, classes: "edge-consult" });
  }

  // Skill connection edges
  for (const s of (h.skills || [])) {
    els.push({ data: { id: `s_${s.agent}_${s.skill}`, source: s.agent, target: `skill__${s.skill}`, kind: "skill", purpose: s.purpose, label: _truncate(s.purpose, 24) }, classes: "edge-skill" });
  }

  // Caller nodes — from canvas_callers list; also include any referenced in calls
  // for backward compatibility with hierarchies created before canvas_callers existed.
  const callers = new Set([
    ...(h.canvas_callers || []),
    ...(h.calls || []).map(c => c.caller),
  ]);
  for (const caller of callers) {
    const cid = `caller__${caller}`;
    els.push({
      data: {
        id: cid,
        name: caller,
        label: `${CALLER_GLYPH}  ${caller.split("/").pop()}`,
        type: "caller",
      },
      classes: "caller",
    });
  }

  // Call edges (agent → caller)
  for (const c of (h.calls || [])) {
    els.push({
      data: {
        id: `call_${c.agent}_${c.caller}`,
        source: c.agent,
        target: `caller__${c.caller}`,
        kind: "call",
        purpose: c.purpose,
        label: _truncate(c.purpose, 24),
      },
      classes: "edge-call",
    });
  }

  // Informer nodes — from canvas_informers list; also include any referenced in informs.
  const informers = new Set([
    ...(h.canvas_informers || []),
    ...(h.informs || []).map(i => i.informer),
  ]);
  for (const informer of informers) {
    const iid = `informer__${informer}`;
    els.push({
      data: {
        id: iid,
        name: informer,
        label: `${INFORMER_GLYPH}  ${informer.split("/").pop()}`,
        type: "informer",
      },
      classes: "informer",
    });
  }

  // Inform edges (agent → informer)
  for (const i of (h.informs || [])) {
    els.push({
      data: {
        id: `inform_${i.agent}_${i.informer}`,
        source: i.agent,
        target: `informer__${i.informer}`,
        kind: "inform",
        purpose: i.purpose,
        label: _truncate(i.purpose, 24),
      },
      classes: "edge-inform",
    });
  }

  return els;
}

function _cyStyles() {
  // Warm parchment / sketchbook palette — matches CSS tokens
  const POLICY        = "#1e3a5f";
  const ORCHESTRATOR  = "#2a6b6b";
  const EXECUTIONER   = "#3d4f7c";
  const PERCEPTIONIST = "#c97c2a";
  const INK           = "#2b2418";
  const INK_FAINT     = "#a09070";
  const CREAM         = "#faf7f2";
  const PARCHMENT     = "#f5f0e8";
  const CREAM_LINE    = "#c8bfaa";

  // Soft layer tints for backgrounds — close to parchment, just a whisper
  // of the layer hue so the canvas stays warm and unified.
  const POLICY_SOFT        = "#e8edf3";
  const ORCHESTRATOR_SOFT  = "#e2efef";
  const EXECUTIONER_SOFT   = "#e6eaf2";
  const PERCEPTIONIST_SOFT = "#f4e6d4";
  const TRIGGER_SOFT       = "#f0e6d6";

  // Sticker rim — slightly lighter than the parchment canvas so each node
  // looks die-cut and lifted off the surface, not just a flat panel.
  const STICKER_RIM = "#fffcf6";

  return [
    // ── Base node. The SVG turbulence filter on the canvas wobbles every
    //    stroke, so what Cytoscape draws as a perfect rectangle reaches the
    //    viewer as a pencil-on-parchment shape. Node labels are hidden
    //    (`text-opacity: 0`) and re-rendered as DOM overlays via
    //    `_mountLabelOverlay()` so the text stays crisp while shapes wobble.
    //    Cytoscape does not support CSS `outline-*` properties — only
    //    `border-*`, `background-*`, `shadow-*`, `overlay-*`. ──
    { selector: "node", style: {
      label: "data(label)",
      "text-opacity": 0,
      "text-valign": "center", "text-halign": "center",
      "font-family": "'Caveat', 'Architects Daughter', cursive",
      "font-size": 16,
      "font-weight": 400,
      "text-wrap": "wrap",
      "text-max-width": 158,
      width: 184, height: 78,
      shape: "round-rectangle",
      "border-width": 2.5,
      "border-color": CREAM_LINE,
      "background-color": CREAM,
      color: INK,
      "shadow-blur": 18,
      "shadow-color": INK,
      "shadow-opacity": .22,
      "shadow-offset-x": 3,
      "shadow-offset-y": 6,
      padding: "10px",
    }},

    // ── Agents — softly tinted background, layer-coloured text + border ──
    { selector: ".agent", style: {
      "background-color": CREAM,
      "border-color": CREAM_LINE,
      color: INK,
    }},
    { selector: "[type='agent'][layer='policy']", style: {
      "background-color": POLICY_SOFT,
      "border-color": POLICY,
      color: POLICY,
    }},
    { selector: "[type='agent'][layer='orchestrator']", style: {
      "background-color": ORCHESTRATOR_SOFT,
      "border-color": ORCHESTRATOR,
      color: ORCHESTRATOR,
    }},
    { selector: "[type='agent'][layer='executioner']", style: {
      "background-color": EXECUTIONER_SOFT,
      "border-color": EXECUTIONER,
      color: EXECUTIONER,
    }},
    { selector: "[type='agent'][layer='perceptionist']", style: {
      "background-color": PERCEPTIONIST_SOFT,
      "border-color": PERCEPTIONIST,
      "border-style": "dashed",
      color: PERCEPTIONIST,
      // Perceptionists are read-only grounding agents — give them a visual
      // cue (eye-shaped ellipse) that distinguishes them from actors.
      shape: "ellipse",
      width: 196, height: 90,
    }},

    // ── Perceptionist consultation targets (the eye-of-truth nodes that
    //    aren't agents themselves but are referenced by consultations) ──
    { selector: ".perceptionist", style: {
      "background-color": PERCEPTIONIST_SOFT,
      "border-color": PERCEPTIONIST,
      "border-style": "dashed",
      color: PERCEPTIONIST,
      shape: "ellipse",
      width: 168, height: 64,
    }},

    // ── Skills — soft pill on parchment, dashed faint border ──
    { selector: ".skill", style: {
      "background-color": PARCHMENT,
      color: INK,
      "border-style": "dashed",
      "border-color": INK_FAINT,
      "border-width": 1.5,
      shape: "barrel",
      width: 152, height: 44,
      "font-size": 14,
      "shadow-blur": 12,
      "shadow-opacity": .14,
      "shadow-offset-y": 4,
    }},

    // ── Triggers — round-tag shape in soft amber, parchment-friendly ──
    { selector: ".trigger", style: {
      "background-color": TRIGGER_SOFT,
      color: PERCEPTIONIST,
      "border-color": PERCEPTIONIST,
      shape: "round-tag",
      width: 168, height: 72,
      "font-size": 14,
      "font-weight": 400,
    }},

    // ── Callers (Phase 6) — sage-green speech bubble for humans-in-loop ──
    { selector: ".caller", style: {
      "background-color": "#dfe8df",
      color: "#3f5f3f",
      "border-color": "#6b8e6b",
      "border-width": 2.5,
      shape: "round-tag",
      width: 176, height: 78,
      "font-size": 16,
      "font-weight": 500,
    }},

    // ── Informers (Phase 6.1) — slate-blue ellipse for fire-and-forget notify ──
    { selector: ".informer", style: {
      "background-color": "#dde6f0",
      color: "#3a5570",
      "border-color": "#5b7fa6",
      "border-width": 2,
      shape: "ellipse",
      width: 176, height: 72,
      "font-size": 15,
      "font-weight": 500,
    }},

    // ── State ──
    { selector: "node:selected", style: {
      "overlay-color": PERCEPTIONIST,
      "overlay-opacity": .10,
      "border-width": 2,
      "border-color": PERCEPTIONIST,
    }},
    { selector: ".connect-source", style: {
      "border-width": 2.5,
      "border-color": PERCEPTIONIST,
      "overlay-color": PERCEPTIONIST,
      "overlay-opacity": .08,
    }},
    { selector: ".live", style: {
      "border-color": PERCEPTIONIST, "border-width": 2.5,
      "shadow-blur": 18, "shadow-color": PERCEPTIONIST, "shadow-opacity": .8,
    }},

    // ── Edges — labels hidden by default, shown on hover/select.
    //    Slightly thicker than 2016-default to read as actual connecting
    //    cords against the sticker nodes; rounded line caps keep them soft.
    { selector: "edge", style: {
      "font-size": 13,
      "font-family": "'Caveat', 'Architects Daughter', cursive",
      color: INK,
      "text-background-color": STICKER_RIM,
      "text-background-opacity": 1,
      "text-background-padding": "4px",
      "text-background-shape": "roundrectangle",
      "text-border-color": CREAM_LINE,
      "text-border-width": 1,
      "text-border-opacity": 1,
      "curve-style": "bezier",
      "target-arrow-shape": "triangle-backcurve",
      "arrow-scale": 1.2,
      "line-color": INK_FAINT,
      "target-arrow-color": INK_FAINT,
      width: 2,
      label: "",
    }},
    { selector: "edge:selected, edge:active", style: {
      label: "data(label)",
      width: 3,
    }},
    { selector: ".edge-delegate",
      style: { "line-color": POLICY, "target-arrow-color": POLICY }},
    { selector: ".edge-escalate",
      style: { "line-color": PERCEPTIONIST, "target-arrow-color": PERCEPTIONIST }},
    { selector: ".edge-report",
      style: { "line-color": EXECUTIONER, "target-arrow-color": EXECUTIONER, "line-style": "dashed" }},
    { selector: ".edge-consult",
      style: { "line-color": PERCEPTIONIST, "target-arrow-color": PERCEPTIONIST, "line-style": "dashed", "target-arrow-shape": "none" }},
    { selector: ".edge-skill",
      style: { "line-color": INK_FAINT, "target-arrow-color": INK_FAINT, "line-style": "dotted" }},
    { selector: ".edge-fires",
      style: { "line-color": ORCHESTRATOR, "target-arrow-color": ORCHESTRATOR }},

    // ── Call edge (agent → caller; Phase 6) ──
    { selector: ".edge-call", style: {
      "line-color": "#6b8e6b",
      "target-arrow-color": "#6b8e6b",
      "line-style": "solid",
      width: 2.5,
    }},

    // ── Inform edge (agent → informer; Phase 6.1) — dashed, no arrowhead ──
    { selector: ".edge-inform", style: {
      "line-color": "#5b7fa6",
      "target-arrow-color": "#5b7fa6",
      "line-style": "dashed",
      "target-arrow-shape": "none",
      width: 2,
    }},
  ];
}

function _runLayout(cy) {
  cy.layout({
    name: "dagre",
    rankDir: "TB",
    nodeSep: 80,
    rankSep: 110,
    edgeSep: 30,
    padding: 60,
    animate: true,
    animationDuration: 400,
  }).run();
}

// ── DOM label overlay ────────────────────────────────────────────────────────
//
// Cytoscape paints node labels onto the same <canvas> as the shapes, so the
// sketchify filter wobbles them. Putting labels in a DOM <div> sibling that
// sits above the canvas keeps them crisp — CSS filters don't cross element
// boundaries unless we apply them again, and we never do.
//
// The overlay is a single absolute-positioned div containing one inner div
// per node. Positions and font-size are recomputed on pan / zoom / drag /
// box-end events so labels track Cytoscape's viewport transform. Labels are
// `pointer-events: none` so taps still hit the canvas underneath.

function _mountLabelOverlay(container) {
  const cyEl = container.querySelector("#cy-container");
  if (!cyEl || !_cy) return;

  // Clear any prior overlay (canvas re-mounts replace _cy)
  const existing = cyEl.querySelector(".cy-label-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "cy-label-overlay";
  cyEl.appendChild(overlay);

  // Build one label div per node, classed for layer/type-based styling.
  // Structured label (UX hierarchy):
  //   • `cy-label-name` — primary, large, layer-coloured handwritten name
  //   • `cy-label-meta` — secondary, small, muted typewriter line with
  //                        role + model (or trigger kind, etc.)
  const labelMap = new Map();
  _cy.nodes().forEach(n => {
    const data = n.data();
    const layer = data.layer || "";
    const cls = [
      "cy-label",
      `cy-label-${data.type || "node"}`,
      layer ? `cy-label-layer-${layer}` : "",
    ].join(" ");

    const div = document.createElement("div");
    div.className = cls;
    div.innerHTML = _buildLabelHtml(data);
    overlay.appendChild(div);
    labelMap.set(n.id(), div);
  });

  const update = () => {
    const z = _cy.zoom();
    _cy.nodes().forEach(n => {
      const div = labelMap.get(n.id());
      if (!div) return;
      const p = n.renderedPosition();
      div.style.left = p.x + "px";
      div.style.top  = p.y + "px";
      // Font size scales with Cytoscape's zoom so labels stay proportional
      // to the (wobbly) shapes underneath.
      div.style.fontSize = (16 * z).toFixed(1) + "px";
    });
  };

  _cy.on("pan zoom", update);
  _cy.on("position", "node", update);
  _cy.on("layoutstop", update);
  // Initial pass — wait one tick so layout has settled into renderedPosition.
  setTimeout(update, 60);
}

/**
 * Build the inner HTML for a node's DOM label. Two-tier hierarchy:
 *   • name line: glyph + name, big, handwritten
 *   • meta line: role · model (agents) / kind (triggers), small, muted mono
 */
function _buildLabelHtml(data) {
  const name = `<div class="cy-label-name">${_esc(data.label || data.name || "")}</div>`;

  let metaParts = [];
  if (data.type === "agent") {
    if (data.layer) metaParts.push(data.layer);
    if (data.model) metaParts.push(_shortModel(data.model));
  } else if (data.type === "trigger" && data.trigger_kind) {
    metaParts.push(data.trigger_kind);
  }

  const meta = metaParts.length
    ? `<div class="cy-label-meta">${metaParts.map(_esc).join(" · ")}</div>`
    : "";

  return name + meta;
}

/**
 * Trim long model identifiers so they don't overflow the node bounds.
 * Keeps the first family token + the last short identifier so e.g.
 * "claude-opus-4-7-2026-01-15-v1" → "claude-opus-4-7".
 */
function _shortModel(model) {
  if (!model) return "";
  // Strip everything after the first 16 chars of meaningful identifier;
  // most readable tail is the version (-4-7 / -3-5-sonnet, etc.).
  if (model.length <= 22) return model;
  return model.slice(0, 22) + "…";
}

async function _savePositions(swarmId, cy) {
  const positions = {};
  cy.nodes().forEach(n => {
    const p = n.position();
    positions[n.data("name")] = { x: Math.round(p.x), y: Math.round(p.y) };
  });
  try {
    await api.patchTopology(swarmId, "save_positions", { positions });
  } catch (_) {}
}

// ── Inspector panels ───────────────────────────────────────────────────────

function _showSwarmInspector(container, swarm, swarmId, hierarchy, reload) {
  const insp = container.querySelector("#insp-content");
  const agents = (hierarchy && hierarchy.agents) || [];
  const ep = hierarchy && hierarchy.entry_point;
  const epOpts = agents.map(a =>
    `<option value="${_esc(a)}" ${a === ep ? "selected" : ""}>${_esc(a)}</option>`
  ).join("");

  insp.innerHTML = `
    <div class="insp-label">Swarm</div>
    <div class="insp-node-name">${_esc(swarm.display_name)}</div>
    <div class="insp-node-layer">${_esc(swarm.description || "")}</div>

    <div style="margin-top:12px">
      <div class="insp-label">Entry point</div>
      <div style="font-size:11px;color:var(--color-ink-soft);font-family:var(--font-mono);margin-bottom:6px">
        Default agent triggers fire into when they don't override.
      </div>
      <select class="form-input" id="swarm-entry-point" style="font-size:12px">
        <option value="" ${!ep ? "selected" : ""}>— none —</option>
        ${epOpts}
      </select>
    </div>

    <div style="margin-top:12px">
      <div class="insp-label">Runs</div>
      <div style="font-size:var(--text-sm)">${swarm.run_count ?? "—"} total runs</div>
    </div>

    <div class="insp-btn-row" style="margin-top:auto;padding-top:12px;flex-direction:column;gap:6px">
      <button class="btn btn-secondary btn-sm" onclick="swNav('runs?swarm=${swarm.id}')">View runs</button>
      <button class="btn btn-danger btn-sm" id="insp-del-swarm">Delete swarm</button>
    </div>`;

  insp.querySelector("#insp-del-swarm")?.addEventListener("click", async () => {
    if (!confirm(`Delete swarm "${swarm.display_name}"? This cannot be undone.`)) return;
    try {
      await api.deleteSwarm(swarmId);
      toastSuccess("Swarm deleted");
      window.swNav("org");
    } catch (err) { toastError(err); }
  });

  // Persist entry-point change immediately. Reload the canvas so the
  // fires-edge re-targets to the new agent (or vanishes if cleared).
  insp.querySelector("#swarm-entry-point")?.addEventListener("change", async (e) => {
    const newEp = e.target.value || null;
    try {
      await api.patchTopology(swarmId, "set_entry_point", { name: newEp });
      toastSuccess(newEp ? `Entry point set to "${newEp}"` : "Entry point cleared");
      if (reload) reload();
    } catch (err) { toastError(err); }
  });
}

function _showNodeInspector(container, node, swarmId, hierarchy, reload) {
  const d = node.data();
  const insp = container.querySelector("#insp-content");
  const isAgent = d.type === "agent";
  const isCaller = d.type === "caller";
  const isInformer = d.type === "informer";

  const outgoing = _cy.edges().filter(e => e.data("source") === d.id);
  const incoming = _cy.edges().filter(e => e.data("target") === d.id);

  const connList = (edges, dir) => edges.map(e => `
    <div class="insp-conn">
      <span>${dir === "out" ? "→" : "←"} <b>${e.data(dir === "out" ? "target" : "source")}</b></span>
      <span class="insp-conn-kind">${e.data("kind")}</span>
    </div>
    <div class="insp-conn-purpose">${_esc(e.data("purpose") || "")}</div>`).join("");

  const isTrigger = d.type === "trigger";
  const triggerCfgStr = isTrigger ? JSON.stringify(d.trigger_config || {}, null, 2) : "";
  const triggerTarget = isTrigger ? (d.trigger_config?.target_agent || null) : null;

  insp.innerHTML = `
    <div class="insp-label">Selected</div>
    <div class="insp-node-name">${_esc(d.name)}</div>
    <div class="insp-node-layer">${d.type}${d.layer ? ` · ${d.layer}` : ""}${isTrigger && d.trigger_kind ? ` · ${d.trigger_kind}` : ""}</div>
    ${isTrigger ? `
      <div style="margin-top:10px">
        <div class="insp-label">Fires into</div>
        <div style="font-family:var(--font-mono);font-size:11px;color:var(--color-ink)">
          ${triggerTarget
            ? `<b>${_esc(triggerTarget)}</b>`
            : `<span style="color:var(--color-ink-faint)">swarm entry_point</span>`}
        </div>
      </div>` : ""}
    ${isTrigger && triggerCfgStr !== "{}" ? `
      <div style="margin-top:10px">
        <div class="insp-label">Config</div>
        <pre style="font-family:var(--font-mono);font-size:10px;background:var(--color-card);border:1px solid var(--color-cream-line);border-radius:4px;padding:6px 8px;white-space:pre-wrap;color:var(--color-ink)">${_esc(triggerCfgStr)}</pre>
      </div>` : ""}
    ${outgoing.length ? `<div style="margin-top:10px"><div class="insp-label">Outgoing</div>${connList(outgoing.toArray(), "out")}</div>` : ""}
    ${incoming.length ? `<div style="margin-top:10px"><div class="insp-label">Incoming</div>${connList(incoming.toArray(), "in")}</div>` : ""}
    ${isAgent ? `
      <div class="insp-btn-row" style="flex-direction:column;gap:6px;padding-top:12px">
        <button class="btn btn-primary btn-sm" id="insp-edit-const" ${d.agent_id ? "" : "disabled title='Agent not yet registered'"}>Edit constitution</button>
        <button class="btn btn-secondary btn-sm" id="insp-connect">Connect to…</button>
        <button class="btn btn-secondary btn-sm" id="insp-attach-skill">Attach skill…</button>
        <button class="btn btn-ghost btn-sm" id="insp-del-node">Remove from swarm</button>
      </div>` : isTrigger ? `
      <div class="insp-btn-row" style="flex-direction:column;gap:6px;padding-top:12px">
        ${d.trigger_kind === "invocation" ? `<button class="btn btn-primary btn-sm" id="insp-invoke-trigger">Fire now…</button>` : ""}
        <button class="btn btn-secondary btn-sm" id="insp-edit-trigger">Edit target / config…</button>
        <button class="btn btn-ghost btn-sm" id="insp-del-node">Delete trigger</button>
      </div>` : (isCaller || isInformer) ? `
      <div class="insp-btn-row" style="flex-direction:column;gap:6px;padding-top:12px">
        <div style="font-size:11px;color:var(--color-ink-faint);font-family:var(--font-mono)">
          Connect via an agent node: select the agent, then click "Connect to…"
        </div>
        <button class="btn btn-ghost btn-sm" id="insp-del-node">Disconnect from swarm</button>
      </div>` : `
      <div class="insp-btn-row">
        <button class="btn btn-ghost btn-sm" id="insp-del-node">Remove</button>
      </div>`}`;

  if (isAgent && d.agent_id) {
    insp.querySelector("#insp-edit-const")?.addEventListener("click", () => window.swNav(`constitution/${d.agent_id}`));
  }
  if (isAgent) {
    insp.querySelector("#insp-attach-skill")?.addEventListener("click", () =>
      _showAttachSkillModal(swarmId, d.name, reload));
    insp.querySelector("#insp-connect")?.addEventListener("click", () =>
      _enterConnectMode(container, node));
  }

  if (isTrigger && d.trigger_id) {
    insp.querySelector("#insp-edit-trigger")?.addEventListener("click", () =>
      _showEditTriggerModal(swarmId, d, reload));
  }

  if (isTrigger && d.trigger_kind === "invocation" && d.trigger_id) {
    insp.querySelector("#insp-invoke-trigger")?.addEventListener("click", () =>
      _showInvokeTriggerModal(d, reload));
  }

  insp.querySelector("#insp-del-node")?.addEventListener("click", async () => {
    const confirmMsg = isAgent ? `Remove agent "${d.name}" from topology?`
      : isTrigger ? `Delete trigger "${d.name}"?`
      : (isCaller || isInformer) ? `Disconnect "${d.name}" from this swarm? This removes all connections to it.`
      : `Remove "${d.name}"?`;
    if (!confirm(confirmMsg)) return;
    try {
      if (isAgent) {
        await api.patchTopology(swarmId, "remove_agent", { name: d.name });
        toastSuccess(`Agent "${d.name}" removed`);
      } else if (isTrigger && d.trigger_id) {
        await api.deleteTrigger(d.trigger_id);
        toastSuccess(`Trigger "${d.name}" deleted`);
      } else if (isCaller) {
        await api.patchTopology(swarmId, "remove_canvas_caller", { caller: d.name });
        toastSuccess(`Caller "${d.name}" removed`);
      } else if (isInformer) {
        await api.patchTopology(swarmId, "remove_canvas_informer", { informer: d.name });
        toastSuccess(`Informer "${d.name}" removed`);
      } else {
        node.remove();
      }
      reload();
    } catch (err) { toastError(err); }
  });
}

function _showEdgeInspector(container, edge, swarmId, hierarchy, reload) {
  const d = edge.data();
  const isFires = d.kind === "fires";
  const isHumanEdge = d.kind === "call" || d.kind === "inform";
  const insp = container.querySelector("#insp-content");
  // Strip internal prefixes from the target label for human edges
  const targetLabel = d.target.replace(/^(caller__|informer__)/, "");
  insp.innerHTML = `
    <div class="insp-label">Edge</div>
    <div class="insp-node-name" style="font-size:var(--text-sm)">${_esc(d.source)} → ${_esc(targetLabel)}</div>
    <div class="insp-node-layer">${d.kind}</div>
    <div style="margin-top:10px">
      <div class="insp-label">Purpose</div>
      <div style="font-size:var(--text-xs);color:var(--color-text);font-style:italic;line-height:1.5">${_esc(d.purpose || "—")}</div>
    </div>
    ${isFires ? `<div class="insp-section" style="border:none;padding:8px 0 0;font-size:var(--text-xs);color:var(--color-ink-faint);font-family:var(--font-mono)">Trigger flow — managed automatically. Delete the trigger node to remove.</div>` : `
    <div class="insp-btn-row" style="flex-direction:column;gap:6px;padding-top:12px">
      ${!isHumanEdge ? `<button class="btn btn-ghost btn-sm" id="insp-edit-edge">Edit purpose</button>` : ""}
      <button class="btn btn-ghost btn-sm" id="insp-del-edge">Delete edge</button>
    </div>`}`;

  if (isFires) return;

  insp.querySelector("#insp-edit-edge")?.addEventListener("click", () => {
    _showEditPurposeModal(swarmId, d, reload);
  });
  insp.querySelector("#insp-del-edge").addEventListener("click", async () => {
    if (!confirm("Delete this edge?")) return;
    try {
      const op = d.kind === "consult"  ? "remove_consultation" :
        d.kind === "skill"             ? "remove_skill_connection" :
        d.kind === "call"              ? "remove_call" :
        d.kind === "inform"            ? "remove_inform" : "remove_edge";
      const params = d.kind === "consult" ? { agent: d.source, perceptionist: d.purpose } :
        d.kind === "skill"   ? { agent: d.source, skill: d.target.replace("skill__", "") } :
        d.kind === "call"    ? { agent: d.source, caller: d.target.replace("caller__", "") } :
        d.kind === "inform"  ? { agent: d.source, informer: d.target.replace("informer__", "") } :
        { from: d.source, to: d.target, kind: d.kind };
      await api.patchTopology(swarmId, op, params);
      toastSuccess("Edge removed");
      reload();
    } catch (err) { toastError(err); }
  });
}

// ── Palette ────────────────────────────────────────────────────────────────

function _buildPalette(pal, swarmId) {
  const layers = [
    { layer: "policy",       label: "Policy",       cls: "pal-dot-policy" },
    { layer: "orchestrator", label: "Orchestrator", cls: "pal-dot-orchestrator" },
    { layer: "executioner",  label: "Executioner",  cls: "pal-dot-executioner" },
    { layer: "perceptionist",label: "Perceptionist",cls: "pal-dot-perceptionist" },
  ];

  const triggers = [
    { kind: "heartbeat",  label: "Heartbeat",  cls: "pal-dot-trigger" },
    { kind: "listener",   label: "Listener",   cls: "pal-dot-trigger" },
    { kind: "invocation", label: "Invocation", cls: "pal-dot-trigger" },
  ];

  pal.innerHTML = `
    <div class="sec-header">Add agent</div>
    ${layers.map(l => `
      <div class="pal-item" data-layer="${l.layer}" draggable="true">
        <span class="pal-dot ${l.cls}"></span>
        ${l.label}
      </div>`).join("")}
    <hr class="pal-sep">
    <div class="sec-header">Add trigger</div>
    ${triggers.map(t => `
      <div class="pal-item" data-trigger-kind="${t.kind}">
        <span class="pal-dot ${t.cls}"></span>
        ${t.label}
      </div>`).join("")}
    <hr class="pal-sep">
    <div class="sec-header">Add caller</div>
    <div class="pal-item" id="pal-add-caller">
      <span class="pal-dot pal-dot-caller"></span>
      Caller (human-in-loop)
    </div>
    <hr class="pal-sep">
    <div class="sec-header">Add informer</div>
    <div class="pal-item" id="pal-add-informer">
      <span class="pal-dot pal-dot-informer"></span>
      Informer (notify only)
    </div>`;

  const reload = () => {
    const container = document.querySelector(".view");
    if (container) _loadCanvas(container, swarmId);
  };

  pal.querySelectorAll(".pal-item[data-layer]").forEach(item => {
    item.addEventListener("click", () => _showAddAgentModal(swarmId, item.dataset.layer, reload));
  });

  pal.querySelectorAll(".pal-item[data-trigger-kind]").forEach(item => {
    item.addEventListener("click", () => _showAddTriggerModal(swarmId, item.dataset.triggerKind, reload));
  });

  pal.querySelector("#pal-add-caller").addEventListener("click", () =>
    _showAddCallerModal(swarmId, reload));

  pal.querySelector("#pal-add-informer").addEventListener("click", () =>
    _showAddInformerModal(swarmId, reload));
}

// ── Modals ─────────────────────────────────────────────────────────────────

function _showAddAgentModal(swarmId, layer, onDone) {
  _showModal(`Add ${layer}`, `
    <div class="form-group">
      <label class="form-label">Agent name (filename slug)</label>
      <input class="form-input" id="m-name" type="text" placeholder="e.g. invoice-orchestrator">
    </div>
    <div class="form-group">
      <label class="form-label">Model</label>
      <select class="form-select" id="m-model">
        <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
        <option value="claude-opus-4-7">Claude Opus 4.7</option>
        <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
      </select>
    </div>`,
    async () => {
      const name = document.getElementById("m-name")?.value.trim().replace(/\s+/g, "-");
      if (!name) throw { message: "Name is required" };
      await api.patchTopology(swarmId, "add_agent", {
        name, layer,
        model: document.getElementById("m-model")?.value || "claude-sonnet-4-6",
      });
      toastSuccess(`Agent "${name}" added`);
      onDone();
    }
  );
  setTimeout(() => document.getElementById("m-name")?.focus(), 50);
}

export async function _showAttachSkillModal(swarmId, agentName, onDone) {
  // Resolve scope chain (swarm → workspace → company) and list all skills.
  let workspaceId = null;
  try {
    const swarm = await api.getSwarm(swarmId);
    workspaceId = swarm.workspace_id;
  } catch (_) {}

  let groups = [];
  try {
    const [swarmSkills, wsSkills, companySkills] = await Promise.all([
      api.listSkills({ scope: "swarm",     swarm_id: swarmId }).catch(() => []),
      workspaceId
        ? api.listSkills({ scope: "workspace", workspace_id: workspaceId }).catch(() => [])
        : Promise.resolve([]),
      api.listSkills({ scope: "company" }).catch(() => []),
    ]);
    groups = [
      { label: "Swarm",     scope: "swarm",     items: swarmSkills },
      { label: "Workspace", scope: "workspace", items: wsSkills },
      { label: "Company",   scope: "company",   items: companySkills },
    ];
  } catch (err) { toastError(err); return; }

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const refMaker = (scope, name) =>
    scope === "swarm" ? name : (scope === "workspace" ? `workspace/${name}` : `company/${name}`);

  const optionsHtml = total === 0
    ? `<div class="empty-state" style="padding:16px"><div class="empty-state-sub">No skills exist yet.</div><a class="btn btn-secondary btn-sm" href="#library/skills" style="margin-top:8px">Open Library to create one</a></div>`
    : groups.filter(g => g.items.length).map(g => `
        <div style="margin-bottom:12px">
          <div class="form-label" style="margin-bottom:4px">${g.label} scope</div>
          ${g.items.map(s => `
            <label style="display:flex;gap:8px;align-items:center;padding:6px 8px;border:1px solid var(--color-cream-line);border-radius:6px;background:var(--color-card);margin-bottom:4px;cursor:pointer">
              <input type="radio" name="m-skill" value="${_esc(refMaker(g.scope, s.name))}" style="accent-color:var(--color-perceptionist)">
              <span style="font-family:var(--font-mono);font-size:12px;color:var(--color-ink)">${_esc(s.name)}</span>
              <span style="font-size:11px;color:var(--color-ink-faint);flex:1">${_esc(s.description || "")}</span>
            </label>`).join("")}
        </div>`).join("");

  _showModal(`Attach skill to "${agentName}"`, `
    <div style="font-size:11px;color:var(--color-ink-soft);margin-bottom:12px;font-family:var(--font-mono)">
      Skills are resolved most-local-first. Pick one and provide a purpose — that string becomes the audit-trail entry on every call.
    </div>
    ${optionsHtml}
    ${total > 0 ? `
      <div class="form-group" style="margin-top:12px">
        <label class="form-label">Purpose <span style="color:var(--color-danger)">*</span></label>
        <textarea class="form-textarea" id="m-purpose" placeholder="Why does ${agentName} call this skill?" style="min-height:60px"></textarea>
        <div class="form-helper">Required. Becomes the <code style="font-family:var(--font-mono)">edge_purpose</code> recorded for every invocation.</div>
      </div>` : ""}`,
    async () => {
      if (total === 0) { onDone(); return; }
      const picked = document.querySelector('input[name="m-skill"]:checked')?.value;
      if (!picked) throw { message: "Pick a skill" };
      const purpose = document.getElementById("m-purpose")?.value.trim();
      if (!purpose) throw { message: "Purpose is required" };
      await api.patchTopology(swarmId, "add_skill_connection", {
        agent: agentName, skill: picked, purpose,
      });
      toastSuccess(`Skill "${picked}" attached to ${agentName}`);
      onDone();
    },
    "Attach skill"
  );
}

// ── Add Caller modal (Phase 6) ───────────────────────────────────────────────
// Places a caller node on the canvas with no connections. The user then
// connects it to an agent via connect-mode (agent → "Connect to…" → click caller).

async function _showAddCallerModal(swarmId, onDone) {
  const allCallers = await api.listCallers().catch(() => []);

  const callerOpts = allCallers.length
    ? allCallers.map(c => `<option value="${_esc(c.name)}">${_esc(c.display_name)} — ${_esc(c.scope)}</option>`).join("")
    : `<option value="" disabled>(none yet — create a new one below)</option>`;

  _showModal("Add Caller node", `
    <div style="font-size:11px;color:var(--color-ink-soft);font-family:var(--font-mono);margin-bottom:12px">
      Places the caller on the canvas. Connect it to an agent afterwards by selecting the agent and clicking "Connect to…".
    </div>

    <div class="form-group">
      <label class="form-label">Use existing Caller</label>
      <select class="form-input" id="m-call-existing">
        <option value="">— or create a new one below —</option>
        ${callerOpts}
      </select>
    </div>

    <hr style="border:none;border-top:1px dashed var(--color-cream-line);margin:14px 0">

    <div class="form-group">
      <label class="form-label">…or new Caller name</label>
      <input class="form-input" id="m-call-new-name" placeholder="e.g. finance-approver">
      <div class="form-helper">Lowercase, hyphens. Created at <strong>company</strong> scope.</div>
    </div>
    <div class="form-group">
      <label class="form-label">Display name</label>
      <input class="form-input" id="m-call-new-display" placeholder="Finance approver">
    </div>
    <div class="form-group">
      <label class="form-label">Briefing (markdown shown in the inbox)</label>
      <textarea class="form-input" id="m-call-new-body" rows="3"
        style="font-family:var(--font-mono);font-size:12px;resize:vertical"
        placeholder="What this human role is responsible for…"></textarea>
    </div>`,
    async () => {
      const existing = document.getElementById("m-call-existing")?.value;
      const newName  = (document.getElementById("m-call-new-name")?.value || "").trim();
      const display  = (document.getElementById("m-call-new-display")?.value || "").trim();
      const body     = document.getElementById("m-call-new-body")?.value || "";

      let callerName = existing;
      if (!callerName) {
        if (!newName) throw { message: "Either pick an existing Caller or fill in the new-Caller name" };
        if (!/^[a-z0-9][a-z0-9-]*$/.test(newName)) {
          throw { message: "Caller name must be lowercase letters, digits, and hyphens" };
        }
        if (!display) throw { message: "Display name is required when creating a new Caller" };
        await api.createCaller({ scope: "company", name: newName, display_name: display, contacts: [], body });
        callerName = newName;
      }

      await api.patchTopology(swarmId, "add_canvas_caller", { caller: callerName });
      toastSuccess(`Caller "${callerName}" added to canvas`);
      onDone();
    },
    "Add to canvas"
  );
  setTimeout(() => document.getElementById("m-call-existing")?.focus(), 50);
}


// ── Add Informer modal (Phase 6.1) ────────────────────────────────────────────
// Places an informer node on the canvas with no connections. The user then
// connects it to an agent via connect-mode (agent → "Connect to…" → click informer).

async function _showAddInformerModal(swarmId, onDone) {
  const allInformers = await api.listInformers().catch(() => []);

  const informerOpts = allInformers.length
    ? allInformers.map(i => `<option value="${_esc(i.name)}">${_esc(i.display_name)} — ${_esc(i.scope)}</option>`).join("")
    : `<option value="" disabled>(none yet — create a new one below)</option>`;

  _showModal("Add Informer node", `
    <div style="font-size:11px;color:var(--color-ink-soft);font-family:var(--font-mono);margin-bottom:12px">
      Places the informer on the canvas. Connect it to an agent afterwards by selecting the agent and clicking "Connect to…".
    </div>

    <div class="form-group">
      <label class="form-label">Use existing Informer</label>
      <select class="form-input" id="m-inf-existing">
        <option value="">— or create a new one below —</option>
        ${informerOpts}
      </select>
    </div>

    <hr style="border:none;border-top:1px dashed var(--color-cream-line);margin:14px 0">

    <div class="form-group">
      <label class="form-label">…or new Informer name</label>
      <input class="form-input" id="m-inf-new-name" placeholder="e.g. finance-team">
      <div class="form-helper">Lowercase, hyphens. Created at <strong>company</strong> scope.</div>
    </div>
    <div class="form-group">
      <label class="form-label">Display name</label>
      <input class="form-input" id="m-inf-new-display" placeholder="Finance team">
    </div>
    <div class="form-group">
      <label class="form-label">Briefing (markdown shown in the inbox)</label>
      <textarea class="form-input" id="m-inf-new-body" rows="3"
        style="font-family:var(--font-mono);font-size:12px;resize:vertical"
        placeholder="Context shown alongside each notification…"></textarea>
    </div>`,
    async () => {
      const existing = document.getElementById("m-inf-existing")?.value;
      const newName  = (document.getElementById("m-inf-new-name")?.value || "").trim();
      const display  = (document.getElementById("m-inf-new-display")?.value || "").trim();
      const body     = document.getElementById("m-inf-new-body")?.value || "";

      let informerName = existing;
      if (!informerName) {
        if (!newName) throw { message: "Either pick an existing Informer or fill in the new-Informer name" };
        if (!/^[a-z0-9][a-z0-9-]*$/.test(newName)) {
          throw { message: "Informer name must be lowercase letters, digits, and hyphens" };
        }
        if (!display) throw { message: "Display name is required when creating a new Informer" };
        await api.createInformer({ scope: "company", name: newName, display_name: display, contacts: [], body });
        informerName = newName;
      }

      await api.patchTopology(swarmId, "add_canvas_informer", { informer: informerName });
      toastSuccess(`Informer "${informerName}" added to canvas`);
      onDone();
    },
    "Add to canvas"
  );
  setTimeout(() => document.getElementById("m-inf-existing")?.focus(), 50);
}


async function _showAddTriggerModal(swarmId, kind, onDone) {
  // Per-kind config field. Heartbeats need a cron expression, listeners need
  // an endpoint suffix, invocations get a default payload.
  let configFields = "";
  if (kind === "heartbeat") {
    configFields = `
      <div class="form-group">
        <label class="form-label">Schedule (cron)</label>
        <input class="form-input" id="m-schedule" type="text" placeholder="*/5 * * * *" value="*/5 * * * *">
        <div class="form-helper">Standard 5-field cron. <code style="font-family:var(--font-mono)">*/5 * * * *</code> = every 5 minutes. A default tick script will be generated automatically.</div>
      </div>`;
  } else if (kind === "listener") {
    configFields = `
      <div class="form-group">
        <label class="form-label">Endpoint suffix</label>
        <input class="form-input" id="m-endpoint" type="text" placeholder="my-webhook">
        <div class="form-helper">Webhook URL becomes <code style="font-family:var(--font-mono)">/api/v1/triggers/listener/&lt;suffix&gt;</code>.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Shared secret <span style="color:var(--color-ink-faint)">(optional)</span></label>
        <input class="form-input" id="m-secret" type="text" placeholder="leave blank for no auth">
        <div class="form-helper">Required as <code style="font-family:var(--font-mono)">Authorization: Bearer &lt;secret&gt;</code> on every call.</div>
      </div>`;
  } else if (kind === "invocation") {
    configFields = `
      <div class="form-group">
        <label class="form-label">Default payload (JSON)</label>
        <textarea class="form-input" id="m-default-payload" rows="4"
          style="font-family:var(--font-mono);font-size:12px;resize:vertical">{
  "message": "Hello"
}</textarea>
        <div class="form-helper">Pre-filled with an example. Edit to fit. Used when "Fire now" runs with the default; each invocation can also send a one-off override.</div>
      </div>`;
  }

  // Pull the swarm's agents so the user can pick a target. Falls back
  // gracefully if the call fails.
  let agents = [];
  try { agents = await api.listAgents(swarmId); } catch { /* ignore */ }
  const agentOpts = agents
    .filter(a => a.layer !== "perceptionist")
    .map(a => `<option value="${_esc(a.name)}">${_esc(a.name)} (${_esc(a.layer)})</option>`)
    .join("");

  _showModal(`New ${kind} trigger`, `
    <div class="form-group">
      <label class="form-label">Trigger name (slug)</label>
      <input class="form-input" id="m-name" type="text" placeholder="e.g. nightly-poll">
    </div>
    <div class="form-group">
      <label class="form-label">Fires into agent <span style="color:var(--color-ink-faint)">(optional)</span></label>
      <select class="form-input" id="m-target-agent">
        <option value="">— use swarm entry_point —</option>
        ${agentOpts}
      </select>
      <div class="form-helper">If unset, fires into the swarm's declared entry_point. Pick a different agent to fan out triggers across the swarm.</div>
    </div>
    ${configFields}`,
    async () => {
      const name = (document.getElementById("m-name")?.value || "").trim().replace(/\s+/g, "-");
      if (!name) throw { message: "Name is required" };

      const config = {};
      const target = (document.getElementById("m-target-agent")?.value || "").trim();
      if (target) config.target_agent = target;

      if (kind === "heartbeat") {
        const schedule = (document.getElementById("m-schedule")?.value || "").trim();
        if (!schedule) throw { message: "Schedule is required" };
        config.schedule = schedule;
      } else if (kind === "listener") {
        const endpoint = (document.getElementById("m-endpoint")?.value || "").trim();
        if (!endpoint) throw { message: "Endpoint suffix is required" };
        config.endpoint = endpoint;
        const secret = (document.getElementById("m-secret")?.value || "").trim();
        if (secret) config.secret = secret;
      } else if (kind === "invocation") {
        const raw = (document.getElementById("m-default-payload")?.value || "").trim();
        if (raw) {
          try {
            config.default_payload = JSON.parse(raw);
          } catch (err) {
            throw { message: "Default payload is not valid JSON: " + err.message };
          }
        }
      }

      await api.createTrigger(swarmId, { name, kind, config, enabled: true });
      toastSuccess(`Trigger "${name}" created`);
      onDone();
    },
    "Create trigger"
  );
  setTimeout(() => document.getElementById("m-name")?.focus(), 50);
}

// ── Trigger edit + invoke modals (Phase 6.1) ─────────────────────────────────

async function _showEditTriggerModal(swarmId, d, onDone) {
  let agents = [];
  try { agents = await api.listAgents(swarmId); } catch { /* ignore */ }
  const cfg = d.trigger_config || {};
  const currentTarget = cfg.target_agent || "";
  const agentOpts = agents
    .filter(a => a.layer !== "perceptionist")
    .map(a => `<option value="${_esc(a.name)}" ${a.name === currentTarget ? "selected" : ""}>${_esc(a.name)} (${_esc(a.layer)})</option>`)
    .join("");

  let extra = "";
  if (d.trigger_kind === "invocation") {
    const dp = cfg.default_payload
      ? JSON.stringify(cfg.default_payload, null, 2)
      : `{\n  "message": "Hello"\n}`;
    extra = `
      <div class="form-group">
        <label class="form-label">Default payload (JSON)</label>
        <textarea class="form-input" id="m-default-payload" rows="5"
          style="font-family:var(--font-mono);font-size:12px;resize:vertical">${_esc(dp)}</textarea>
        <div class="form-helper">Used when "Fire now" runs with the default. Empty / non-JSON clears the default.</div>
      </div>`;
  } else if (d.trigger_kind === "heartbeat") {
    extra = `
      <div class="form-group">
        <label class="form-label">Schedule (cron)</label>
        <input class="form-input" id="m-schedule" value="${_esc(cfg.schedule || "")}">
      </div>`;
  } else if (d.trigger_kind === "listener") {
    extra = `
      <div class="form-group">
        <label class="form-label">Endpoint suffix</label>
        <input class="form-input" id="m-endpoint" value="${_esc(cfg.endpoint || "")}">
      </div>
      <div class="form-group">
        <label class="form-label">Shared secret</label>
        <input class="form-input" id="m-secret" value="${_esc(cfg.secret || "")}">
      </div>`;
  }

  _showModal(`Edit ${_esc(d.name)}`, `
    <div class="form-group">
      <label class="form-label">Fires into agent</label>
      <select class="form-input" id="m-target-agent">
        <option value="" ${!currentTarget ? "selected" : ""}>— use swarm entry_point —</option>
        ${agentOpts}
      </select>
      <div class="form-helper">Override the swarm's entry_point for this trigger.</div>
    </div>
    ${extra}`,
    async () => {
      const newCfg = { ...cfg };
      const target = (document.getElementById("m-target-agent")?.value || "").trim();
      if (target) newCfg.target_agent = target;
      else delete newCfg.target_agent;

      if (d.trigger_kind === "invocation") {
        const raw = (document.getElementById("m-default-payload")?.value || "").trim();
        if (raw) {
          try { newCfg.default_payload = JSON.parse(raw); }
          catch (err) { throw { message: "Default payload not valid JSON: " + err.message }; }
        } else {
          delete newCfg.default_payload;
        }
      } else if (d.trigger_kind === "heartbeat") {
        const sched = (document.getElementById("m-schedule")?.value || "").trim();
        if (sched) newCfg.schedule = sched;
      } else if (d.trigger_kind === "listener") {
        const ep = (document.getElementById("m-endpoint")?.value || "").trim();
        if (ep) newCfg.endpoint = ep;
        const sec = (document.getElementById("m-secret")?.value || "").trim();
        if (sec) newCfg.secret = sec;
        else delete newCfg.secret;
      }

      await api.updateTrigger(d.trigger_id, { config: newCfg });
      toastSuccess(`Trigger "${d.name}" updated`);
      onDone();
    },
    "Save"
  );
}


function _showInvokeTriggerModal(d, onDone) {
  const cfg = d.trigger_config || {};
  const hasDefault = !!cfg.default_payload;
  const defaultStr = hasDefault ? JSON.stringify(cfg.default_payload, null, 2) : "{}";
  const fallbackOverride = hasDefault
    ? defaultStr
    : `{\n  "message": "Hello"\n}`;

  _showModal(`Fire "${_esc(d.name)}"`, `
    <div style="font-size:12px;color:var(--color-ink-soft);font-family:var(--font-mono);margin-bottom:10px">
      ${hasDefault
        ? "This invocation has a stored default payload. Choose to fire it as-is or write a one-off override."
        : "No default payload is configured. Write the payload below."}
    </div>

    ${hasDefault ? `
      <div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <input type="checkbox" id="m-fire-use-default" checked
               style="width:14px;height:14px;cursor:pointer;accent-color:var(--color-perceptionist)">
        <label for="m-fire-use-default" style="font-family:var(--font-mono);font-size:12px;color:var(--color-ink);cursor:pointer">
          Use stored default
        </label>
      </div>

      <div class="form-group" id="m-fire-default-block">
        <label class="form-label">Default payload (read-only)</label>
        <pre style="font-family:var(--font-mono);font-size:12px;background:var(--color-cream-deep);border:1px solid var(--color-cream-line);border-radius:4px;padding:8px 10px;white-space:pre-wrap;color:var(--color-ink);margin:0">${_esc(defaultStr)}</pre>
      </div>
    ` : ""}

    <div class="form-group" id="m-fire-override-block" ${hasDefault ? "hidden" : ""}>
      <label class="form-label">Override payload (JSON)</label>
      <textarea class="form-input" id="m-fire-payload" rows="8"
        style="font-family:var(--font-mono);font-size:12px;resize:vertical">${_esc(fallbackOverride)}</textarea>
    </div>`,
    async () => {
      const useDefault = document.getElementById("m-fire-use-default")?.checked;
      let payload;
      if (hasDefault && useDefault) {
        // Empty body — backend falls back to config.default_payload.
        payload = {};
      } else {
        const raw = (document.getElementById("m-fire-payload")?.value || "").trim();
        if (!raw) {
          payload = {};
        } else {
          try { payload = JSON.parse(raw); }
          catch (err) { throw { message: "Override payload is not valid JSON: " + err.message }; }
        }
      }
      const r = await api.invokeTrigger(d.trigger_id, payload);
      toastSuccess(`Fired "${d.name}" — event ${r.event_id?.slice(0, 8) || ""}`);
      onDone();
    },
    "Fire"
  );

  // Wire the checkbox to swap visible blocks
  setTimeout(() => {
    const cb = document.getElementById("m-fire-use-default");
    const defBlock = document.getElementById("m-fire-default-block");
    const ovrBlock = document.getElementById("m-fire-override-block");
    if (cb) {
      cb.addEventListener("change", () => {
        const checked = cb.checked;
        if (defBlock) defBlock.hidden = !checked;
        if (ovrBlock) ovrBlock.hidden = checked;
      });
    }
  }, 50);
}


function _showConnectToHumanModal(swarmId, kind, agentName, humanName, onDone) {
  const isCall = kind === "call";
  const label = isCall ? "caller" : "informer";
  _showModal(`Connect to ${label}`, `
    <div class="form-group">
      <label class="form-label">From agent</label>
      <input class="form-input" value="${_esc(agentName)}" readonly style="opacity:.7">
    </div>
    <div class="form-group">
      <label class="form-label">To (${label})</label>
      <input class="form-input" value="${_esc(humanName)}" readonly style="opacity:.7">
    </div>
    <div class="form-group">
      <label class="form-label">Purpose <span style="color:var(--color-danger)">*</span></label>
      <textarea class="form-textarea" id="m-purpose"
        placeholder="${isCall ? "e.g. Approve invoices over €10k" : "e.g. Notify when payment is processed"}"
        style="min-height:70px"></textarea>
      <div class="form-helper">Required. Shown in the inbox and the audit trail — make it meaningful.</div>
    </div>`,
    async () => {
      const purpose = document.getElementById("m-purpose")?.value.trim();
      if (!purpose) throw { message: "Purpose is required" };
      const op = isCall ? "add_call" : "add_inform";
      const params = isCall
        ? { agent: agentName, caller: humanName, purpose }
        : { agent: agentName, informer: humanName, purpose };
      await api.patchTopology(swarmId, op, params);
      toastSuccess(`Connected "${agentName}" → "${humanName}"`);
      onDone();
    },
    "Connect"
  );
  setTimeout(() => document.getElementById("m-purpose")?.focus(), 50);
}

function _showEdgeModal(swarmId, from, to, hierarchy, onDone) {
  _showModal("New connection", `
    <div class="form-group">
      <label class="form-label">From</label>
      <input class="form-input readonly" value="${_esc(from)}" readonly>
    </div>
    <div class="form-group">
      <label class="form-label">To</label>
      <input class="form-input readonly" value="${_esc(to)}" readonly>
    </div>
    <div class="form-group">
      <label class="form-label">Kind</label>
      <select class="form-select" id="m-kind">
        <option value="delegate">Delegate ↓</option>
        <option value="escalate">Escalate ↑</option>
        <option value="report">Report ↑</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Purpose <span style="color:var(--color-danger)">*</span></label>
      <textarea class="form-textarea" id="m-purpose" placeholder="Describe why this connection exists…" style="min-height:70px"></textarea>
      <div class="form-helper">Required. This string is the audit trail — make it meaningful.</div>
    </div>`,
    async () => {
      const purpose = document.getElementById("m-purpose")?.value.trim();
      if (!purpose) throw { message: "Purpose is required" };
      const kind = document.getElementById("m-kind")?.value || "delegate";
      await api.patchTopology(swarmId, "add_edge", { from, to, kind, purpose });
      toastSuccess("Edge added");
      onDone();
    },
    "Create connection"
  );
  setTimeout(() => document.getElementById("m-purpose")?.focus(), 50);
}

function _showEditPurposeModal(swarmId, edgeData, onDone) {
  _showModal("Edit purpose", `
    <div class="form-group">
      <label class="form-label">Purpose</label>
      <textarea class="form-textarea" id="m-purpose" style="min-height:80px">${_esc(edgeData.purpose || "")}</textarea>
    </div>`,
    async () => {
      const purpose = document.getElementById("m-purpose")?.value.trim();
      if (!purpose) throw { message: "Purpose is required" };
      await api.patchTopology(swarmId, "update_edge", {
        from: edgeData.source, to: edgeData.target, kind: edgeData.kind, purpose
      });
      toastSuccess("Purpose updated");
      onDone();
    }
  );
}

function _showRunModal(swarmId, container) {
  _showModal("Fire event", `
    <div class="form-group">
      <label class="form-label">Event type</label>
      <input class="form-input" id="m-type" type="text" value="manual" placeholder="e.g. manual, invoice.received">
      <div class="form-helper">A label routing this event — any string. Defaults to <code style="font-family:var(--font-mono)">manual</code>.</div>
    </div>
    <div class="form-group">
      <label class="form-label">Event payload (JSON)</label>
      <textarea class="form-textarea" id="m-payload"
        style="min-height:120px;font-family:var(--font-mono);font-size:12px"
        placeholder='{"message": "Hello"}'>{
  "message": "Hello"
}</textarea>
      <div class="form-helper">
        Must be a valid JSON object. Strings need quotes — e.g.
        <code style="font-family:var(--font-mono)">{"message": "Hello"}</code>, not
        <code style="font-family:var(--font-mono)">{Hello}</code>.
      </div>
    </div>`,
    async () => {
      const type = (document.getElementById("m-type")?.value || "").trim() || "manual";
      const raw = (document.getElementById("m-payload")?.value || "").trim() || "{}";
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) {
        throw { message: `Invalid JSON: ${e.message}. Try {"message": "Hello"}.` };
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw { message: 'Payload must be a JSON object — e.g. {"message": "Hello"}' };
      }
      await api.fireEvent(swarmId, { type, payload, source: "api" });
      toastSuccess("Event fired — run started");
    },
    "Fire event"
  );
}

// ── Live mode ──────────────────────────────────────────────────────────────

function _pulseNode(name) {
  if (!_cy) return;
  _cy.elements().removeClass("live");
  const n = _cy.getElementById(name);
  if (n.length) n.addClass("live");
}

function _updateStream(container, log) {
  const streamEl = container.querySelector(".stream-bar-expanded");
  if (!streamEl) return;
  const last = log.slice(-50);
  streamEl.innerHTML = last.map(msg => {
    const ts = new Date().toTimeString().slice(0, 8);
    return `<div class="stream-entry"><span class="ts">${ts}</span>${_esc(msg.type)} ${msg.step_name ? `→ ${_esc(msg.step_name)}` : ""}</div>`;
  }).join("");
  streamEl.scrollTop = streamEl.scrollHeight;
}

function _initStreamBar(bar, container) {
  let expanded = false;
  bar.addEventListener("click", () => {
    expanded = !expanded;
    if (expanded) {
      const log = document.createElement("div");
      log.className = "stream-bar-expanded";
      log.style.cssText = "position:absolute;bottom:var(--stream-h);left:0;right:0;height:180px;z-index:10";
      container.appendChild(log);
      bar.querySelector("#stream-chev").textContent = "▾ collapse";
    } else {
      container.querySelectorAll(".stream-bar-expanded").forEach(e => e.remove());
      bar.querySelector("#stream-chev").textContent = "▴ expand";
    }
  });
}

// ── Utils ──────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function _truncate(str, n) {
  return str && str.length > n ? str.slice(0, n) + "…" : (str || "");
}
