# Phase 2 — Change Log

---

## 2026-04-30 — Phase 2 work started

Phase 1 complete and verified. Beginning Phase 2: registry, hierarchy validator, runtime, skill runner, triggers.

---

## 2026-04-30 — Phase 2 core modules complete

### What changed

**New files:**
- `app/core/hierarchy.py` — `load_and_validate()` parses and fully validates `hierarchy.json`; produces a `ParsedHierarchy` dataclass with lookup helpers (`find_edge`, `find_consultation`, `find_skill`, `get_allowed_*`). `HierarchyValidationError` carries a structured `code` field for every failure mode.
- `app/core/skill_runner.py` — Subprocess sandbox for skills: `run_skill()` executes a `.py` file with JSON on argv, captures stdout as JSON, kills on timeout. `validate_allowed_packages()` does static import analysis via `ast.walk`.
- `app/core/registry.py` — Boot scanner and watchdog file watcher. On startup: walks `data/` tree, upserts workspaces/swarms/agents/perceptionists/knowledge_documents/triggers into the DB, validates + caches each swarm's `ParsedHierarchy` (`_hierarchy_cache`). Marks swarms `enabled=False` with a structured `validation_error` on failure. 2-second debounce on file changes.
- `app/core/runtime.py` — Agent executor and topology enforcer. `start_run()` creates a `Run` row and dispatches the entry-point agent. `_run_agent_loop()` is the multi-turn LLM conversation per agent (up to `MAX_AGENT_TURNS=10`). `_dispatch_sub_action()` validates every agent response against the `ParsedHierarchy` before dispatching — wrong purpose or undeclared edge raises `TopologyViolationError` and writes a `STEP_TOPOLOGY_VIOLATION` run_step. `_execute_skill_call()` runs the skill subprocess and records a `STEP_SKILL_CALL` row. All steps carry `edge_purpose` from the matching hierarchy entry.
- `app/core/heartbeat.py` — `register_all_heartbeats()` wires enabled heartbeat triggers to APScheduler after boot. Each tick: reads current watermark from DB, runs the script via subprocess with watermark as argv[1], parses `{"watermark": ..., "events": [...]}` output, atomically persists watermark + event rows, publishes each event to the bus.

**Modified files:**
- `app/__init__.py` — Wires Phase 2 on startup: `boot_scan()` → `register_all_heartbeats()` → `start_file_watcher()`. Adds `_make_run_handler()` which subscribes to the event bus and calls `runtime.start_run()` for every published event (runs in the event bus thread pool, uses `app.app_context()`). Registry/heartbeat/watcher skipped when `cfg.TESTING=True`.
- `app/api/events.py` — `POST /swarms/<id>/events` now publishes the persisted event to `current_app.event_bus` after committing (was placeholder).
- `app/api/agents.py` — `GET /agents/<id>` now includes `constitution` field with raw `.md` content.
- `app/api/triggers.py` — Added `POST /api/v1/triggers/listener/<suffix>` (validates secret + JSON-schema filter, publishes event) and `POST /api/v1/triggers/invocations/<id>` (validates schema, records `invoked_by`, publishes event).

**New tests (`tests/`):**
- `test_hierarchy.py` — 18 tests covering happy path, all validation error codes, scope resolution for consultations and skills.
- `test_runtime.py` — 14 tests covering action parsing, system prompt construction, topology validation (violation on wrong purpose, undeclared edge, unknown action), multi-turn loop, max-turns guard, sequence counter.
- `test_triggers.py` — 13 tests covering listener (secret, filter, 404), invocation (disabled, schema, invoked_by, wrong kind), and event bus publish on `POST /swarms/<id>/events`.

Total: 100 tests passing.

### Why

Phase 2 specification: `docs/PHASE_2_MODULES.md`. Core promise: an agent cannot call anything not declared in `hierarchy.json`; every step in a run carries the exact purpose string that authorized it.

### How to revert

Delete the five new files and revert the four modified files to their Phase 1 state. The DB schema is unchanged — no migration was added in Phase 2. The `runs` and `run_steps` tables were already created in Phase 1's migration.

---

## 2026-04-30 — Constitution validation, knowledge references, test suite expansion

### What changed

**Modified files:**
- `app/core/hierarchy.py` — Extended `load_and_validate()` with two new checks performed for each agent after confirming the `.md` file exists:
  1. Parses constitution frontmatter with `python-frontmatter`; raises `HierarchyValidationError(code="invalid_constitution")` if YAML is unparseable (item 2)
  2. Validates `layer` value against `VALID_LAYERS`; raises `HierarchyValidationError(code="invalid_layer")` for unknown layers (item 2)
  3. Resolves every reference in the constitution's `knowledge:` list through the scope chain; raises `HierarchyValidationError(code="knowledge_not_found")` on any failure (item 12)

