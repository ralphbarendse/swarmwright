# Phase 6 — Human in the loop

> Goal: agents and humans share the work, and the human's role is declared in the topology rather than improvised at runtime. Two new node types exist: a **Caller** (blocks the run until the human decides yes/no) and an **Informer** (fire-and-forget notification, run continues). Pending calls pile up in an **Inbox**; humans say yes or no with an optional amend, and the run resumes. Inform notifications land in a separate non-blocking queue.

---

## What "done" looks like for Phase 6

You design a swarm in the canvas. Most of it is the same agents you already had — but now you can drag a sage-green **Caller** node onto the canvas, name it `finance-approver`, and connect agents to it the same way you connect them to perceptionists or skills. Each connection has a purpose string ("Approve payments over €10k").

A run hits a `call` edge. Instead of the agent calling an LLM and inventing an answer, the run **pauses** with status `awaiting_human`. A new card lands in your **Inbox** tab in the topbar, with a subtle amber pip showing the count. The card shows the asking agent, the run context, the purpose, the proposed payload, and two buttons: **Yes**, **No**. An optional **Amend** field is available alongside either decision to pass a modified payload back to the agent.

You click Yes. Within a heartbeat the run resumes from the exact step it paused on, the agent receives the original payload (plus your amend if supplied, plus your reason if supplied) as the call's result, and the rest of the run plays out. Every action — including yours — is recorded in `run_steps` with `caller_id` and your decision. An auditor reading the trail months later sees exactly *who* decided *what*, *when*, and *why*.

A run hitting an `inform` edge behaves differently: no pause, no decision. An **Inform** card lands in the separate non-blocking queue. The agent has already continued; the human reads or dismisses the notification at their own pace.

If you walk away without responding, nothing breaks. The run sits in `awaiting_human` until you (or the SLA escalation that ships in a later phase) handles it.

---

## Why human-in-the-loop deserves its own phase

It's tempting to dispatch this as "an `escalate_to_human` action exists, ship a UI on top." That gets you a pop-up modal and not much more. Three reasons we treat it as a phase:

**Humans belong in the topology, not in agent prompts.** Today an agent decides at runtime whether to escalate, based on whatever instructions its constitution carries. That makes the human dependency invisible to anyone reading `hierarchy.json` — exactly the audit surface SwarmWright was built to expose. Caller nodes fix this: every place a human is required is declared in the swarm structure, with an edge purpose explaining *why*.

**Approvals fan in.** Five different agents may all need approval from the same finance reviewer. Modeling that as five separate "escalate" actions duplicates the human-routing rule across constitutions. Modeling it as five edges into one Caller node centralises the rule and makes "who watches the money" a single point of change.

**Pause/resume is a runtime concept.** Phase 1's runtime walks an agent loop top-to-bottom. Adding a state where a run can sleep arbitrarily long and resume mid-graph touches storage (the run snapshot), the event bus (the resume signal), and the UI (live state on a paused run). That's not a one-line change.

---

## Three new concepts

### 1. Callers — a fifth node type (blocking)

Up to now the canvas has four agent layers (policy, orchestrator, executioner, perceptionist) plus skills and triggers. Phase 6 adds **Callers**: nodes that represent a human role that *blocks* the run until they decide. Like agents and skills, Callers live on disk as `.md` files and are scope-aware (company / workspace / swarm).

A Caller is *not* an agent — it makes no LLM call, has no constitution prompt, has no model choice. The body of its `.md` file is read-only context that surfaces in the inbox so the human knows what they were called for. Same identity-vs-composition rule: the file says *who this human role is*; `hierarchy.json` says *who calls them, for what*.

Decisions are **yes** or **no**. Both can carry an optional **amend** — a JSON value the human provides alongside the decision. Amend on yes means "proceed with this corrected payload." Amend on no means "here's what would have made me say yes." The agent sees the original payload, the amend (if any), and the reason (if any) — always keeping original and amendment distinct in the audit trail.

