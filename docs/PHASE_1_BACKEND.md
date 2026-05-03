# Phase 1 — Backend Skeleton

> Goal: a containerized Flask service that boots clean, has the right folder shape, exposes the right endpoints, and has all eight tables migrated. No agents yet. No real work yet. Just the skeleton — but a skeleton with the *right bones* for what's coming.

---

## What "done" looks like for Phase 1

You can run `docker compose up`, the container starts, you visit `http://localhost:5000/api/v1/health`, you get a JSON response. You can create a workspace via API and see the folder appear on disk. You can create a swarm inside it. You can POST a fake event to a swarm and see it land in SQLite. You can stop and restart the container and the state survives. Phase 1 is not impressive. Phase 1 is *correct shape*.

---

## Stack

- **Python 3.12+**
- **Flask** for the HTTP layer (not FastAPI — keeping it boring)
- **SQLAlchemy** + **Alembic** for SQLite access and migrations
- **APScheduler** for heartbeat scheduling (in-process, fine for single container)
- **Anthropic SDK** + **OpenAI SDK** stubbed in but not wired to logic yet
- **Pydantic v2** for request/response validation
- **gunicorn** as the production WSGI server inside the container

No Celery, no Redis, no message broker. One process, one container, one SQLite file.

---

## The data model: scopes and swarms

Before the folder structure makes sense, the conceptual model needs to be clear.

The system organizes work in **three nested scopes** of resource ownership:

- **Company-wide** — resources every workspace can use (the company glossary, generic utility skills, infrastructure perceptionists like ERP lookup)
- **Workspace** — resources every swarm in a workspace shares (Finance procedures, approval thresholds for Invoicing)
- **Swarm** — resources specific to one swarm (the invoice-intake email parsing rules)

A **workspace** is a department-ish container. It holds one or more swarms and its own scoped resources. Workspaces are user-defined and renamable; the system does not assume any particular org chart.

A **swarm** is a coherent set of agents that collaborate to handle a class of work. "Invoice intake" is a swarm. "Contract review" is a different swarm. Each swarm has its own agents, its own scoped resources, its own triggers, and its own **hierarchy file** that declares the relationships between its agents.

Two artifacts deserve special mention because they're new:

- **`meta.yaml`** — display metadata for a workspace or swarm (name, description, owner, icon). Folder names are stable identifiers; display names live here and can change freely.
- **`hierarchy.json`** — for each swarm, declares the topology: which agents exist, what edges connect them, what each edge means, which perceptionists each agent may consult. **Enforced at runtime** in Phase 2 — agents cannot call anything not declared in this file.

---

## Folder structure

```
swarm/
├── docker/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── entrypoint.sh
├── app/
│   ├── __init__.py            # Flask app factory
│   ├── config.py              # env-driven config
│   ├── db.py                  # SQLAlchemy engine + session
│   ├── models/
│   │   ├── __init__.py
│   │   ├── workspace.py
│   │   ├── swarm.py
│   │   ├── agent.py
│   │   ├── run.py
│   │   ├── run_step.py
│   │   ├── event.py
│   │   ├── trigger.py
│   │   └── knowledge.py
│   ├── api/
│   │   ├── __init__.py
│   │   ├── health.py
│   │   ├── workspaces.py
│   │   ├── swarms.py
│   │   ├── agents.py
│   │   ├── events.py
│   │   ├── triggers.py
│   │   └── runs.py
│   ├── core/
│   │   ├── __init__.py
│   │   ├── event_bus.py       # in-process event dispatcher
│   │   ├── llm.py             # provider-agnostic LLM client wrapper
│   │   ├── registry.py        # walks the data tree, indexes everything
│   │   └── resolver.py        # resolves scoped references (swarm → workspace → company)
│   └── scheduler.py           # APScheduler setup
├── migrations/                # Alembic
├── data/                      # mounted volume — survives container restart
│   ├── swarm.db               # SQLite
│   ├── company/               # company-wide scope
│   │   ├── knowledge/
│   │   ├── skills/
│   │   └── perceptionists/
│   └── workspaces/
│       └── <workspace-id>/
│           ├── meta.yaml
│           ├── knowledge/
│           ├── skills/
│           ├── perceptionists/
│           └── swarms/
│               └── <swarm-id>/
│                   ├── meta.yaml
│                   ├── hierarchy.json
│                   ├── agents/
│                   ├── knowledge/
│                   ├── skills/
│                   └── triggers/
├── tests/
├── pyproject.toml
├── .env.example
└── README.md
```

The `data/` folder is the **mount point**. Everything that should survive a container rebuild lives here. Workspace and swarm folder names are opaque identifiers (auto-generated UUIDs or slugs); display names live in `meta.yaml`. This means humans can rename things in the GUI without breaking any references on disk.

---

## Database schema

All tables are defined and migrated in Phase 1, even though Phase 1 only writes to a subset of them. Phase 2 then has nothing to migrate — it just starts populating tables that already exist.

### `workspaces`
A workspace is a department-ish container. The folder is the source of truth; the table is an index.

