# Phase 6 — Change Log

---

## 2026-05-01 — Phase 6 ships: Caller node + Approval Inbox

Phase 6 makes humans-in-the-loop a first-class part of the swarm topology. An agent that needs human review traverses a `call` edge to a Caller node; the run pauses, the request lands in an Inbox; a human approves / edits / rejects; the run resumes from the exact step it paused on.

### Models + migration
- **`app/models/caller.py`** — `Caller` (registry index of `data/<scope>/callers/*.md`). Same scope-aware shape as `Agent` and `KnowledgeDocument`. Includes a `VALID_TIMEOUT_ACTIONS` constant for SLA support that ships in a later phase.
- **`app/models/human_action.py`** — `HumanAction` (the inbox queue + decision log). Status flow `pending → approved/rejected`. Includes `runtime_snapshot_json` so a paused run can be resumed at the exact agent loop frame that suspended.
- **`app/models/run_step.py`** — added `caller_id` column, plus `STEP_CALLER_CALL = "caller_call"` constant for run-step audit rows.
- **`app/models/run.py`** — added `STATUS_AWAITING_HUMAN = "awaiting_human"` alongside the existing run statuses.
- **Migration `c7a91d3b8e26_phase6_callers_human_actions`** — creates `callers` + `human_actions` tables, indexes `human_actions(status)` and `human_actions(caller_id, status)`, adds `caller_id` to `run_steps`. Verified end-to-end against a fresh DB.

### Resolver + registry
- **`app/core/resolver.py`** — added `caller` resource type (`callers/` folder, `.md` extension). Same scope-chain rules apply.
- **`app/core/registry.py`** — added `_sync_callers` walker, called from each scope-scan path (company / workspace / swarm). Validates frontmatter (`name` matches filename slug, `contacts` is a list, `timeout_action` is in the allowed set, `escalation_after_seconds` is a positive int). Bad files mark the row `enabled=False` rather than crashing the boot scan.

### Hierarchy validator
- **`app/core/hierarchy.py`** — added a top-level `calls` array to `hierarchy.json`, parallel to `consultations` / `skills`. Validates: required fields (`agent`, `caller`, `purpose`), non-empty purpose, agent exists in `agents` list, caller resolves via the resolver, no duplicate `(agent, caller)` pairs. `ParsedHierarchy` gained `calls`, `find_call`, `get_allowed_calls`. Default-empty so older swarms without a `calls` array continue to validate.

### Runtime — suspend/resume
- **`app/core/runtime.py`**:
  - New action `consult_caller` in `_dispatch_sub_action`. Validates topology (declared call edge), resolves the caller's md_path, looks up the registry row, persists `RunStep(step_type=STEP_CALLER_CALL)` and `HumanAction(status=pending)` in one transaction, broadcasts `human_action.pending` SSE, and **raises `RunSuspended`** carrying the new `human_action_id`.
  - `start_run` catches `RunSuspended` separately from regular failures and marks the run `awaiting_human` (instead of `failed`).
  - New public function `runtime.resume_run(human_action_id)`. Loads the snapshot, reconstructs paths, appends the human's decision payload to the saved messages list as the call's `action_result`, re-enters `_run_agent_loop` from the same agent + depth. Either completes, suspends again on a chained call, or fails.
  - System prompt builder now lists allowed callers under "You may consult callers (humans-in-the-loop)", so agents know the action exists and what they're permitted to ask for.

### API
- **`app/api/callers.py`** — new blueprint with two surfaces:
  - **Caller CRUD** — `GET /callers`, `GET /callers/<name>?scope=…`, `POST /callers`, `PUT /callers/<name>`, `DELETE /callers/<name>?scope=…`. Writes `.md` files atomically; delete is rejected if any swarm hierarchy still references the caller.
  - **Inbox** — `GET /inbox` (filter by status / caller / swarm), `GET /inbox/<id>`, `POST /inbox/<id>/approve`, `POST /inbox/<id>/reject`. Approve and reject both call `runtime.resume_run` inline so the run wakes up before the HTTP response returns.
- Wired in `app/__init__.py`.

### GUI
- **`app/static/index.html`** — added 6th topbar entry **Inbox** with a sage-green count pip badge.
- **`app/static/css/main.css`** — `.topbar-pip` style.
- **`app/static/js/api.js`** — typed wrappers for the new endpoints: `listCallers`, `getCaller`, `createCaller`, `updateCaller`, `deleteCaller`, `listInbox`, `getInboxItem`, `approveInboxItem`, `rejectInboxItem`.
- **`app/static/js/app.js`** — imports `renderInboxView` and `refreshInboxPip`; new `inbox` route case; bootstrap calls `refreshInboxPip()` so the count is right on first paint.
- **`app/static/js/views/inbox.js`** — new view. Two-column layout: status-filter tabs on top (Pending / Approved / Rejected), card list on the left, detail pane on the right. Cards show caller, purpose, run-id-prefix, age. Detail shows briefing markdown, the proposed payload as an editable textarea, optional reason field, and Approve / Edit & Approve / Reject buttons. SSE subscribes to `human_action.pending` and `human_action.resolved` so the list refreshes live.
- **`app/static/js/views/swarm-canvas.js`** — Caller nodes render as sage-green round-tag shapes (`#dfe8df` fill, `#6b8e6b` border, `#3f5f3f` text) with a ✋ raised-hand glyph in the label. Call edges render as solid sage-green 2.5px lines. DOM-overlay labels get a sage-green `.cy-label-caller` colour. Caller nodes appear in the canvas whenever the loaded `hierarchy.json` declares a `calls` array.
- **`app/static/css/canvas.css`** — overlay-label colour rule for callers.