### 2. Informers — a sixth node type (non-blocking)

**Informers** are a human role that receives *notifications* rather than approval requests. When an agent traverses an `inform` edge, a card is written to the inform queue and the run continues immediately — no suspension. Informers live in `data/<scope>/informers/<name>.md` with the same scope chain and file format as Callers (minus the approval-specific fields like `timeout_action` and `fallback`).

Inform cards have three states: `unread`, `read`, `dismissed`. No decision buttons — just acknowledgment.

### 3. The Inbox

A new top-bar tab. **Call cards** stack newest-first, each linking back to the paused run. **Inform cards** appear in a separate non-blocking section. SSE pushes new cards live for both types. A small amber pip on the topbar tab shows the unanswered count (calls only — informs use a separate unread count).

---

## Caller files on disk

Same location pattern as knowledge / skills / perceptionists:

```
data/company/callers/<name>.md
data/workspaces/<wid>/callers/<name>.md
data/workspaces/<wid>/swarms/<sid>/callers/<name>.md
```

## Informer files on disk

```
data/company/informers/<name>.md
data/workspaces/<wid>/informers/<name>.md
data/workspaces/<wid>/swarms/<sid>/informers/<name>.md
```

Same resolution order (most-local-first) and same file format as Callers, minus `timeout_action`, `escalation_after_seconds`, and `fallback` (those are approval concepts, not notification concepts).

Resolved most-local-first via the existing scope chain. References in `hierarchy.json` can be unqualified or qualified (`workspace/finance-approver`, `company/legal-reviewer`).

### File format

```markdown
---
name: finance-approver
display_name: Finance approver
contacts:
  - marija@example.com
  - bram@example.com
escalation_after_seconds: 14400      # 4h — Phase 6 stores this; SLA timer is later
fallback: finance-approver-overflow  # name of another caller; optional
timeout_action: defer                # defer | reject | approve (default: defer)
---
You are reviewing payments and supplier-lifecycle decisions on behalf of the
Finance team. Approve payments only when the supplier is verified and the
amount is within the operator-confirmed budget. Reject anything that lacks a
matching purchase order. When in doubt, edit the payload to add a comment and
re-route via fallback.
```

**Frontmatter is identity, body is context.** The body markdown is shown verbatim in the inbox card alongside whatever payload the agent supplied. It's the human's "what is being asked of me" briefing.

### Validation

A Caller passes registry validation when:
- `name` matches the filename slug (kebab-case, lowercase)
- `display_name` is non-empty
- `contacts` is a non-empty list (Phase 6 stores them; auth wires up later)
- `escalation_after_seconds` is a positive integer if present
- `timeout_action` is one of `defer | reject | approve` if present
- `fallback`, when present, resolves to another Caller via the scope chain

Bad Callers mark their swarm `enabled=false` with a structured error, same convention as bad agents.

---

## The `calls` array in `hierarchy.json`

A new top-level array, alongside `edges`, `consultations`, and `skills`:

```json
{
  "swarm": "invoice-intake",
  "agents": ["coordinator", "validator", "supplier-onboarder"],
  "edges": [
    { "from": "coordinator", "to": "validator", "kind": "delegate", "purpose": "Validate invoice fields" },
    { "from": "validator", "to": "coordinator", "kind": "report", "purpose": "Return validation result" }
  ],
  "consultations": [
    { "agent": "validator", "perceptionist": "erp-lookup", "purpose": "Resolve supplier id" }
  ],
  "skills": [
    { "agent": "validator", "skill": "send-email", "purpose": "Notify finance on rejection" }
  ],
  "calls": [
    { "agent": "validator", "caller": "finance-approver",
      "purpose": "Approve payments over €10,000 before sending" },
    { "agent": "supplier-onboarder", "caller": "finance-approver",
      "purpose": "Approve new supplier additions" }
  ],
  "informs": [
    { "agent": "validator", "informer": "finance-team",
      "purpose": "Notify when payment processed" }
  ],
  "entry_point": "coordinator"
}
```

