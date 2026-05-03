# Project Structure

> A containerized multi-agent swarm platform built with Flask, SQLite, and Vanilla JS.
> Organized across five phases plus a worked example: Backend Skeleton → Agent Modules → GUI Interface → Example Bundle → Settings & Customization.

---

## Directory Overview

```
swarm/
├── docker/
├── app/
│   ├── models/
│   ├── api/
│   ├── core/
│   └── static/
│       ├── css/
│       └── js/
│           ├── views/
│           └── components/
├── migrations/
├── tests/
├── data/                  ← mounted volume
│   ├── company/
│   ├── workspaces/
│   │   └── <workspace-id>/
│   │       └── swarms/
│   │           └── <swarm-id>/
│   └── branding/          ← uploaded logo, etc.
├── pyproject.toml
├── .env.example
└── README.md
```

---

## `docker/` — Container Setup

| File | Purpose |
|---|---|
| `Dockerfile` | Python 3.12-slim base, installs via `pip install .` |
| `docker-compose.yml` | Mounts `./data:/data`, exposes port 5000 |
| `entrypoint.sh` | Runs Alembic migrations, then starts gunicorn |

The `docker-compose.yml` is intentionally minimal:

```yaml
services:
  swarm:
    build: ./docker
    ports: ["5000:5000"]
    volumes: ["./data:/data"]
    env_file: .env
    restart: unless-stopped
```

---

## `app/` — Flask Application Package

The application follows a strict separation: the `api/` layer is HTTP plumbing only. All business logic lives in `core/` with zero Flask imports, making it independently testable.

### `app/__init__.py` — App Factory
Creates the Flask app, registers blueprints, initializes the scheduler and event bus.

### `app/config.py` — Environment-Driven Config
All configuration comes from environment variables. Never from code.

**Required:**
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
- `LLM_PROVIDER` — `anthropic` or `openai`
- `LLM_MODEL` — e.g. `claude-opus-4-7` or `gpt-4o`
- `SWARM_ENCRYPTION_KEY` — 32-byte base64-encoded master key for at-rest secret encryption *(Phase 5)*

**Optional (with defaults):**
- `DATABASE_URL` — defaults to `sqlite:////data/swarm.db`
- `DATA_DIR` — defaults to `/data`
- `LOG_LEVEL` — defaults to `INFO`
- `SCHEDULER_TIMEZONE` — defaults to `Europe/Amsterdam`

### `app/db.py` — Database Layer
SQLAlchemy engine and session factory. Used by all models and by the registry.

### `app/scheduler.py` — APScheduler Setup
In-process scheduler for heartbeat triggers. Reads enabled heartbeats at startup and registers them. No Celery, no Redis — one process, one container.

---

## `app/models/` — ORM Models

All ten tables are defined and migrated in Phase 1. Phase 2 adds no new tables — it only adds rows. Phase 5 introduces two further tables that ship in their own migration.

| File | Table | Notes |
|---|---|---|
| `workspace.py` | `workspaces` | Folder is the source of truth; table is an index |
| `swarm.py` | `swarms` | Belongs to a workspace |
| `agent.py` | `agents` | One row per constitution `.md` file |
| `run.py` | `runs` | Created each time an event causes a swarm to act |
| `run_step.py` | `run_steps` | Every action taken during a run, with `edge_purpose` |
| `event.py` | `events` | Every event that enters the system |
| `trigger.py` | `triggers` | Heartbeat, listener, and invocation configs |
| `knowledge.py` | `knowledge_documents` | Index of all knowledge docs at any scope |
| `setting.py` *(Phase 5)* | `settings` | Single-row-per-key configuration store |
| `settings_audit.py` *(Phase 5)* | `settings_audit` | Append-only log of every settings change |

The `run_steps.edge_purpose` column is the audit trail's strongest claim: every interaction was a pre-declared topology edge from `hierarchy.json`.

---

## `app/api/` — REST Endpoints

All endpoints are JSON, all under `/api/v1`, CORS open for `localhost` by default.

| File | Endpoints |
|---|---|
| `health.py` | `GET /health` |
| `workspaces.py` | CRUD for workspaces |
| `swarms.py` | CRUD for swarms |
| `agents.py` | Read-only in Phase 1; populated by registry in Phase 2 |
| `events.py` | `POST` to fire events, `GET` to list recent |
| `triggers.py` | CRUD for triggers; dynamic listener routes registered at boot |
| `runs.py` | List runs and get full step detail |
| `stream.py` | `GET /stream` — SSE endpoint for live run updates *(Phase 3)* |
| `settings.py` *(Phase 5)* | Read/write settings, test LLM credentials, upload logo, rotate encryption key |

Phase 1 returns stub responses where logic isn't built yet. The contract is real; later phases fill in behavior without touching the API surface.

---

## `app/core/` — Business Logic

No Flask imports here. Every module is independently testable.

