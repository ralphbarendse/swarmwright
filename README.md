<h1 align="center">SwarmWright</h1>

<p align="center">
  Self-hosted multi-agent AI orchestration — structured by design, auditable by default.
</p>

<p align="center">
  <a href="https://www.swarmwright.com">swarmwright.com</a> &nbsp;·&nbsp;
  <a href="https://www.swarmwright.com/docs.html">Docs</a> &nbsp;·&nbsp;
  <a href="LICENSE">CC BY-NC 4.0</a>
</p>

---

Build teams of AI agents that handle real work. SwarmWright enforces a strict topology — every connection is declared, every action is logged, anything that needs a human lands in the Inbox.

Agents don't call each other freely. You define who talks to whom, what triggers a run, and what requires sign-off. The runtime enforces it.

---

## Quick start

```bash
docker pull ralphbarendse/swarmwright:latest

docker run -d \
  --name swarmwright \
  --network host \
  --restart unless-stopped \
  -v ./data:/data \
  ralphbarendse/swarmwright:latest
```

Open `http://localhost:5001`, go to **Settings**, and enter your LLM provider and API key. That's it.

---

## What it does

You build **swarms** — groups of agents, each with a written constitution describing their role and behaviour. Swarms live inside **workspaces** (think: departments). A company-wide layer sits above everything and is shared across all workspaces.

A run starts when an event fires — on a schedule, via webhook, or manually from the Control Room. The runtime walks the declared topology, calls each agent in turn, logs every step, and surfaces anything requiring human judgement to the Inbox.

### Agent layers

Every agent has one of four roles — the topology only allows edges that make architectural sense:

| Layer | Role |
|---|---|
| **Policy** | Defines rules and guardrails other agents must follow |
| **Orchestrator** | Breaks goals into tasks and delegates down |
| **Executioner** | Does the actual work — calls tools, runs skills |
| **Perceptionist** | Watches for events, reads inputs, triggers runs |

### The UI

- **Canvas** — drag-and-drop topology editor, wire agents and set edge types
- **Constitution editor** — write agent roles in plain Markdown with live preview
- **Control Room** — fire runs manually, monitor active runs, stop them mid-flight
- **Inbox** — human-in-the-loop approvals and escalations
- **Library** — manage knowledge docs, Python skills, and triggers at any scope
- **Settings** — LLM provider, model, API keys (encrypted at rest), custom branding

---

## Features

- Topology-enforced agent graphs — delegate, escalate, and report edges only where declared
- Three-scope resource resolver: swarm → workspace → company, unqualified refs auto-resolve
- Python skills — drop a `.py` file in `skills/`, agents can call it as a tool
- Scheduled and webhook triggers with cron expressions, backed by YAML files
- Full run trace with per-step input/output logging
- Human-in-the-loop escalation with inbox approvals
- Encrypted secret storage (Fernet, key auto-generated on first boot)
- File-backed topology — `hierarchy.json` and constitutions are plain files you can version
- Single Docker container, SQLite, no external dependencies

---

## Data layout

Everything that survives a container rebuild lives in the mounted `/data` directory:

```
data/
├── swarm.db                  — SQLite database
├── .encryption_key           — Fernet master key (back this up)
├── company/                  — Company-wide knowledge, skills, triggers
└── workspaces/
    └── <workspace>/
        ├── knowledge/
        ├── skills/
        ├── triggers/         — YAML trigger definitions
        └── swarms/
            └── <swarm>/
                ├── meta.yaml
                ├── hierarchy.json    — topology (source of truth)
                └── agents/           — constitution .md files per agent
```

The GUI writes `hierarchy.json`; you can also edit it directly and the runtime picks up changes live.

---

## Advanced: environment variables

All required settings (LLM provider, API keys) can be configured through the Settings UI. Environment variables are optional overrides — useful for automated deployments or secret managers.

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | — | `anthropic` or `openai` |
| `LLM_MODEL` | — | Model identifier, e.g. `claude-opus-4-7` |
| `ANTHROPIC_API_KEY` | — | Required if provider is `anthropic` |
| `OPENAI_API_KEY` | — | Required if provider is `openai` |
| `SWARM_ENCRYPTION_KEY` | auto-generated | Fernet master key. If unset, generated on first boot and written to `<DATA_DIR>/.encryption_key` |
| `DATABASE_URL` | `sqlite:////data/swarm.db` | SQLAlchemy connection URL |
| `DATA_DIR` | `/data` | Path to the data volume |
| `LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |
| `SCHEDULER_TIMEZONE` | `Europe/Amsterdam` | Timezone for cron triggers |

---

## License

[CC BY-NC 4.0](LICENSE) — free for personal and non-commercial use.