| column | type | notes |
|---|---|---|
| id | uuid pk | matches the folder name |
| name | text unique | folder name (stable identifier) |
| display_name | text | from `meta.yaml`, can change |
| description | text nullable | |
| icon | text nullable | display icon name or path |
| meta_hash | text | sha256 of `meta.yaml` |
| created_at | timestamp | |
| updated_at | timestamp | |

### `swarms`
A swarm lives inside a workspace.

| column | type | notes |
|---|---|---|
| id | uuid pk | matches the folder name |
| workspace_id | uuid fk | |
| name | text | folder name |
| display_name | text | from `meta.yaml` |
| description | text nullable | |
| meta_hash | text | sha256 of `meta.yaml` |
| hierarchy_hash | text | sha256 of `hierarchy.json` |
| created_at | timestamp | |
| updated_at | timestamp | |

Unique constraint on `(workspace_id, name)`.

### `agents`
A registry row per agent constitution. The `.md` file is the source of truth.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| swarm_id | uuid fk nullable | which swarm this agent belongs to (null for non-swarm perceptionists) |
| workspace_id | uuid fk nullable | for workspace-scoped perceptionists |
| scope | text | `company` / `workspace` / `swarm` |
| name | text | `.md` filename without extension |
| layer | text | `policy` / `orchestrator` / `executioner` / `perceptionist` |
| md_path | text | relative path to constitution file |
| md_hash | text | sha256 |
| enabled | boolean | default true |
| created_at | timestamp | |
| updated_at | timestamp | |

Perceptionists can live at any of the three scopes. Other agent layers (Policy, Orchestrator, Executioner) only live within a swarm.

### `triggers`
Configured triggers belong to a swarm.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| swarm_id | uuid fk | |
| name | text | |
| kind | text | `heartbeat` / `listener` / `invocation` |
| config_json | text | full trigger config as JSON |
| enabled | boolean | |
| watermark | text nullable | last-seen cursor; trigger owns this |
| created_at | timestamp | |
| updated_at | timestamp | |

Unique constraint on `(swarm_id, name)`.

### `events`
Every event that enters the swarm.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| swarm_id | uuid fk | which swarm should handle this event |
| trigger_id | uuid fk nullable | which trigger produced it (null = direct API) |
| source | text | `heartbeat` / `listener` / `invocation` / `api` |
| payload_json | text | normalized event payload |
| received_at | timestamp | |

### `runs`
Each time an event causes a swarm to do something, a run is created.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| event_id | uuid fk | |
| swarm_id | uuid fk | denormalized for fast filtering |
| status | text | `pending` / `running` / `completed` / `failed` |
| started_at | timestamp nullable | |
| ended_at | timestamp nullable | |
| error | text nullable | |

### `run_steps`
Every action taken during a run. Phase 1 leaves this table empty; Phase 2 populates it.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| run_id | uuid fk | |
| agent_id | uuid fk nullable | which agent acted (null for skill calls) |
| step_type | text | `agent_call` / `skill_call` / `perceptionist_call` / `human_escalation` |
| step_name | text | name of the agent, skill, or perceptionist invoked |
| edge_purpose | text nullable | from `hierarchy.json` — *why* this call was allowed |
| input_json | text | what the step received |
| output_json | text nullable | what it returned |
| started_at | timestamp | |
| ended_at | timestamp nullable | |
| error | text nullable | |
| sequence | integer | ordering within the run, starting at 1 |

Index on `(run_id, sequence)`. The `edge_purpose` field captures, for every step, *which declared edge in `hierarchy.json` authorized this call.* This is the audit trail's strongest claim: every interaction was a pre-declared topology edge.

### `knowledge_documents`
Index of knowledge documents at any scope.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| scope | text | `company` / `workspace` / `swarm` |
| workspace_id | uuid fk nullable | required if scope is workspace or swarm |
| swarm_id | uuid fk nullable | required if scope is swarm |
| name | text | filename without extension |
| md_path | text | relative path |
| md_hash | text | sha256 |
| size_bytes | integer | |
| title | text nullable | extracted from first `# Heading` |
| created_at | timestamp | |
| updated_at | timestamp | |

Unique constraint on `(scope, workspace_id, swarm_id, name)`.

---

That's eight tables, all migrated in Phase 1. Phase 2 adds no new tables — it only adds rows.

---

## Reference resolution

The registry needs to resolve names to files. When an agent's constitution or a swarm's `hierarchy.json` references a knowledge document, skill, or perceptionist by name, the resolver searches in this order:

1. **Swarm scope** — the swarm's own folder
2. **Workspace scope** — the parent workspace's folder
3. **Company scope** — the company-wide folder

The most-local match wins. To override resolution explicitly, references can be qualified:

- `approval-thresholds` — unqualified, search swarm → workspace → company
- `workspace/finance-procedures` — explicitly workspace-scoped
- `company/glossary` — explicitly company-wide

The resolver is `app/core/resolver.py`. It takes a reference, a resource type (`knowledge` / `skill` / `perceptionist`), and a swarm context, and returns a `(scope, absolute_path)` tuple or raises a clear "not found" error. Phase 1 implements and unit-tests the resolver even though no agents are using it yet — getting the rules right early prevents subtle bugs in Phase 2.