Required fields per `calls` entry: `agent`, `caller`, `purpose` (non-empty). Required fields per `informs` entry: `agent`, `informer`, `purpose` (non-empty). The validator enforces all fields for both arrays, same way it enforces edge purposes today.

The audit trail extends naturally. A `run_steps` row produced by traversing a `call` edge has:
- `kind = "call"`
- `edge_purpose = "Approve payments over €10,000 before sending"` (verbatim from `hierarchy.json`)
- a new column `caller_id` pointing at the Caller's row in the registry
- `output_json` containing the human's decision payload (only after the human responds)

This means a compliance officer can grep run_steps for `kind = 'call'` and see every human decision the system has ever made, with the question and answer side-by-side.

---

## Database schema

Phase 6 adds two tables and one column. Phase 6.1 adds two more tables and two columns.

### `callers` (registry index, like `agents`)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| swarm_id | text fk nullable | populated for swarm-scope callers |
| workspace_id | text fk nullable | populated for workspace-scope callers |
| scope | text | `company` / `workspace` / `swarm` |
| name | text | filename slug |
| display_name | text | |
| md_path | text | absolute path on disk |
| md_hash | text | sha256 for change detection |
| enabled | bool | |
| created_at, updated_at | timestamp | |

Uniqueness `(scope, workspace_id, swarm_id, name)`, mirroring the `knowledge_documents` constraint.

### `informers` (registry index, same shape as `callers`)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| swarm_id | text fk nullable | |
| workspace_id | text fk nullable | |
| scope | text | `company` / `workspace` / `swarm` |
| name | text | filename slug |
| display_name | text | |
| md_path | text | |
| md_hash | text | |
| enabled | bool | |
| created_at, updated_at | timestamp | |

### `human_actions` (the blocking-call queue + decision log)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| run_id | text fk | the run this action paused |
| step_id | text fk | the run_step row that emitted the call |
| caller_id | text fk | which caller was asked |
| purpose | text | the edge purpose (denormalised for fast reads) |
| payload_json | text | what the agent proposed |
| runtime_snapshot_json | text | internal: messages + agent name to resume |
| status | text | `pending` / `yes` / `no` / `expired` |
| amend_json | text nullable | optional human amendment to the payload |
| decision_reason | text nullable | optional human-supplied note |
| decided_by | text nullable | actor identifier; null until auth lands |
| decided_at | timestamp nullable | |
| created_at | timestamp | |

Decision values are `yes` / `no`. The agent receives `{decision, payload, amend?, reason?}` — original and amendment are always distinct.

### `human_informs` (non-blocking notification queue)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| run_id | text fk | the run that fired the notification |
| step_id | text fk | the run_step row that emitted the inform |
| informer_id | text fk | which informer was notified |
| purpose | text | the edge purpose |
| payload_json | text | what the agent sent |
| status | text | `unread` / `read` / `dismissed` |
| read_by | text nullable | |
| read_at | timestamp nullable | |
| created_at | timestamp | |

No runtime snapshot — the run never paused.

### `runs.status` — new value

`awaiting_human` joins the existing set (`running`, `complete`, `failed`, `topology_violation`). The runtime moves a run there when it pauses on a `call` edge, and back to `running` when the human decides. `inform` edges never change run status.

---

## Runtime intercept on `call` edges

Today's runtime walks an agent loop, dispatches sub-actions, and records steps. Phase 6 hooks one new branch in `_dispatch_sub_action`:

1. Agent emits `consult_caller` with target `<caller_name>` and a payload.
2. Runtime resolves the caller via the registry, validates the edge against `hierarchy.json` (strict topology rule still applies — agents can't call any caller they aren't connected to).
3. Runtime persists a `human_actions` row with `status='pending'`, captures the run state into a snapshot, and updates `runs.status = 'awaiting_human'`.
4. SSE channel broadcasts `human_action.pending` so any open Inbox tab adds the card live.
5. The agent loop **suspends**. The runtime function returns; the worker is freed.
6. When the inbox API receives a decision, it writes to the `human_actions` row, marks the run resumable, and **enqueues a resume event** on the existing event bus.
7. The bus dispatches the resume event to a runtime entry point that loads the snapshot, injects the decision payload as the call's "result," and continues the agent loop from the next turn.

**Suspension is a real pause, not a busy-wait.** No background thread polls. The run is dormant in the database until SSE-driven UI or API call wakes it. This keeps the single-process design honest — the inbox holds the state, the runtime is stateless.

---

## API endpoints

All under `/api/v1`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/inbox` | List pending `human_actions`. Filters: `caller_name`, `status`, `swarm_id`, `limit`, `offset` |
| `GET` | `/inbox/<id>` | One inbox item with full payload + run-step context |
| `POST` | `/inbox/<id>/decide` | Body: `{ decision: "yes"\|"no", amend?, reason?, actor? }`. Resumes the run. |
| `GET` | `/informs` | List `human_informs`. Filters: `informer_name`, `status`, `swarm_id`, `limit`, `offset` |
| `GET` | `/informs/<id>` | One inform card with payload + run context |
| `POST` | `/informs/<id>/read` | Mark inform as read. Body: `{ actor? }` |
| `POST` | `/informs/<id>/dismiss` | Dismiss inform. Body: `{ actor? }` |
| `GET` | `/callers` | List callers; filters by scope (same shape as `/skills`) |
| `GET` | `/callers/<name>` | One caller's metadata + body |
| `POST` | `/callers` | Create a new caller (writes the `.md` file) |
| `PUT` | `/callers/<name>` | Update body or frontmatter |
| `DELETE` | `/callers/<name>` | Delete the file (rejected if any swarm hierarchy still references it) |
| `GET` | `/informers` | List informers; filters by scope |
| `GET` | `/informers/<name>` | One informer's metadata + body |
| `POST` | `/informers` | Create a new informer (writes the `.md` file) |
| `PUT` | `/informers/<name>` | Update body or frontmatter |
| `DELETE` | `/informers/<name>` | Delete the file (rejected if any swarm hierarchy still references it) |

The inbox endpoints reuse the existing SSE bus (`/api/v1/stream`) — same channel that already streams `run.step` events. New event types: `human_action.pending`, `human_action.resolved`.

---

## GUI changes

### New Inbox tab in the topbar

Sixth top-bar entry, after Settings: `Inbox · 3`. The numeric pip ticks down as items are resolved. Click to open the inbox view.

### Inbox view

Two-column layout:
- **Left**: scrollable list of cards, newest first. Tabs separate **Calls** (blocking decisions) from **Informs** (non-blocking notifications). Each call card shows caller display name, asking agent / swarm, purpose, and age. Each inform card shows the same minus any action buttons.
- **Right**: detail pane for the selected card.
  - **Call card**: shows the caller's body markdown (the "briefing"), the proposed payload as a CodeMirror JSON view, two large buttons (**Yes**, **No**), an optional **Amend** JSON field (available on both), and a reason text-area. The amend field is collapsed by default and expands on click.
  - **Inform card**: shows the informer's body markdown, the payload, and two small buttons: **Read**, **Dismiss**.

Filter controls at the top of the list: by Caller/Informer, by status, by swarm.

A "Show resolved" toggle lets operators see their own historical decisions and read informs.

### Swarm canvas — Caller node rendering

Distinct from agents:
- **Shape**: speech-bubble (`tag` shape) — implies "ask"
- **Colour**: sage-green tint (`#6b8e6b` border, `#dfe8df` fill)
- **Glyph**: `✋` raised hand prefix in the label
- **Label**: name on top in Caveat (sage-green), meta line `caller · <contact-count> contacts` in mono

Edges into Callers use `edge-call` style: solid sage-green line with a thicker arrow.

