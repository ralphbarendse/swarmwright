# SwarmWright

A containerized multi-agent swarm platform for handling administrative and interpretive work. Agents are governed by a strict topology — every connection is declared, every action is auditable.

---

## Quick start

```bash
cp .env.example .env
# Fill in LLM_PROVIDER, LLM_MODEL, and the appropriate API key.
# SWARM_ENCRYPTION_KEY can be left empty — see "Encryption key" below.

docker compose -f docker/docker-compose.yml up
```

The API is available at `http://localhost:5000/api/v1/health`.

### Encryption key

Phase 5 stores LLM credentials and other secrets encrypted at rest. The master
key is resolved in this order on every boot:

1. `SWARM_ENCRYPTION_KEY` env var — wins if set
2. `<DATA_DIR>/.encryption_key` file — auto-managed by the container
3. If neither exists, a new key is generated on first boot and written to
   `<DATA_DIR>/.encryption_key`

The auto-generated path means a fresh `docker compose up` works without any
key setup. The trade-off: the key lives next to the encrypted database, so
**back up `data/.encryption_key` alongside `data/swarm.db`** (or, ideally,
store the key separately from your routine data backups). If you lose the
key, encrypted settings cannot be recovered.

For higher-assurance deployments, generate a key out-of-band and pin it to
`SWARM_ENCRYPTION_KEY` so it never touches the data volume:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

---

## Folder structure

```
swarmwright/
├── app/
│   ├── models/        — SQLAlchemy ORM models (8 tables)
│   ├── api/           — Flask blueprints, all under /api/v1
│   ├── core/          — Business logic (no Flask imports)
│   │   ├── event_bus.py   — In-process pub/sub dispatcher
│   │   ├── llm.py         — Provider-agnostic LLM client wrapper
│   │   ├── resolver.py    — Three-scope reference resolver
│   │   └── registry.py    — Filesystem walker (Phase 2)
│   └── static/        — Vanilla JS frontend (Phase 3)
├── docker/            — Dockerfile, docker-compose.yml, entrypoint.sh
├── migrations/        — Alembic migrations
├── tests/             — pytest suite
├── data/              — Mounted volume (never committed)
│   ├── swarm.db
│   ├── company/       — Company-wide knowledge, skills, perceptionists
│   ├── workspaces/    — One folder per workspace
│   │   └── <workspace-id>/
│   │       ├── meta.yaml
│   │       ├── knowledge/  skills/  perceptionists/
│   │       └── swarms/
│   │           └── <swarm-id>/
│   │               ├── meta.yaml
│   │               ├── hierarchy.json   ← topology, enforced at runtime
│   │               ├── agents/          ← constitution .md files
│   │               ├── knowledge/  skills/  triggers/
│   └── branding/
├── pyproject.toml
└── .env.example
```

The `data/` directory is the **mount point** — everything that must survive a container rebuild lives here. It is gitignored.

---

## Scope rules

Resources (knowledge documents, skills, perceptionists) exist at one of three scopes. The resolver searches most-local-first:

```
swarm scope     →  data/workspaces/<wid>/swarms/<sid>/<resource-type>/
workspace scope →  data/workspaces/<wid>/<resource-type>/
company scope   →  data/company/<resource-type>/
```

References in constitutions and `hierarchy.json` can be **unqualified** (auto-resolve) or **qualified** (explicit scope):

| Reference | Resolves to |
|---|---|
| `approval-thresholds` | Most-local match: swarm → workspace → company |
| `workspace/finance-procedures` | Workspace scope only |
| `company/glossary` | Company scope only |

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_PROVIDER` | Yes | `anthropic` | `anthropic` or `openai` |
| `LLM_MODEL` | Yes | `claude-opus-4-6` | Model identifier |
| `ANTHROPIC_API_KEY` | If provider=anthropic | — | Anthropic API key |
| `OPENAI_API_KEY` | If provider=openai | — | OpenAI API key |
| `SWARM_ENCRYPTION_KEY` | Optional | auto-generated | 32-byte base64 master key. If unset, the container generates one on first boot and persists it to `<DATA_DIR>/.encryption_key`. Set explicitly to manage the key out-of-band (e.g. via a secret manager). |
| `DATABASE_URL` | No | `sqlite:////data/swarm.db` | SQLAlchemy URL |
| `DATA_DIR` | No | `/data` | Path to the data volume |
| `LOG_LEVEL` | No | `INFO` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |
| `SCHEDULER_TIMEZONE` | No | `Europe/Amsterdam` | APScheduler timezone |

---

## API endpoints

All endpoints are JSON, all under `/api/v1`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET/POST` | `/workspaces` | List / create workspaces |
| `GET/PUT/DELETE` | `/workspaces/<id>` | Get / update / delete workspace |
| `GET/POST` | `/workspaces/<id>/swarms` | List / create swarms |
| `GET/PUT/DELETE` | `/swarms/<id>` | Get / update / delete swarm |
| `GET` | `/swarms/<id>/agents` | List agents in a swarm (read-only Phase 1) |
| `GET` | `/agents/<id>` | Get one agent |
| `GET/POST` | `/swarms/<id>/triggers` | List / create triggers |
| `PUT/DELETE` | `/triggers/<id>` | Update / delete trigger |
| `POST` | `/swarms/<id>/events` | Fire an event into a swarm |
| `GET` | `/events` | List recent events |
| `GET` | `/runs` | List recent runs |
| `GET` | `/runs/<id>` | Get one run with full step trace |

---

## Running tests

```bash
python3 -m pytest tests/test_resolver.py tests/test_api.py tests/test_llm.py -v
```

---

## Build phases

| Phase | What gets built |
|---|---|
| **Phase 1** (current) | Docker skeleton, 8-table schema, all API stubs, resolver |
| **Phase 2** | Registry, hierarchy validator, topology runtime, skills, knowledge, triggers |
| **Phase 3** | Full GUI — org-design, swarm-design canvas, constitution editor, Runs screen |
| **Phase 4** | Example invoice-intake swarm |
| **Phase 5** | Settings — LLM credentials, models, branding, encryption |

See `docs/` for the full specification of each phase.
