# Phase 2 — Building Modules

> Goal: turn the empty skeleton into a working swarm. Agents register from disk. Skills execute in subprocesses. Knowledge documents inject into prompts. Triggers wake the system. Crucially: **`hierarchy.json` is enforced at runtime** — no agent can call anything not declared in its swarm's topology.

---

## What "done" looks like for Phase 2

You drop a `.md` constitution in a swarm's `agents/` folder. The swarm picks it up. You edit `hierarchy.json` to declare it as a node and wire its edges. You drop a `.py` skill. You add a knowledge document. You POST an event to the swarm and watch it flow through the declared topology, with every step recording which `hierarchy.json` edge authorized it. If an agent tries to escape its declared topology, the runtime refuses and logs the violation.

---

## Phase 2 has five modules, built in this order

1. **Hierarchy** — the registry walks the data tree, parses `hierarchy.json`, validates everything
2. **Agents and the topology runtime** — agents run, but only along declared edges
3. **Skills** — sandboxed Python execution, callable from agents per the topology
4. **Knowledge** — scoped reference documents injected into prompts
5. **Triggers** — heartbeats, listeners, invocations as deterministic scripts

Each one is demoable on its own. The hierarchy module on its own already justifies the project — it's the part that delivers the architectural promise.

---

## Module 1: Hierarchy (registry, validation, the topology rules)

### What gets registered, and from where

The registry walks the data tree on boot and on filesystem changes. For each scope it finds, it processes:

| Path pattern | What lives there | What gets registered |
|---|---|---|
| `data/company/perceptionists/*.md` | Company-wide perceptionists | Rows in `agents` with `scope=company` |
| `data/company/skills/*.{py,yaml}` | Company-wide skills | Indexed in memory |
| `data/company/knowledge/*.md` | Company-wide knowledge | Rows in `knowledge_documents` with `scope=company` |
| `data/workspaces/<wid>/perceptionists/*.md` | Workspace perceptionists | Rows in `agents` with `scope=workspace` |
| `data/workspaces/<wid>/skills/*.{py,yaml}` | Workspace skills | Indexed in memory |
| `data/workspaces/<wid>/knowledge/*.md` | Workspace knowledge | Rows in `knowledge_documents` with `scope=workspace` |
| `data/workspaces/<wid>/swarms/<sid>/agents/*.md` | Swarm agents (any layer) | Rows in `agents` with `scope=swarm` |
| `data/workspaces/<wid>/swarms/<sid>/skills/*.{py,yaml}` | Swarm skills | Indexed in memory |
| `data/workspaces/<wid>/swarms/<sid>/knowledge/*.md` | Swarm knowledge | Rows in `knowledge_documents` with `scope=swarm` |
| `data/workspaces/<wid>/swarms/<sid>/triggers/*.yaml` | Trigger configs | Rows in `triggers` |
| `data/workspaces/<wid>/swarms/<sid>/hierarchy.json` | Topology | Validated and held in memory per swarm |

The registry uses file watching (the `watchdog` library) so changes are picked up within seconds without restart.

### Constitution file format

Every agent `.md` file has YAML frontmatter for machine-readable identity, then markdown for the constitution.

```markdown
---
name: invoice-orchestrator
layer: orchestrator
model: claude-opus-4-7
knowledge:
  - finance-procedures
  - approval-thresholds
---

You are the Invoice Intake Orchestrator.

You receive normalized email events containing invoices...
```

Frontmatter is **identity**, not connectivity. Notice what's *not* here:

- No `skills` list
- No `perceptionists` list
- No declarations of who this agent talks to

Those are **swarm-level wiring decisions**, not agent identity. They live in `hierarchy.json`. This separation lets the same constitution be reused across swarms with different topologies.

The `knowledge` field stays in the constitution because knowledge is genuinely about the agent's nature — it shapes what the agent thinks and how it reasons. Knowledge belongs to identity.

### `hierarchy.json` format

Each swarm has exactly one. It's the authoritative document for that swarm's topology.