### Swarm canvas — Informer node rendering

Distinct from Callers:
- **Shape**: ellipse — implies "broadcast / notify"
- **Colour**: slate-blue tint (`#5b7fa6` border, `#dde6f0` fill)
- **Glyph**: `📢` speaker prefix in the label
- **Label**: name on top in Caveat (slate-blue), meta line `informer · <contact-count> contacts` in mono

Edges into Informers use `edge-inform` style: dashed slate-blue line with no arrowhead — visually lighter than `edge-call` to communicate non-blocking nature.

### Live mode on Caller nodes

When a run is in `awaiting_human` because of an active call to a Caller, the Caller node pulses sage-green (mirroring how active agents pulse amber). Tapping the pulsing node deep-links into the inbox card.

### Library tab — Callers section

A new section in the Library view, alongside Knowledge and Skills. Same conventions:
- Scope sidebar (company / workspace / swarm-of-the-workspace)
- List with display name, contact count, scope badge
- Edit modal with frontmatter form + body markdown editor
- Delete guarded by "still referenced in swarm X" warning

### Swarm-canvas palette

Add Caller to the drag-add palette (the left sidebar in the canvas). Sage-green dot, "Caller" label, drag onto the canvas to create a new caller bound to the current swarm scope.

---

## Worked example

A user opens the invoice-intake swarm. The validator agent finishes its checks and emits `consult_caller` for the `finance-approver` with payload `{ "supplier": "Acme Industries", "amount": 12500 }`.

1. Runtime sees the edge in `calls`. Validates strict topology — yes, `validator → finance-approver` is declared with purpose "Approve payments over €10,000".
2. Inserts `human_actions` row with `status=pending`. Marks `runs.status=awaiting_human`.
3. SSE broadcasts the new pending action. Marija's open Inbox tab adds a card.
4. Marija reads the card, sees the supplier and amount. The caller's body markdown reminds her to check for a matching purchase order. She edits the payload to add `{ "po_number": "PO-2026-118", "approver_note": "Confirmed against PO" }` and clicks **Edit & Approve**.
5. POST `/inbox/<id>/approve` writes `decision_payload_json`, `decided_at`, `status=approved`. Enqueues a resume event.
6. Runtime picks up the resume event. Loads the snapshot. Injects the decision payload into the validator's pending sub-action result. Validator's loop continues — it now sees the approval and the PO number, sends the payment, and reports back to coordinator.
7. The run completes. The `run_steps` row for the call is annotated with `caller_id`, `kind=call`, the original payload, and Marija's decision payload. Auditing six months later shows the full chain.

---

## What Phase 6 deliberately does NOT include

- **Authentication.** The `contacts` field is informational. Anyone with GUI access sees the same inbox until the auth phase wires user identity to caller contacts. Same rule as Phase 5: no piecemeal auth.
- **SLA timers and escalation.** `escalation_after_seconds`, `fallback`, and `timeout_action` are stored in the file format, validated, and exposed in the API — but no background ticker enforces them in v1. That's a follow-up phase once we have a clear story for "who runs the ticker" (probably the existing APScheduler).
- **Multi-stage approval.** No committees, no sequential approvers, no threshold-of-N voting. One human decision per call edge.
- **Push notifications.** No email, Slack, or mobile push. The Inbox is a pull surface; if you don't have the GUI open, you don't see new items. Push integration is its own phase.
- **Decision history per human.** Until auth, "who approved this" is a free-text field, not a queryable user. The audit trail records what's there but doesn't aggregate by approver.
- **Rich payload editors.** The Edit & Approve flow gives you a CodeMirror JSON editor. No form-builder, no schema-driven editing. Schema is in the agent's mind; the human edits raw JSON.
- **Approve-all batching.** No "approve all 12 pending finance items at once." Each decision is explicit and individual — that friction is a feature for an audit-grade tool.

---

## Architecture invariants this phase upholds