### `event_bus.py`
In-process pub/sub dispatcher. Every event is:
1. Persisted to the `events` table immediately (durability)
2. Dispatched to subscribers asynchronously via a thread pool
3. Returns to the caller without blocking

When you outgrow it, swap the implementation behind the same interface. No callers change.

### `llm.py`
Provider-agnostic LLM client wrapper. Agents never import provider SDKs directly.

```python
class LLMClient:
    def complete(self, system: str, messages: list[dict], **kwargs) -> str: ...
```

Reads `LLM_PROVIDER=anthropic|openai` from env. API keys come from environment variables, never from code.

### `resolver.py` *(Phase 1)*
Resolves named references to files by walking the three-scope chain:

1. **Swarm scope** — the swarm's own folder
2. **Workspace scope** — the parent workspace's folder
3. **Company scope** — the company-wide folder

The most-local match wins. References can be qualified to override resolution:

- `approval-thresholds` — unqualified, searches swarm → workspace → company
- `workspace/finance-procedures` — explicitly workspace-scoped
- `company/glossary` — explicitly company-wide

Returns a `(scope, absolute_path)` tuple or raises a clear "not found" error.

### `registry.py` *(Phase 2)*
Walks the `data/` tree on boot and on filesystem changes (via `watchdog`). Registers agents, knowledge documents, skills, and triggers into the database. Changes are picked up within seconds without restart.

### `hierarchy.py` *(Phase 2)*
Parses and validates each swarm's `hierarchy.json`. A swarm with a broken topology is marked `enabled=false` with a structured error — it does not crash the system.

Validation checks include:
- Every agent name resolves to a constitution file
- Every edge references declared agents
- Every perceptionist and skill resolves through the scope chain
- No duplicate edges
- All `purpose` strings are non-empty

### `runtime.py` *(Phase 2)*
Executes agents and enforces the topology. When an agent returns an action, the runtime checks `hierarchy.json` before dispatching. Undeclared actions are refused and logged as `topology_violation`.

### `skill_runner.py` *(Phase 2)*
Runs skill scripts in sandboxed subprocesses. Skills receive `{"input": {...}, "context": {...}}` on `argv` and return a JSON object on stdout. Skills that exceed their timeout are killed and the run is marked failed.

### `secrets.py` *(Phase 5)*
The only module that reads `SWARM_ENCRYPTION_KEY`. Encrypts and decrypts secrets using Fernet (symmetric AES-128-CBC + HMAC) before they hit the database. Agents and skills never see plaintext API keys — they call `secrets.get_llm_credentials(provider)` which returns a configured `LLMClient` instance. The container refuses to start if the master key is missing.

---

## `app/static/` — Frontend *(Phase 3)*

Vanilla JS + HTML + CSS. No build step, no bundler, no npm. All assets served directly by Flask.

The hard rule: **the frontend is a thin client.** All logic lives in the backend. The frontend reads from API endpoints, writes through API endpoints, and renders. It never holds canonical state.

### `index.html`
Single entry point for the entire application.

### `css/`

| File | Purpose |
|---|---|
| `tokens.css` | Design tokens — colors, typography, spacing |
| `main.css` | Global layout, top bar, sidebar, drawer |
| `canvas.css` | Cytoscape.js canvas overrides |

**Color palette:**
- Background: `#FAFBFC`
- Top bar: `#0F1638`
- Primary action: `#1E2761` navy
- Accent / live state: `#F9A826` amber
- Typography: Inter for UI, JetBrains Mono for code, Georgia for display

### `js/app.js`
Entry point. Handles routing between the three modes and persists the SSE connection.

### `js/api.js`
Fetch wrapper for all backend endpoints. Single place to handle auth headers, error shapes, and base URL.

### `js/sse.js`
SSE client. Keeps one persistent connection to `GET /api/v1/stream` and dispatches events to whichever view is active.

### `js/views/` — One File Per Screen

| File | Mode | Description |
|---|---|---|
| `org-design.js` | Mode 1 | Workspace and swarm cards, resource management, scope promotion |
| `swarm-canvas.js` | Mode 2 | Cytoscape.js topology canvas with live run animation |
| `constitution-editor.js` | Mode 3 | CodeMirror 6 editor with frontmatter form and history |
| `runs.js` | Observation | Paginated run list and step-by-step detail |
| `library.js` | Management | Skills and knowledge management across all three scopes |
| `settings.js` *(Phase 5)* | Configuration | Five tabs: providers, models, branding, system, security |

### `js/components/` — Reusable UI Pieces

| File | Purpose |
|---|---|
| `inspector.js` | Right sidebar — context-sensitive node/edge/swarm detail |
| `toast.js` | Error toast component; highlights offending field when `field` is set |
| `palette.js` | Command palette (`Cmd+K`) — jump to any workspace, swarm, agent, or document |

---

## `migrations/` — Alembic

Eight tables are created in a single Phase 1 migration. Phase 2 adds no migrations — it only populates tables that already exist. Phase 5 adds one further migration that creates the two settings tables.