```json
{
  "swarm": "invoice-intake",
  "agents": [
    "invoice-orchestrator",
    "approval-policy",
    "erp-booking-executioner",
    "email-notification-executioner"
  ],
  "edges": [
    {
      "from": "invoice-orchestrator",
      "to": "approval-policy",
      "kind": "escalate",
      "purpose": "Check authorization rules before booking"
    },
    {
      "from": "invoice-orchestrator",
      "to": "erp-booking-executioner",
      "kind": "delegate",
      "purpose": "Book the validated invoice into ERP"
    },
    {
      "from": "erp-booking-executioner",
      "to": "invoice-orchestrator",
      "kind": "report",
      "purpose": "Return booking confirmation or error"
    }
  ],
  "consultations": [
    {
      "agent": "invoice-orchestrator",
      "perceptionist": "company/erp-lookup",
      "purpose": "Resolve supplier name to internal ID"
    },
    {
      "agent": "approval-policy",
      "perceptionist": "workspace/cost-center-router",
      "purpose": "Determine cost center for threshold lookup"
    }
  ],
  "skills": [
    {
      "agent": "erp-booking-executioner",
      "skill": "post-to-erp",
      "purpose": "Write the booking record"
    },
    {
      "agent": "email-notification-executioner",
      "skill": "company/send-email",
      "purpose": "Notify the requester"
    }
  ]
}
```

Three lists: `edges` (agent-to-agent), `consultations` (agent-to-perceptionist), `skills` (agent-to-skill). Each entry has a `purpose` that captures *why* this connection exists.

**Edge kinds** carry meaning:

- `escalate` — asking upward for guidance (Orchestrator → Policy)
- `delegate` — assigning work downward (Orchestrator → Executioner)
- `report` — returning results upward (Executioner → Orchestrator)

The runtime uses these kinds to enforce flow direction and to set defaults — for example, an `escalate` edge expects a return path; the validator warns if there isn't one.

### Validation at registration time

When a swarm is registered or its `hierarchy.json` is edited, the validator runs every check. Any failure marks the swarm `enabled=false` and surfaces a structured error in the API:

- Every name in `agents` resolves to an existing constitution in `data/.../<this-swarm>/agents/`
- Every `from` and `to` in `edges` is in the swarm's `agents` list
- Every `agent` in `consultations` is in the swarm's `agents` list
- Every `perceptionist` in `consultations` resolves through the scope chain (qualified or unqualified)
- Every `agent` in `skills` is in the swarm's `agents` list
- Every `skill` in `skills` resolves through the scope chain
- No duplicate edges (same from/to/kind combo)
- All purpose strings are non-empty

A swarm with a broken `hierarchy.json` doesn't run. It also doesn't crash the system — the rest of the swarms continue normally. This isolation is important.

### Why constitutions hold knowledge but not skills/perceptionists

The asymmetry is deliberate and worth defending:

- **Knowledge** changes how the agent *thinks* — it's part of the agent's identity. The same orchestrator with different knowledge is a different agent.
- **Skills** and **perceptionists** are *connections to the outside* — they're about what work the swarm wires up. The same orchestrator can use different skills in different swarms while still being the same agent.

If you ever want to override knowledge per-swarm, you can — by giving the swarm its own copy of the constitution under the swarm's `agents/` folder, with a different knowledge list. The constitution's identity is its content, not its name.

---

## Module 2: Agents and the topology runtime

### What an agent is at runtime

A small Python object that wraps:

- The constitution (loaded from `.md`, frontmatter parsed, body cached)
- Resolved knowledge documents (full text, ready to inject)
- Its swarm context (which swarm it belongs to, which `hierarchy.json` governs it)
- The LLM client
- The agent has one method: `act(event, context) -> result`

`act` builds the system prompt (constitution body + knowledge documents + topology context — the agent is told what it can call and for what purpose), builds the user prompt from the event and context, calls the LLM, parses the response, and returns a structured action.

### The topology context in the system prompt

Critically, the agent's prompt includes its allowed actions, derived from `hierarchy.json`:

```
You are the Invoice Intake Orchestrator.

[constitution body]

# Reference Documents
[finance-procedures.md content]
[approval-thresholds.md content]

# Allowed actions

You may escalate to:
- approval-policy — to check authorization rules before booking

You may delegate to:
- erp-booking-executioner — to book the validated invoice into ERP
- email-notification-executioner — to send the requester a notification

You may consult perceptionists:
- company/erp-lookup — to resolve supplier name to internal ID

When you respond, return a JSON object with one of these action types: ...
```

The topology *is the agent's situational awareness.* It knows what's possible and why. This is what makes purpose-strings carry their weight — they're not documentation, they're the orchestrator's actual reasoning material.

### The Orchestrator's response shape

Orchestrators must return JSON in this schema:

```json
{
  "action": "consult_perceptionist | escalate | delegate | escalate_to_human | complete",
  "target": "name-of-the-thing-being-called",
  "purpose_match": "Resolve supplier name to internal ID",
  "input": { ... },
  "reasoning": "free-text explanation"
}
```

The runtime parses, then **validates against `hierarchy.json`**:

1. Is there a declared edge/consultation/skill connection from this agent to `target`?
2. Does `purpose_match` correspond to a declared purpose for that connection?
3. Is `action` consistent with the connection kind (e.g., `escalate` action requires an edge with `kind=escalate`)?

Any failure: the runtime rejects the action, logs a `topology_violation`, and either retries with a corrective prompt or fails the run depending on configuration.

This is the strict-mode enforcement promised earlier. **An agent cannot escape its declared topology.** Constitutions describe how agents *think*; `hierarchy.json` decides what they're *allowed to do*.

### Run steps and the audit trail

Every action becomes a row in `run_steps`. The `edge_purpose` column records the matched purpose string from `hierarchy.json`. This means the audit trail is not just "who called whom" but "who called whom *and which declared edge in the topology authorized it.*"

Two days after a run, you can answer: "show me every step where the orchestrator escalated to policy *to check authorization*." The purpose strings make the audit semantically rich.

---

## Module 3: Skills (Python script execution)

### What a skill is

A `.py` file in any scope's `skills/` folder, with a sibling `.yaml` declaring its schema and limits.

```python
def run(input: dict, context: dict) -> dict:
    """
    input: structured input (validated against input_schema)
    context: read-only metadata (run_id, agent_name, knowledge_dir, scope)
    returns: a JSON-serializable dict (validated against output_schema)
    """
    ...
```

```yaml
name: post-to-erp
description: Post a booking record to the ERP system
input_schema:
  type: object
  required: [supplier_id, amount, currency, cost_center]
  properties:
    supplier_id: { type: string }
    amount: { type: number }
    currency: { type: string }
    cost_center: { type: string }
output_schema:
  type: object
  properties:
    booking_id: { type: string }
    status: { type: string }
timeout_seconds: 30
allowed_packages:
  - requests
```

### The execution sandbox

Skills run in a **subprocess with timeout**, not in the Flask process.

The subprocess is launched with:
- A clean Python interpreter
- An isolated working directory (a temp dir per invocation, cleaned after)
- Stdin closed
- Memory limit (`resource.setrlimit` on Linux)
- Hard timeout (configured per-skill, default 30s)
- stdout/stderr captured

Input is passed as JSON on argv. Output is read from stdout. The skill prints exactly one JSON object and exits 0 on success, or prints an error JSON and exits non-zero on failure.

Allowed packages are enforced via static analysis at registration time (parse imports, check against allowlist). Skills declaring a disallowed package fail registration.

### How agents invoke skills

An agent (typically an Executioner) requests a skill call as part of its action JSON:

```json
{
  "action": "skill_call",
  "target": "post-to-erp",
  "purpose_match": "Write the booking record",
  "input": { "supplier_id": "S-1234", "amount": 1500, ... }
}
```

Runtime checks: is there an entry in `hierarchy.json`'s `skills` list with this agent and this skill, and does `purpose_match` align? If yes, resolve the skill through the scope chain, run it in the sandbox, validate output, write a `skill_call` row to `run_steps`, return the result to the agent for interpretation.

