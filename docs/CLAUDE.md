# CLAUDE.md

> Instructions for Claude (and other AI coding agents) working on this repository. Read this **before** writing any code or modifying any file.

---

## What this project is

A containerized multi-agent swarm platform: a Flask backend with SQLite, an in-process event bus and scheduler, sandboxed Python skills, and a vanilla-JS frontend. The architecture is designed to be **buildable, auditable, and reviewable by non-developers.** Every architectural choice has a reason — read the docs before guessing.

## The five documents you must know

If you have not read these, you do not have enough context to make changes. Read in this order:

1. **README.md** — orientation, principles, glossary
2. **PROJECT_STRUCTURE.md** — the canonical map of the codebase
3. **PHASE_4_EXAMPLE_BUNDLE.md** — concrete worked example. Read this *before* the build phases; it will save time.
4. **PHASE_1_BACKEND.md** through **PHASE_5_SETTINGS.md** — the build specifications
5. **WIREFRAME_PROMPT.md** — only if you're working on the GUI

When in doubt, the **example bundle (Phase 4) is canonical.** If a phase document and the example disagree, fix the phase document.

---

## Architectural principles you must respect

These are non-negotiable. Pull requests that violate them will need to be reverted.

### 1. Constitutions are identity. Topology is composition.

Agent `.md` files describe what an agent *is* — its role, values, knowledge, model. They **do not** declare what the agent connects to. Connections (skills, perceptionists, edges to other agents) live in the swarm's `hierarchy.json`, with declared purposes.

If you find yourself adding a `skills:` or `perceptionists:` field to constitution frontmatter, stop. That belongs in `hierarchy.json`. The only connection-like field allowed in constitutions is `knowledge`, because knowledge shapes how the agent thinks (identity), not what the agent calls (composition).

### 2. Strict mode for the topology, always.

Agents cannot call anything not declared in `hierarchy.json`. The runtime enforces this. Violations are logged as `topology_violation` and surfaced in the Runs view as a first-class concern, not a generic error.

Do not add a "permissive mode" or "fallback path" or "smart inference" of edges. If an agent needs to call something, declare the connection. The friction is the point.

Every action recorded in `run_steps` must include `edge_purpose` — the exact `purpose` string from the matching `hierarchy.json` entry. This is the audit trail's strongest claim.

### 3. Triggers are scripts, not agents.

Heartbeats, listeners, invocations: deterministic Python scripts. **No LLM calls inside triggers.** No fuzzy matching, no model inference, no "smart filtering" via Claude. Use regex, JSON Schema, JSONPath. Use the dumbest tool that works.

If a trigger needs judgment, that judgment belongs in an agent downstream of the trigger, not in the trigger itself.

### 4. Three scopes for everything reusable.

Knowledge, skills, and perceptionists live at exactly one of three scopes: **company**, **workspace**, **swarm**. References resolve from most-local outward (swarm → workspace → company). Qualified references (`workspace/foo`, `company/bar`) override resolution.

Do not invent additional scopes. Do not skip the scope chain. If a resource is only used by one swarm, it lives at swarm scope. If a resource is shared across the company, it lives at company scope. The middle case is workspace.

### 5. Filesystem is structure. Database is index.

Constitutions, hierarchies, knowledge, skills, trigger configs, meta files — all live as files on disk in `data/`. The database holds runtime state (events, runs, run_steps) and indexes (the registry tables) for fast queries.

You should be able to `git diff` a swarm. You should be able to `grep` constitutions. You should be able to back up a swarm by copying the folder. If you find yourself moving canonical content from disk to database, you're going the wrong way.

The `settings` table is the one principled exception — secrets must be encrypted, and encryption requires a database. Settings are *not* canonical configuration; they are runtime configuration that the operator edits via the GUI.

### 6. Single container, single SQLite file. Earn complexity.

No Redis, no Postgres, no Celery, no message broker, no Kafka. One Flask process, one APScheduler instance, one SQLite file. The seams are clean for adding those later — but adding them *now* is premature complexity.

If you think the project needs Redis, write a justification in the PR description and link to the specific bottleneck. "It would scale better" is not justification.

### 7. The frontend is a thin client.

All logic in the backend. The frontend reads from API endpoints, writes through API endpoints, and renders. It never holds canonical state. No Vuex, no Redux, no React (the frontend is vanilla JS by design). No build step.

If you find yourself implementing business logic in JavaScript, move it to the backend and call it via an API endpoint.

### 8. Cloud LLMs to start, swappable later.

Anthropic and OpenAI behind the `LLMClient` wrapper in `app/core/llm.py`. Agents *never* import provider SDKs directly — only the wrapper does. Do not bypass it.