---

## `tests/` — Pytest Suite

| File | Phase | What it covers |
|---|---|---|
| `conftest.py` | P1 | Test app factory, in-memory SQLite fixture |
| `test_resolver.py` | P1 | Scope-chain walking, qualified references, most-local-wins |
| `test_api.py` | P1 | All Phase 1 endpoints return correct shapes |
| `test_hierarchy.py` | P2 | Validator catches broken references, duplicates, missing purposes |
| `test_runtime.py` | P2 | Topology enforcement, violation logging, skill timeout |
| `test_triggers.py` | P2 | Heartbeat scheduling, listener webhook, invocation POST |
| `test_secrets.py` | P5 | Fernet encryption round-trip, key rotation, missing-key refusal |
| `test_settings.py` | P5 | Settings CRUD, audit log hashing, masked secret responses |

---

## `data/` — Mounted Volume

Everything that should survive a container rebuild lives here. Never commit this directory.

```
data/
├── swarm.db
├── company/
│   ├── knowledge/        *.md
│   ├── skills/           *.py + *.yaml
│   └── perceptionists/   *.md
├── workspaces/
│   └── <workspace-id>/
│       ├── meta.yaml
│       ├── knowledge/
│       ├── skills/
│       ├── perceptionists/
│       └── swarms/
│           └── <swarm-id>/
│               ├── meta.yaml
│               ├── hierarchy.json
│               ├── agents/
│               ├── knowledge/
│               ├── skills/
│               └── triggers/
└── branding/
    └── logo.{png,svg}    ← uploaded via Settings → Branding
```

### Key files

**`meta.yaml`** — display metadata for workspaces and swarms. Folder names are stable identifiers; display names live here and can change freely without breaking any disk references.

```yaml
display_name: Invoicing
description: Workflows for receiving, validating, and booking supplier invoices.
icon: file-invoice-dollar
owner: finance-team@example.com
```

**`hierarchy.json`** — the authoritative topology for a swarm. Declares agents, edges, perceptionist consultations, and skill connections. Enforced at runtime — agents cannot call anything not declared here.

```json
{
  "swarm": "invoice-intake",
  "agents": ["invoice-orchestrator", "approval-policy"],
  "edges": [
    {
      "from": "invoice-orchestrator",
      "to": "approval-policy",
      "kind": "escalate",
      "purpose": "Check authorization rules before booking"
    }
  ],
  "consultations": [...],
  "skills": [...]
}
```

**Agent constitution (`.md`)** — YAML frontmatter for machine-readable identity, markdown body for the agent's instructions.

```markdown
---
name: invoice-orchestrator
layer: orchestrator
model: claude-opus-4-7
knowledge:
  - finance-procedures
  - approval-thresholds
---

You are the Invoice Intake Orchestrator...
```

Notice what is *not* in the frontmatter: no skills, no perceptionist lists, no declarations of who this agent talks to. Those are swarm-level wiring decisions that live in `hierarchy.json`. This separation lets the same constitution be reused across swarms with different topologies.

---

## Scope Resolution

The resolver searches in this order, returning the most-local match:

```
swarm/knowledge/approval-thresholds.md   ← wins if it exists
workspace/knowledge/approval-thresholds.md
company/knowledge/approval-thresholds.md
```

Use qualifiers to be explicit:

| Reference | Resolves to |
|---|---|
| `approval-thresholds` | Most-local match (swarm → workspace → company) |
| `workspace/finance-procedures` | Workspace scope only |
| `company/glossary` | Company scope only |

---

## Build Phases

| Phase | What gets built | Key deliverable |
|---|---|---|
| **Phase 1** | Docker setup, all eight core models, all API stubs, resolver | `docker compose up` → health endpoint responds |
| **Phase 2** | Registry, hierarchy validator, runtime, skills, knowledge, triggers | Full event flow with topology enforcement and audit trail |
| **Phase 3** | Entire frontend — canvas, editors, runs screen, SSE live mode | Usable without ever opening a terminal |
| **Phase 4** | Example invoice-intake swarm dropped into `data/` | End-to-end demo of every artifact type |
| **Phase 5** | Settings tables and migration, encryption layer, settings UI | LLM credentials, models, branding, system defaults manageable from the GUI |

---

## Stack Summary

| Layer | Technology |
|---|---|
| HTTP | Flask + gunicorn |
| ORM | SQLAlchemy + Alembic |
| Database | SQLite (single file in `data/`) |
| Scheduling | APScheduler (in-process) |
| LLM | Anthropic SDK / OpenAI SDK behind a common wrapper |
| Validation | Pydantic v2 |
| Encryption | `cryptography.fernet` for at-rest secrets |
| Frontend | Vanilla JS + HTML + CSS (no build step) |
| Canvas | Cytoscape.js + dagre layout |
| Editor | CodeMirror 6 |
| Container | Docker + docker-compose |
| Tests | pytest |
