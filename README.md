<div align="center">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Special+Elite&family=Courier+Prime:wght@400;700&display=swap');
  .sw-wrap { display:flex;align-items:center;justify-content:center;padding:40px 20px;background:#f5f0e8;border-radius:12px;border:1px dashed #c8bfaa;font-family:'Special Elite','Courier New',serif; }
  svg { overflow:visible; }
  .node-ring { animation:pulse 3s ease-in-out infinite;transform-origin:center; }
  .node-ring:nth-child(2){animation-delay:.4s}.node-ring:nth-child(3){animation-delay:.8s}.node-ring:nth-child(4){animation-delay:1.2s}
  @keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}
  .edge-solid{stroke-dasharray:60;stroke-dashoffset:60;animation:drawEdge 1.2s ease forwards}
  .edge-dashed{stroke-dasharray:4 3;stroke-dashoffset:40;animation:drawDash 1.5s ease forwards}
  .e1{animation-delay:.3s}.e2{animation-delay:.5s}.e3{animation-delay:.7s}.e4{animation-delay:.9s}.e5{animation-delay:1.1s}.e6{animation-delay:1.3s}.e7{animation-delay:1.5s}.e8{animation-delay:1.7s}
  @keyframes drawEdge{to{stroke-dashoffset:0}}
  @keyframes drawDash{from{opacity:0;stroke-dashoffset:40}to{opacity:.7;stroke-dashoffset:0}}
  .hex-outer{animation:hexSpin 20s linear infinite;transform-origin:0 0}
  .hex-inner{animation:hexSpin 12s linear infinite reverse;transform-origin:0 0}
  @keyframes hexSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
  .text-swarm{animation:fadeSlideIn .8s ease .2s both}.text-wright{animation:fadeSlideIn .8s ease .5s both}.text-tag{animation:fadeSlideIn .8s ease .9s both}.text-url{animation:fadeSlideIn .6s ease 1.1s both}.divider-line{animation:growLine .6s ease .85s both;transform-origin:left}
  @keyframes fadeSlideIn{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:translateX(0)}}
  @keyframes growLine{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  .satellite{animation:satellitePulse 2.5s ease-in-out infinite}.satellite:nth-child(2){animation-delay:.8s}.satellite:nth-child(3){animation-delay:1.6s}
  @keyframes satellitePulse{0%,100%{opacity:.4}50%{opacity:1}}
  .hex-glow{animation:glowPulse 4s ease-in-out infinite}
  @keyframes glowPulse{0%,100%{opacity:.08}50%{opacity:.18}}
</style>
<div class="sw-wrap">
<svg width="580" height="200" viewBox="0 0 580 200" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(100,100)">
    <polygon class="hex-glow" points="0,-70 60,-35 60,35 0,70 -60,35 -60,-35" fill="#c97c2a"/>
    <polygon class="hex-outer" points="0,-58 50,-29 50,29 0,58 -50,29 -50,-29" fill="none" stroke="#1e3a5f" stroke-width="1" stroke-dasharray="5 4" opacity="0.35"/>
    <polygon points="0,-48 41,-24 41,24 0,48 -41,24 -41,-24" fill="#ede8df" stroke="#1e3a5f" stroke-width="1.5"/>
    <polygon class="hex-inner" points="0,-32 28,-16 28,16 0,32 -28,16 -28,-16" fill="none" stroke="#c97c2a" stroke-width="0.6" stroke-dasharray="3 2" opacity="0.4"/>
    <line class="edge-solid e1" x1="-16" y1="-16" x2="16" y2="-16" stroke="#1e3a5f" stroke-width="1.2"/>
    <line class="edge-solid e2" x1="-16" y1="-16" x2="-20" y2="10" stroke="#1e3a5f" stroke-width="1.2"/>
    <line class="edge-solid e3" x1="16" y1="-16" x2="20" y2="10" stroke="#2a6b6b" stroke-width="1.2"/>
    <line class="edge-dashed e4" x1="-20" y1="10" x2="20" y2="10" stroke="#3d4f7c" stroke-width="0.8"/>
    <line class="edge-dashed e5" x1="-20" y1="10" x2="0" y2="26" stroke="#3d4f7c" stroke-width="0.8"/>
    <line class="edge-dashed e6" x1="20" y1="10" x2="0" y2="26" stroke="#c97c2a" stroke-width="0.8"/>
    <line class="edge-dashed e7" x1="18" y1="-16" x2="36" y2="-38" stroke="#c97c2a" stroke-width="0.7" opacity="0.6"/>
    <line class="edge-dashed e8" x1="-18" y1="-16" x2="-36" y2="-32" stroke="#2a6b6b" stroke-width="0.7" opacity="0.6"/>
    <g><circle class="node-ring" cx="-16" cy="-16" r="8" fill="#1e3a5f"/><text x="-16" y="-12" text-anchor="middle" fill="#f5f0e8" font-size="8" font-family="'Courier New',monospace" font-weight="700">P</text></g>
    <g><circle class="node-ring" cx="16" cy="-16" r="8" fill="#2a6b6b"/><text x="16" y="-12" text-anchor="middle" fill="#f5f0e8" font-size="8" font-family="'Courier New',monospace" font-weight="700">O</text></g>
    <g><circle class="node-ring" cx="-20" cy="10" r="8" fill="#3d4f7c"/><text x="-20" y="14" text-anchor="middle" fill="#f5f0e8" font-size="8" font-family="'Courier New',monospace" font-weight="700">E</text></g>
    <g><circle class="node-ring" cx="20" cy="10" r="8" fill="#c97c2a"/><text x="20" y="14" text-anchor="middle" fill="#f5f0e8" font-size="8" font-family="'Courier New',monospace" font-weight="700">P</text></g>
    <g><circle class="node-ring" cx="0" cy="28" r="6" fill="#1e3a5f" opacity="0.75"/><text x="0" y="32" text-anchor="middle" fill="#f5f0e8" font-size="7" font-family="'Courier New',monospace" font-weight="700">E</text></g>
    <circle class="satellite" cx="38" cy="-40" r="5" fill="none" stroke="#c97c2a" stroke-width="1.3"/>
    <circle class="satellite" cx="-38" cy="-34" r="4" fill="none" stroke="#2a6b6b" stroke-width="1.1"/>
    <circle class="satellite" cx="42" cy="30" r="4" fill="none" stroke="#1e3a5f" stroke-width="1"/>
  </g>
  <text class="text-swarm" x="180" y="95" font-family="'Special Elite','Courier New',serif" font-size="64" fill="#1e3a5f" letter-spacing="-1">Swarm</text>
  <text class="text-wright" x="180" y="158" font-family="'Special Elite','Courier New',serif" font-size="64" fill="#c97c2a" letter-spacing="-1">Wright</text>
  <line class="divider-line" x1="180" y1="170" x2="570" y2="170" stroke="#c8bfaa" stroke-width="0.75"/>
  <text class="text-tag" x="181" y="188" font-family="'Courier New',monospace" font-size="11" fill="#5a5040" letter-spacing="3.5">build the swarm</text>
  <rect class="text-url" x="488" y="174" width="80" height="18" rx="3" fill="#c97c2a"/>
  <text class="text-url" x="528" y="186" text-anchor="middle" font-family="'Courier New',monospace" font-size="9" fill="#f5f0e8" letter-spacing="0.5" font-weight="700">v0.3</text>
</svg>
</div>
</div>

# SwarmWright

A self-hosted multi-agent orchestration platform. Build teams of AI agents that handle administrative and interpretive work — governed by a strict topology where every connection is declared, every action is auditable.

Agents don't call each other freely. You define who talks to whom, what triggers a run, and what requires human sign-off. SwarmWright enforces it.

---

## Quick start

```bash
docker run -d \
  --network=host \
  --name swarmwright \
  -v ./data:/data \
  -e LLM_PROVIDER=anthropic \
  -e LLM_MODEL=claude-opus-4-7 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  ralphbarendse/swarmwright:latest
```

Then open `http://localhost:5001`.

Or with Docker Compose — copy `docker/docker-compose.yml` and a `.env` (see `.env.example`):

```bash
cp .env.example .env
# Fill in LLM_PROVIDER, LLM_MODEL, and your API key
docker compose -f docker/docker-compose.yml up -d
```

---

## What it does

You build **swarms** — named groups of agents, each with a written constitution describing their role, tools, and behaviour. Swarms live inside **workspaces** (think departments). A company-wide layer sits above everything.

A run starts when an event fires — on a schedule, via webhook, or manually. The runtime walks the declared topology, calls each agent in turn, logs every step, and surfaces anything that needs a human decision to the Inbox.

The GUI covers the full lifecycle:

- **Org** — manage workspaces and swarms
- **Swarm canvas** — drag-and-drop agent topology editor
- **Constitution editor** — write agent roles in plain Markdown with a live preview
- **Control Room** — monitor active and historical runs per swarm, fire events manually, pause swarms
- **Inbox** — human-in-the-loop approvals and escalations
- **Library** — manage knowledge documents, skills, and triggers across scopes
- **Settings** — LLM provider, model, branding, API keys stored encrypted at rest

---

## Features

- Topology-enforced agent graphs — agents can only call or inform peers you explicitly wire up
- Three-scope resource resolver: swarm → workspace → company, unqualified references auto-resolve
- Scheduled and webhook triggers with cron expressions
- Full run trace with per-step input/output logging
- Human-in-the-loop escalation with inbox approvals
- Encrypted secret storage (Fernet, key auto-generated on first boot)
- File-backed configuration — workspaces, agents, and constitutions are plain files you can version
- Single Docker container, SQLite by default, no external dependencies

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_PROVIDER` | Yes | `anthropic` | `anthropic` or `openai` |
| `LLM_MODEL` | Yes | `claude-opus-4-7` | Model identifier |
| `ANTHROPIC_API_KEY` | If provider=anthropic | — | Anthropic API key |
| `OPENAI_API_KEY` | If provider=openai | — | OpenAI API key |
| `SWARM_ENCRYPTION_KEY` | No | auto-generated | Fernet master key. If unset, generated on first boot and written to `<DATA_DIR>/.encryption_key`. Back this file up alongside `swarm.db`. |
| `DATABASE_URL` | No | `sqlite:////data/swarm.db` | SQLAlchemy connection URL |
| `DATA_DIR` | No | `/data` | Path to the data volume |
| `LOG_LEVEL` | No | `INFO` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |
| `SCHEDULER_TIMEZONE` | No | `Europe/Amsterdam` | Timezone for cron triggers |

---

## Data volume

Everything that survives a container rebuild lives in the mounted `/data` directory:

```
data/
├── swarm.db                  — SQLite database
├── .encryption_key           — Master key (back this up)
├── company/                  — Company-wide knowledge, skills, perceptionists
└── workspaces/
    └── <workspace>/
        ├── knowledge/
        ├── skills/
        └── swarms/
            └── <swarm>/
                ├── meta.yaml
                ├── hierarchy.json    — topology definition
                └── agents/           — constitution .md files
```

The `hierarchy.json` file is the source of truth for a swarm's topology. The GUI writes it; you can also edit it directly and the runtime picks up changes live.