This is the seam between deterministic and interpretive: **the skill produces structured data, the agent interprets and acts on it.**

---

## Module 4: Knowledge

### What it is

Markdown files at any of the three scopes. Plain markdown. Optionally a `# Title` line at the top.

```markdown
# Approval Thresholds by Cost Center

Cost center 4500 (Marketing): up to €2,500 auto-approves.
Cost center 4600 (IT): up to €5,000 auto-approves.
...
```

### How agents reference and use knowledge

In the constitution frontmatter:

```yaml
knowledge:
  - approval-thresholds          # local — search swarm → workspace → company
  - workspace/finance-procedures  # explicitly workspace-scoped
  - company/glossary              # explicitly company-wide
```

When the agent runs, the runtime resolves each reference through the scope chain, loads the file, and prepends the content to the system prompt under `# Reference Documents`. The agent sees the full text and reasons over it directly.

This is **not RAG.** No embeddings, no vector store, no chunking. Reference docs are small and manageable as raw text. When the corpus grows past what fits comfortably in prompts, that's when you add semantic retrieval — but defer that until you have evidence you need it.

### Knowledge document scanner

On boot and on file changes, scan `data/company/knowledge/`, `data/workspaces/*/knowledge/`, and `data/workspaces/*/swarms/*/knowledge/`. For each file: extract title from first heading, compute hash, upsert into `knowledge_documents`. The scanner is in `app/core/registry.py` alongside the rest of the registration logic.

---

## Module 5: Triggers (scripts, not agents)

### Heartbeat

- Stored in `triggers` with `kind=heartbeat` and a swarm_id
- Config: cron expression, path to `.py` script (relative to swarm), watermark storage key
- APScheduler reads enabled heartbeats at startup, registers them
- On fire: subprocess executes the script, receives current watermark via stdin, writes new watermark + zero-or-more events to stdout
- Each event is published to the event bus targeted at this swarm, exactly as if it came from the API

Heartbeat scripts live in `data/workspaces/<wid>/swarms/<sid>/triggers/<name>.py` with a sibling `.yaml` for the cron expression and timeout.

### Listener

- Stored with `kind=listener` and a swarm_id
- Config: endpoint path suffix, shared secret, optional JSON path filter
- Flask registers `POST /api/v1/triggers/listener/<suffix>` dynamically on boot
- On request: validates auth header, validates payload against filter, publishes resulting event(s) targeted at the listener's swarm
- Deduplication via in-memory LRU keyed by `payload.event_id` (24h TTL)

### Invocation

- Stored with `kind=invocation` and a swarm_id
- Config: form schema, permission rule (Phase 2 has no auth so this is permissive)
- Flask registers `POST /api/v1/triggers/invocation/<id>` for each enabled invocation
- The Phase 3 GUI generates a form from the schema and POSTs the result
- The event includes `source: invocation` and `invoked_by: <user_id>` in the payload

### The seam between triggers and the swarm

Every trigger ends the same way: **`event_bus.publish(event)`** with a `swarm_id` field. The Orchestrator that consumes the event has no idea which trigger produced it. The trigger absorbs the messiness of the outside world; the swarm sees a clean event.

### Watermark storage

Heartbeats own their watermarks. Stored in `triggers.watermark` as opaque text. Read before each tick, passed to the script, persisted atomically with the events the script produced.

---

## A walked-through example

To make the pieces concrete: an invoice arrives at Finance@hollander.nl.

1. **Trigger fires.** A heartbeat in the `invoice-intake` swarm polls the mailbox, finds a new email, publishes an event with `source: heartbeat` and the email payload to that swarm.

2. **Run starts.** A `runs` row appears with `swarm_id = invoice-intake`, status `running`. The Orchestrator declared as the swarm's entry point picks up the event.

3. **Orchestrator acts.** It loads its constitution, its knowledge docs (`finance-procedures`, `approval-thresholds`), and its allowed actions from `hierarchy.json`. It returns: `consult_perceptionist`, target `company/erp-lookup`, purpose_match "Resolve supplier name to internal ID".