When local LLMs (Ollama) are added later, the swap will be a one-file change. Do not preempt this by introducing provider-specific code paths in agents.

---

## Conventions

### File and folder naming

- **kebab-case** for filenames and folder names: `invoice-orchestrator.md`, not `invoice_orchestrator.md` or `InvoiceOrchestrator.md`
- Folder names are stable identifiers; display names live in `meta.yaml` and can change freely
- Generated identifiers (workspace and swarm folders when created via API) are slugs of the display name with a uniqueness suffix

### Python

- **Python 3.12+**. Type hints are required on public functions and class methods. Use `from __future__ import annotations` if needed.
- **No Flask imports inside `app/core/`** — that boundary is load-bearing for testability. If you find yourself wanting to import `flask` from a core module, you're solving the wrong problem.
- **Pydantic v2** for all request/response validation. No bare dicts at API boundaries.
- **SQLAlchemy 2.0 style** — `select()` not `query()`, typed `Mapped[]` columns.
- **Errors raise structured exceptions**, never return `None` to signal failure. The API layer translates exceptions to JSON error responses.
- **No bare `except:`** — always catch specific exceptions, always log with context.

### JavaScript

- **No build step.** Vanilla JS, ES modules, served directly by Flask.
- **No external state libraries.** State lives in the backend. The frontend keeps minimal UI state (which mode is active, which node is selected) in plain objects.
- **Cytoscape.js** is the only graph library. Don't introduce alternatives.
- **CodeMirror 6** is the only code editor. Don't introduce alternatives.

### Database

- **All schema changes via Alembic migrations.** Never edit the database directly, never use `Base.metadata.create_all()` outside tests.
- **One migration per phase boundary.** Phase 1 ships eight tables. Phase 5 adds two more. Don't sprinkle migrations across phases for tables that should have been defined upfront.
- **Indexes are part of the schema.** Add them in the migration, not later.

### Constitutions

- **YAML frontmatter, then markdown.** No exceptions, no alternative formats.
- **Frontmatter is identity-only.** Allowed fields: `name`, `layer`, `model`, `knowledge`. **Not allowed:** `skills`, `perceptionists`, `edges`, anything connection-related.
- **The body is plain markdown.** Don't try to parse it for structure; the LLM reads it as-is.
- **Knowledge references can be unqualified or qualified.** Unqualified resolves through the scope chain. Qualified (`workspace/foo`, `company/bar`) overrides resolution.

### `hierarchy.json`

- **One per swarm.** Lives in the swarm's folder.
- **Required top-level keys:** `swarm`, `agents`, `edges`, `consultations`, `skills`, `entry_point`.
- **Every edge requires a non-empty `purpose` string.** This is enforced at validation time. There is no way to suppress it.
- **Edge kinds are exactly:** `escalate` (upward authority), `delegate` (downward authority), `report` (returning results upward). No others.
- **Validation is strict.** Broken references, duplicate edges, missing purposes all mark the swarm `enabled=false` with a structured error. The system continues running other swarms.

### Skills

- **One `.py` file plus one `.yaml` file per skill, same basename.**
- **The Python file exposes `run(input: dict, context: dict) -> dict`.** Input is JSON-validated against the schema; output is JSON-validated.
- **The YAML file declares `input_schema`, `output_schema`, `timeout_seconds`, `allowed_packages`.**
- **Subprocess execution only.** Never `exec()` skills in the Flask process. The `skill_runner` module owns this.
- **Allowed packages enforced by static analysis at registration time.** Don't try to enforce at runtime.

### Settings (Phase 5)

- **Secrets are encrypted with Fernet** before they touch the database.
- **The master key is in `SWARM_ENCRYPTION_KEY`** as a base64-encoded 32-byte value. The container refuses to start if it's missing — there is no default.
- **Only `app/core/secrets.py` reads the master key.** Agents and skills never see plaintext API keys.
- **Audit log stores hashes, never values.** Even encrypted values do not go into `settings_audit`.

---

## Phase logs

For every phase actively worked on, maintain a log file in `docs/` named `logphase1.md`, `logphase2.md`, etc. (matching the phase number).

Each log entry should include:
- **Date** of the change
- **What was added or changed** (files created, modified, or deleted)
- **Why** (brief reason or context)
- **How to revert** (what to undo if the change needs to be rolled back)

Start the log when work on a phase begins. Append an entry for every meaningful change made during that phase. Do not batch entries — log as you go.

---

## What to do when…

### You're asked to add a new feature