**New test files:**
- `tests/test_registry.py` — 8 tests covering item 1: boot scan registers workspace/swarm/agents, re-scan picks up new `.md` files, `ParsedHierarchy` is cached after scan, invalid `hierarchy.json` marks swarm `enabled=False`, knowledge documents are indexed, idempotency (double scan does not duplicate rows)
- `tests/test_skill_runner.py` — 10 tests covering item 8: `run_skill` happy path (JSON round-trip, context passing), timeout kills subprocess and raises `SkillTimeoutError`, nonzero exit raises `SkillError`, no output and non-JSON output raise `SkillError`; plus package validation (stdlib passes, third-party blocked, declared package permitted, syntax error caught)
- `tests/test_heartbeat.py` — 8 tests covering item 9: `register_all_heartbeats` wires enabled triggers to APScheduler; skips disabled triggers and triggers missing `schedule` or `script`; `_fire_heartbeat` persists event rows and updates watermark, no-op on no output, no-op on missing script, passes current watermark as argv[1]
- `tests/test_hierarchy.py` additions — 4 new tests for items 2 and 12: invalid frontmatter YAML raises `invalid_constitution`, unknown layer raises `invalid_layer`, missing knowledge reference raises `knowledge_not_found`, valid knowledge reference at swarm scope resolves without error

**New example swarm (`data/workspaces/ops/swarms/invoice/`):**
- `meta.yaml`, `hierarchy.json` — two-agent swarm: `coordinator` (orchestrator) delegates to `validator` (executioner), validator reports back; `check-amount` skill wired to validator
- `agents/coordinator.md`, `agents/validator.md` — constitutions for each agent
- `skills/check-amount.py` — subprocess skill that validates invoice amount is in range 1–1,000,000
- Smoke tested end-to-end: event → coordinator → validator → skill → report → coordinator → complete; 4 run_steps produced, all with correct `edge_purpose`

### Why

Items 2 and 12 from the Phase 2 spec. Item 2: agent constitutions with bad frontmatter or invalid layers must be caught at hierarchy validation time, not silently ignored at runtime. Item 12: knowledge references declared in constitutions must resolve at registration time so a broken reference is surfaced immediately, not at the moment an agent runs.

### How to revert

Revert `app/core/hierarchy.py` to the state before the three added validation blocks. Delete the four new test files (keep `test_hierarchy.py` but remove the four new test functions at the bottom). Delete `data/workspaces/ops/`.

---

## 2026-04-30 — Gap closure: skill schema validation, YAML sidecars, listener deduplication

### What changed

**Modified files:**
- `app/core/skill_runner.py` — Added `validate_skill_input(input_data, schema)` and `validate_skill_output(output_data, schema)`; both call `jsonschema.validate` and raise `SkillValidationError` on failure. These are called by the runtime, not by skills themselves.
- `app/core/runtime.py` — `_execute_skill_call()` now reads `input_schema` and `output_schema` from the skill's `.yaml` sidecar (alongside `timeout_seconds`). Validates input *before* launching the subprocess; validates output *after* receiving it. A schema-violating output from a misbehaving skill is caught before it reaches the agent. Import updated to include `validate_skill_input`, `validate_skill_output`, `SkillValidationError`.
- `app/api/triggers.py` — Added `_DedupeCache` class (thread-safe `OrderedDict`, configurable TTL and max size) and a module-level `_listener_dedup` instance (24h TTL, 10,000-entry cap). In `listener_webhook`, if the payload carries an `event_id` that was seen for this trigger within the TTL, returns `202 {"deduplicated": true}` without creating an event or publishing to the bus. Dedup key is `{trigger_id}:{event_id}` to prevent cross-trigger contamination.

**New file:**
- `data/workspaces/ops/swarms/invoice/skills/check-amount.yaml` — Sidecar config for the `check-amount` skill: declares `input_schema` (requires `amount: number`), `output_schema` (requires `valid: boolean`, `reason: string`), `timeout_seconds: 10`, `allowed_packages: []`

**Test additions:**
- `tests/test_skill_runner.py` — 6 new tests: `validate_skill_input` passes valid input, fails on missing required field, fails on wrong type; `validate_skill_output` passes valid output, fails on missing field; end-to-end `run_skill` + `validate_skill_output` round-trip
- `tests/test_triggers.py` — 6 new dedup tests: duplicate `event_id` is dropped (202, no publish), different IDs both published, payloads without `event_id` always accepted, same `event_id` on different triggers is not cross-contaminated; 2 `_DedupeCache` unit tests (basic behaviour, eviction at capacity)

**Total test count: 142 passing.**

### Why

Three gaps identified against the Phase 2 spec:
1. The spec requires a `.yaml` sidecar per skill declaring schemas and limits. The runtime already had a graceful `os.path.isfile` guard; the sidecar and validation were missing.
2. The spec requires input validated against `input_schema` before execution and output validated against `output_schema` after. Without this, a skill receiving malformed input would fail with an opaque subprocess error rather than a structured `SkillValidationError`.
3. The spec requires listener deduplication via in-memory LRU keyed by `payload.event_id` with 24h TTL. Without this, a retrying webhook sender could create duplicate events and duplicate runs.

### How to revert

- Remove `validate_skill_input`, `validate_skill_output` from `skill_runner.py`
- Remove the schema-loading and validation calls from `_execute_skill_call` in `runtime.py`; revert the import line
- Remove `_DedupeCache`, `_listener_dedup`, and the dedup check block from `triggers.py`
- Delete `data/workspaces/ops/swarms/invoice/skills/check-amount.yaml`