---

## API endpoints (Phase 1)

All JSON. All under `/api/v1`. CORS open for `localhost` only by default.

### Health
- `GET /api/v1/health` — `{"status": "ok", "version": "0.1.0", "uptime_seconds": N}`

### Workspaces
- `GET /api/v1/workspaces` — list
- `GET /api/v1/workspaces/<id>` — detail with embedded swarms
- `POST /api/v1/workspaces` — create (writes folder + `meta.yaml`)
- `PUT /api/v1/workspaces/<id>` — update display metadata
- `DELETE /api/v1/workspaces/<id>` — refuses if it has swarms

### Swarms
- `GET /api/v1/workspaces/<wid>/swarms` — list
- `GET /api/v1/swarms/<id>` — detail with agents, triggers, hierarchy
- `POST /api/v1/workspaces/<wid>/swarms` — create
- `PUT /api/v1/swarms/<id>` — update display metadata
- `DELETE /api/v1/swarms/<id>` — remove

### Agents (read-only in Phase 1)
- `GET /api/v1/swarms/<sid>/agents` — list agents in a swarm
- `GET /api/v1/agents/<id>` — one agent's metadata + raw `.md` content

### Triggers
- `GET /api/v1/swarms/<sid>/triggers` — list
- `POST /api/v1/swarms/<sid>/triggers` — create
- `PUT /api/v1/triggers/<id>` — update
- `DELETE /api/v1/triggers/<id>` — remove

### Events
- `POST /api/v1/swarms/<sid>/events` — fire an event into a specific swarm
- `GET /api/v1/events?swarm_id=<sid>&limit=50` — recent events

### Runs
- `GET /api/v1/runs?swarm_id=<sid>&limit=50` — recent runs
- `GET /api/v1/runs/<id>` — one run with its steps

Phase 1 hands back stub responses where logic isn't built yet — but the **contract is real.** Phase 2 fills in behavior without touching the API surface.

---

## The event bus (in-process, single-container)

A simple Python object with `publish(event)` and `subscribe(handler)`. Every event:

1. Gets persisted to the `events` table immediately (durability)
2. Gets dispatched to subscribers asynchronously via a thread pool
3. Returns to the caller without blocking

When you outgrow it, swap the implementation behind the same interface. No callers change.

---

## LLM client wrapper

Wrap Anthropic and OpenAI behind one interface from day one:

```python
class LLMClient:
    def complete(self, system: str, messages: list[dict], **kwargs) -> str: ...
```

The wrapper reads `LLM_PROVIDER=anthropic|openai` from env. Agents in Phase 2 only ever call `LLMClient.complete()` — they don't import provider SDKs directly.

API keys come from environment variables, never from code. Documented in `.env.example`.

---

## Configuration

All config is environment variables.

Required:
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
- `LLM_PROVIDER` — `anthropic` or `openai`
- `LLM_MODEL` — e.g. `claude-opus-4-7` or `gpt-4o`

Optional with defaults:
- `DATABASE_URL` — defaults to `sqlite:////data/swarm.db`
- `DATA_DIR` — defaults to `/data`
- `LOG_LEVEL` — defaults to `INFO`
- `SCHEDULER_TIMEZONE` — defaults to `Europe/Amsterdam`

---

## Docker setup

### Dockerfile
- Base: `python:3.12-slim`
- Install via `pip install .`
- Entrypoint runs Alembic migrations then starts gunicorn
- Expose port 5000

### docker-compose.yml

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

## Tests

Phase 1 ships with these tests passing:

- App boots without error
- Migrations run cleanly on an empty database
- `/health` returns 200
- `/workspaces`, `/swarms`, `/agents` all return `[]` on a fresh install
- A workspace can be created via API and the folder + `meta.yaml` appears on disk
- A swarm can be created within a workspace, with `meta.yaml` and an empty `hierarchy.json`
- The resolver correctly walks swarm → workspace → company
- The resolver correctly handles `workspace/` and `company/` qualifiers
- The resolver returns the most-local match when the same name exists at multiple scopes
- LLM client wrapper picks the right backend based on env

---

## What Phase 1 deliberately does NOT include

- Any agent actually running
- Any LLM calls being made
- Any skill execution
- Any frontend
- Any authentication
- Any websockets / SSE for live run updates
- Any `hierarchy.json` validation logic (Phase 2)
- Any registry walk over agent constitutions (Phase 2)

---

## Acceptance checklist

- [ ] `docker compose up` starts cleanly from a fresh clone
- [ ] `data/` volume persists across `docker compose down && up`
- [ ] All Phase 1 endpoints return correct shapes (even if stubbed)
- [ ] Migrations create all eight tables
- [ ] Creating a workspace via API creates the folder structure on disk
- [ ] Creating a swarm via API creates the folder + `meta.yaml` + an empty valid `hierarchy.json`
- [ ] Resolver passes its unit tests for all scope-walking and qualifier cases
- [ ] LLM client wrapper switches providers via env
- [ ] README documents folder structure, scope rules, and how to run