- **Constitutions are identity.** Caller `.md` files describe what the human role *is*; agents do not learn human-routing rules from their constitutions.
- **Topology is composition.** Every human dependency is declared in `hierarchy.json` via the `calls` array.
- **Strict topology enforcement.** Agents can only call Callers they're connected to. Violations log as `topology_violation` exactly like agent-to-agent violations today.
- **Filesystem is structure, database is index.** The Caller's source of truth is the `.md` file; `callers` is the indexed registry; `human_actions` holds runtime state.
- **Triggers are scripts, not agents.** Callers extend this principle in the opposite direction — they're a *human-driven* node type, with no LLM call inside the runtime path.

---

## Acceptance checklist

### Caller / blocking call
- [ ] A `.md` file in `data/company/callers/` is picked up by the registry on boot and shows up in `GET /callers`
- [ ] A swarm with a `calls` entry referencing a missing caller is marked `enabled=false` with a structured error
- [ ] A swarm with a `calls` entry whose `purpose` is empty is rejected at hierarchy-validation time
- [ ] An agent that emits `consult_caller` for a target it isn't connected to logs a `topology_violation` and stops the run
- [ ] When an agent triggers a `call`, the run reaches `awaiting_human` status within one event loop tick
- [ ] An open Inbox tab receives the new card via SSE within one second of the run pausing
- [ ] `POST /inbox/<id>/decide` with `decision=yes` resumes the run; the agent's next turn sees `{decision: "yes", payload: <original>}`
- [ ] `POST /inbox/<id>/decide` with `decision=no` resumes the run; the agent's next turn sees `{decision: "no", payload: <original>}`
- [ ] `decision=yes` with `amend` set: agent sees `{decision: "yes", payload: <original>, amend: <human_amendment>}`
- [ ] `decision=no` with `amend` set: agent sees `{decision: "no", payload: <original>, amend: <human_amendment>}`
- [ ] `reason` is forwarded to the agent's `action_result` when non-empty, omitted otherwise
- [ ] `POST /inbox/<id>/decide` on an already-decided item returns 409
- [ ] `run_steps` records `step_type=caller_call`, `edge_purpose`, and `caller_id` for every traversed call edge
- [ ] The swarm canvas renders Caller nodes in the sage-green speech-bubble style with the raised-hand glyph
- [ ] The swarm canvas pulses the relevant Caller node sage-green when a run is awaiting that caller
- [ ] Tapping a pulsing Caller deep-links into the matching inbox card
- [ ] A Caller can be created, edited, and deleted from the Library tab
- [ ] Deleting a Caller still referenced by any swarm fails with a structured "still referenced in <swarm>" error

### Informer / non-blocking notify
- [ ] A `.md` file in `data/company/informers/` is picked up by the registry on boot and shows up in `GET /informers`
- [ ] A swarm with an `informs` entry referencing a missing informer is marked `enabled=false` with a structured error
- [ ] A swarm with an `informs` entry whose `purpose` is empty is rejected at hierarchy-validation time
- [ ] An agent that emits `inform_informer` for a target it isn't connected to logs a `topology_violation` and stops the run
- [ ] When an agent triggers an `inform`, the run does NOT pause — it continues immediately
- [ ] An open Inbox tab receives the inform card via SSE within one second (separate `human_inform.pending` event)
- [ ] `run_steps` records `step_type=informer_notify`, `edge_purpose`, and `informer_id`
- [ ] `POST /informs/<id>/read` marks the card read and broadcasts `human_inform.acked`
- [ ] `POST /informs/<id>/dismiss` marks the card dismissed
- [ ] `POST /informs/<id>/read` on an already-read item returns 409
- [ ] The swarm canvas renders Informer nodes in the slate-blue ellipse style with the speaker glyph
- [ ] An Informer can be created, edited, and deleted from the Library tab
- [ ] Deleting an Informer still referenced by any swarm fails with a structured "still referenced in <swarm>" error