4. **Runtime validates.** Yes, `hierarchy.json` declares this consultation. Yes, the purpose matches. The perceptionist runs, returns `{ supplier_id: "S-1234" }`. A `run_steps` row is written with `edge_purpose = "Resolve supplier name to internal ID"`.

5. **Orchestrator continues.** Now with supplier_id in hand, it returns: `escalate`, target `approval-policy`, purpose_match "Check authorization rules before booking".

6. **Runtime validates and dispatches.** The Policy agent runs, consults its own perceptionist for cost center, returns "approved". Another `run_steps` row.

7. **Orchestrator delegates.** `delegate`, target `erp-booking-executioner`, purpose_match "Book the validated invoice into ERP".

8. **Executioner runs.** It calls its declared skill `post-to-erp`. The skill subprocess runs, returns `{ booking_id: "B-9876", status: "success" }`. The Executioner interprets, returns its result to the Orchestrator.

9. **Orchestrator delegates again.** `delegate`, target `email-notification-executioner`, purpose_match "Send the requester a notification".

10. **Executioner sends.** Calls `company/send-email` skill. Email goes out.

11. **Orchestrator returns** `complete`. The run is marked `completed`. Total: 7 `run_steps` rows, each tagged with which `hierarchy.json` edge authorized it.

If at step 3 the Orchestrator had asked to consult a perceptionist not declared in `consultations`, the runtime would have refused. The agent could only do what its swarm's topology permitted.

---

## Build order within Phase 2

1. **Hierarchy module first** — registry, validation, file watching, the `hierarchy.json` parser. No agents running yet, but you can see swarms being detected and validated. Errors surface clearly in the API.

2. **One Orchestrator running** — pick the simplest case, get the topology context into the prompt, get JSON action parsing working, get hierarchy validation enforcing it. Prove an Orchestrator can return `complete` with no actions.

3. **Add a Perceptionist consultation** — the Orchestrator now consults a real perceptionist. Prove the scope resolution works.

4. **Add a Policy escalation and an Executioner delegation** — multi-agent flow. Watch the run_steps table fill in correctly.

5. **Skills** — pick one real skill, get it running in the subprocess sandbox, called from an Executioner per the topology.

6. **Knowledge** — add knowledge documents at multiple scopes, prove they appear in agent prompts correctly resolved.

7. **Triggers** — heartbeat first, then invocation, then listener.

By the end of step 4 you have a working swarm. Steps 5–7 add the rest of the surface area.

---

## What Phase 2 deliberately does NOT include

- Any GUI (that's Phase 3)
- Authentication or user accounts
- Multi-step long-running flows that span days
- Vector search / RAG knowledge
- Real container-level skill isolation
- Live run streaming via SSE/websockets (Phase 3)
- Cross-swarm flows (one swarm triggering another)
- Lax-mode topology (always strict)

---

## Acceptance checklist

- [ ] An agent `.md` file dropped in a swarm's `agents/` folder is registered within 10 seconds
- [ ] An invalid agent constitution fails registration with a clear error
- [ ] An invalid `hierarchy.json` (broken references, duplicate edges, missing purposes) marks the swarm `enabled=false` with a structured error
- [ ] A reference resolves correctly through swarm → workspace → company chain
- [ ] An agent attempting an action not declared in `hierarchy.json` is refused, and a `topology_violation` is logged
- [ ] One full event flows Orchestrator → Perceptionist → Policy → Executioner with skill call, end-to-end
- [ ] `/api/v1/runs/<id>` returns a complete audit trail with `edge_purpose` set on every step
- [ ] A skill that exceeds its timeout is killed and the run is marked failed
- [ ] A heartbeat trigger configured with `*/5 * * * *` actually fires every 5 minutes
- [ ] A listener trigger receives a webhook and produces an event
- [ ] An invocation can be POSTed and produces an event with the invoker recorded
- [ ] An agent referencing a non-existent knowledge document fails registration cleanly
- [ ] A knowledge document edit is reflected on the next agent invocation (no restart needed)
- [ ] Same constitution reused across two swarms with different topologies behaves correctly in each