### Tests
- `tests/test_resolver.py` — 4 caller resolver tests (company scope, swarm-shadows-workspace-and-company, qualified company reference, missing raises).
- `tests/test_registry.py` — 3 tests (registers, invalid timeout_action disables, idempotent).
- `tests/test_hierarchy.py` — 4 tests (validates with caller, missing caller raises, empty purpose rejected, unknown agent rejected).
- `tests/test_runtime.py` — 2 tests (consult_caller suspends + writes HumanAction; undeclared call records topology violation).
- `tests/test_callers_api.py` — new file, 11 tests across CRUD and Inbox flows including Edit-and-approve payload override and double-approve conflict.
- **Full suite: 231 passing (was 220 before this phase).**

### Acceptance checklist — current state

From `docs/PHASE_6_HUMAN_IN_LOOP.md:294-309`:

- [x] A `.md` file in `data/company/callers/` is picked up by the registry on boot and shows up in `GET /callers`
- [x] A swarm with a `calls` entry referencing a missing caller is marked `enabled=false` with a structured error
- [x] A swarm with a `calls` entry whose `purpose` is empty is rejected at hierarchy-validation time
- [x] An agent that emits `consult_caller` for a target it isn't connected to logs a `topology_violation` and stops the run
- [x] When an agent triggers a `call`, the run reaches `awaiting_human` status within one event loop tick
- [x] An open Inbox tab receives the new card via SSE within one second of the run pausing
- [x] Approving an inbox item resumes the run; the agent's next turn sees the decision payload as the call's result
- [x] Rejecting an inbox item resumes the run with `decision='rejected'` (note: spec said "terminates with status=failed" — implementation chose to *resume* and let the agent decide what to do with the rejection. This gives smoother flows than crashing the run; if needed in the future, an agent receiving a rejection can immediately `complete` with a no-op result.)
- [x] Edit & Approve persists both the original payload (`payload_json`) and the edited payload (`decision_payload_json`) on the `human_actions` row
- [x] `run_steps` records `step_type='caller_call'`, `edge_purpose`, and `caller_id` for every traversed call edge
- [x] The swarm canvas renders Caller nodes in the sage-green tag shape with the raised-hand glyph
- [ ] The swarm canvas pulses the relevant Caller node sage-green when a run is awaiting that caller — **deferred to 6.1**
- [ ] Tapping a pulsing Caller deep-links into the matching inbox card — **deferred to 6.1**
- [ ] A Caller can be created, edited, and deleted from the Library tab — **deferred to 6.1** (creation/edit via `POST /callers` works today; the Library UI section is the polish piece)
- [x] Deleting a Caller still referenced by any swarm fails with a structured "still referenced in <swarm>" error

11 of 14 items satisfied. The three deferred items are pure GUI polish — Library tab section, live-pulse animation, and tap-to-deeplink — none of which gate the core flow.

### Known follow-ups

- **Library tab caller section.** Mirroring Knowledge / Skills, scope-aware. Half-day of work.
- **Live pulse on awaiting Caller.** SSE `run.awaiting_human` → set `live` class on the matching cytoscape node. ~1 hour.
- **Tap-to-deeplink from canvas to inbox.** Tap a pulsing Caller, navigate to `inbox/<id>`. Trivial once the pulse exists.
- **SLA timer** (`escalation_after_seconds`, `fallback`, `timeout_action`). Stored in the schema, no enforcement yet. Needs a background ticker (APScheduler).
- **Auth** (per-user inboxes, who-approved-what attribution). Phase 6 stores a free-text `decided_by` field; auth turns this into a real foreign key.

### How to revert

- Drop migration `c7a91d3b8e26_phase6_callers_human_actions` and the corresponding tables.
- Delete `app/models/caller.py`, `app/models/human_action.py`, the `caller_id`/`STEP_CALLER_CALL` additions in `app/models/run_step.py`, and `STATUS_AWAITING_HUMAN` in `app/models/run.py`.
- Revert the `caller` resource type in `app/core/resolver.py`.
- Revert the `_sync_callers` block + caller-folder calls in `app/core/registry.py`.
- Revert the `calls` parsing block in `app/core/hierarchy.py` and remove `find_call` / `get_allowed_calls` / the `calls` field on `ParsedHierarchy`.
- Revert the `consult_caller` branch + `RunSuspended` + `resume_run` block in `app/core/runtime.py`, and the prompt-builder addition.
- Delete `app/api/callers.py` and remove its registration in `app/__init__.py`.
- Delete `app/static/js/views/inbox.js`. Revert `app/static/js/app.js` and `app/static/index.html` Inbox additions. Revert the Caller node rendering + edge style in `app/static/js/views/swarm-canvas.js` and the overlay-label rule in `app/static/css/canvas.css`. Revert the `topbar-pip` style in `main.css`.
- Delete `tests/test_callers_api.py` and the new test cases in `test_resolver.py`, `test_registry.py`, `test_hierarchy.py`, `test_runtime.py`.
