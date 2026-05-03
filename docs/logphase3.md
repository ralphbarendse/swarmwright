# Phase 3 — Change Log

---

## 2026-04-30 — Full GUI implementation

**What was added:**

### CSS / Tokens
- `app/static/css/tokens.css` — CSS custom properties for all colours (topbar navy, amber accent, layer colours, edge colours), spacing, typography, and layout variables (`--topbar-h`, `--palette-w`, `--inspector-w`, `--stream-h`)
- `app/static/css/main.css` — Full base stylesheet: reset, topbar, card grid, badges, buttons, forms, modals, toasts, filter bar, empty-states, utilities
- `app/static/css/canvas.css` — Canvas-specific layout: `.canvas-shell` (3-col + stream bar), palette, `#cy-container` (dotted-grid background), inspector, stream bar, live pulse animation

### HTML shell
- `app/static/index.html` — Single-page shell. Loads CDN scripts in dependency order (dagre → cytoscape → cytoscape-dagre → cytoscape-edgehandles → marked → CodeMirror 5 with markdown and python modes). Contains topbar with 5 tabs, `<main id="main">`, and `<div id="toast-container">`.

### JavaScript core
- `app/static/js/api.js` — Typed fetch wrapper with full coverage of all backend endpoints (workspaces, swarms, topology, agents, knowledge, skills, runs, events)
- `app/static/js/sse.js` — Single persistent EventSource at `/api/v1/stream`. Per-type handler registry with wildcard `"*"` support. Auto-reconnects after 5 s on error.
- `app/static/js/app.js` — Hash router: parses `#view/seg1/seg2`, runs `_activeCleanup` before unmount, mounts view into `#main`. Tab navigation. `_lastSwarmId`/`_lastAgentId` for tab re-activation. Cmd+K global search, Escape closes modals.
- `app/static/js/components/toast.js` — Toast notifications (default / error / success) with auto-dismiss.

### Views
- `app/static/js/views/org-design.js` — Workspace list + detail. Swarm sub-cards. Resources sidebar with knowledge/skills counts. Create/edit/delete modals. Exports `_showModal` for reuse across views.
- `app/static/js/views/swarm-canvas.js` — Full Cytoscape.js canvas. Dagre TB layout. Per-layer node colours and per-kind edge styles. Edgehandles for drag-to-create edges (requires declared purpose). Palette for adding agents. SSE pulse on `run.step`. Inspector panels for swarm, node, and edge. Stream bar with live run output. Save positions via `save_positions` topology op.
- `app/static/js/views/constitution-editor.js` — Split layout: frontmatter form (name readonly, layer/model selects, knowledge chips) + CodeMirror 5 markdown editor + live marked.js preview. Save / Discard / History. Cmd+S shortcut. Proper cleanup on unmount.
- `app/static/js/views/runs.js` — Run list with status/source filter, auto-refresh on SSE events, load-more pagination. Run detail: header with replay button, topology violation box, step timeline with edge purpose prominently displayed, collapsible output. SSE live-updates for in-progress runs. Cleanup removes SSE handlers on unmount.
- `app/static/js/views/library.js` — Knowledge and skills management across company/workspace scopes. Scope nav sidebar built from workspace list. Knowledge: list, create, edit (markdown textarea in modal), delete. Skills: list with description, timeout, allowed-packages chips, and a view-source modal.
- `app/static/js/views/settings.js` — Stub (Phase 5).

### Backend — New endpoints
- `app/core/sse_bus.py` — Thread-safe per-client `queue.Queue` broadcast bus (`connect`, `disconnect`, `broadcast`)
- `app/api/stream.py` — `GET /api/v1/stream` — SSE generator with 25 s heartbeat, `stream_with_context`
- `app/api/topology.py` — `GET /api/v1/swarms/<id>/hierarchy` and `PATCH /api/v1/swarms/<id>/topology` with 11 operations validated by `load_and_validate()` before atomic write
- `app/api/knowledge.py` — Full CRUD at `/api/v1/knowledge[/<id>]` with scope-folder resolution
- `app/api/skills_api.py` — `GET /skills` and `GET /skills/<name>` — filesystem scan of `.py`/`.yaml` pairs

### Backend — Modified
- `app/api/agents.py` — Added `POST /swarms/<id>/agents`, `PUT /agents/<id>/constitution` (atomic write + history), `DELETE /agents/<id>`, `GET /agents/<id>/history`
- `app/api/runs.py` — `list_runs` enriched with `swarm_display_name` and `source`; status + offset filters. `get_run` adds steps, source, event payload. `POST /runs/<id>/replay`.
- `app/api/swarms.py` — `get_swarm` includes `run_count`, `hierarchy` field
- `app/__init__.py` — Wires `SseBus`, calls `runtime.set_notify_fn`, registers new blueprints
- `app/core/runtime.py` — `_notify_fn` hook + `set_notify_fn()`. SSE notifications on `run.started`, `run.step`, `run.completed`, `run.failed`

**Tests:** 142 passing (all pre-existing tests continue to pass; no new test files added in Phase 3 per spec scope).