1. Check whether it conflicts with the architectural principles above. If yes, push back and explain.
2. Check whether the example bundle (Phase 4) needs to be updated to demonstrate it.
3. Check which phase document it belongs in. Update that document *first*, then implement.
4. Add tests. Every public function in `app/core/` should be covered.

### You're asked to add a new dependency

Default answer: no. The dependencies are deliberately small. Justify the addition by:

1. Naming the specific problem it solves
2. Showing why the existing stack can't solve it
3. Confirming it doesn't break the "no build step" rule for frontend or the "single container" rule for backend

If you must add a Python dependency, add it to `pyproject.toml` with an explicit version constraint. If you must add a frontend dependency, prefer a CDN-loaded library over an npm package — there is no `node_modules` in this project.

### You're asked to make agents "smarter"

This usually means "add more LLM calls." Resist. The architecture's value is *not* that it does the most LLM-driven thing possible; it's that LLM judgment is reserved for steps that genuinely need judgment, and everything else is deterministic.

Before adding an LLM call, ask: could this be done with a regex, a database lookup, a JSON Schema validation, or a perceptionist? If yes, do that instead.

### You find inconsistency between documents

The order of authority:

1. Phase 4 (the example bundle) wins — it's the only document with concrete artifacts.
2. README.md principles win over phase document specifics.
3. PHASE_5 wins over earlier phases for settings-related concerns.
4. Earlier phases win over later phases for foundational concerns.

When you fix an inconsistency, update *both* documents in the same change. Don't leave the inconsistency in one place to be discovered later.

### You're tempted to skip writing a test

Don't. The test categories are documented in PROJECT_STRUCTURE.md. New code goes in the appropriate test file. The acceptance checklists at the end of each phase document are *real* — they're written as testable assertions.

### You're working on the GUI

- Read PHASE_3_INTERFACE.md before touching any frontend file.
- The three modes (org-design / swarm-design / constitution-edit) are distinct screens, not tabs in one super-screen.
- Edge creation requires a purpose string. Always. The modal that asks for it is the most opinionated interaction in the system; do not weaken it.
- Topology violations are first-class in the Runs view. They are not generic errors.
- Same color palette as the deck: navy `#1E2761`, amber `#F9A826`, deep navy `#0F1638`, ice `#CADCFC`.

---

## What you should not do

- **Do not invent new agent layers.** Four layers exist: Policy, Orchestrator, Executioner, Perceptionist. Adding a fifth is an architectural change requiring a phase document update first.
- **Do not add authentication piecemeal.** When auth is added, it will be its own phase. Until then, the system runs on localhost or behind a proxy. Don't sprinkle half-auth into APIs.
- **Do not add WebSockets.** SSE is the chosen transport for live updates. It's simpler, one-way, and sufficient. Don't reach for the larger hammer.
- **Do not add "convenience" code that hides architectural distinctions.** A helper function called `auto_resolve_anything()` that bypasses the scope chain is harmful even if it works.
- **Do not optimize prematurely.** SQLite, in-process scheduler, subprocess sandbox: these are deliberate choices. Profile before "improving" them.
- **Do not commit `data/`.** It's gitignored for a reason — it contains an operator's actual swarm.
- **Do not commit `.env`.** API keys and the master encryption key live there.

---

## Glossary (short version)

If you're not sure what a term means, the README has the full glossary. Quick reference:

- **Agent** — LLM-powered component with a constitution
- **Constitution** — markdown file defining an agent's role and values
- **Edge** — declared connection in `hierarchy.json` with kind and purpose
- **Layer** — Policy / Orchestrator / Executioner / Perceptionist
- **Perceptionist** — read-only grounding agent (maps reality to internal data)
- **Purpose** — string explaining *why* a connection exists; required on every edge
- **Run** — one execution of a swarm in response to an event
- **Run step** — one action within a run, recorded with `edge_purpose`
- **Scope** — company / workspace / swarm
- **Skill** — sandboxed Python script callable by an agent
- **Swarm** — coherent set of agents handling one class of work
- **Topology** — the declared graph in `hierarchy.json`
- **Trigger** — script (not agent) that produces events: heartbeat / listener / invocation
- **Workspace** — department-like container for swarms

---

## When in doubt

Ask yourself: *"would this make the system more reviewable by a non-developer, or less?"* The architecture's whole pitch is that a Finance manager can read an agent's constitution, a compliance officer can read a topology file, and an auditor can read a run's audit trail — all without reading code. Changes that reinforce this property are good. Changes that erode it are bad, even when they're technically clever.

If you're still uncertain, leave a comment in the PR explaining your dilemma. It's better to flag a question than to commit a guess.
