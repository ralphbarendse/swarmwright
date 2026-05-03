# Phase 3 — Building the Interface

> Goal: give humans a way to design the org, compose swarms, edit constitutions, and observe runs without ever touching a `.md` file in a text editor or curling an endpoint. The interface has three distinct modes — each answering a different question.

---

## What "done" looks like for Phase 3

You open `http://localhost:5000` and see the org-design view: cards for each workspace. You create a new workspace, then a new swarm inside it. You enter the swarm-design view, drop agents onto the canvas, draw edges with declared purposes, wire up perceptionist consultations and skill connections — all writing back to `hierarchy.json` on disk. You drill into a single agent, edit its constitution. You fire a run and watch it animate through the topology in real time. You browse runs, see every step's authorizing edge purpose. You manage skills and knowledge across all three scopes.

---

## Stack

- **Vanilla JS** + **HTML** + **CSS** (no build step)
- **Cytoscape.js** for the swarm canvas
- **Server-Sent Events (SSE)** for live run updates
- **CodeMirror 6** for the `.md` and `.py` editors
- All assets served by Flask from `app/static/`
- No frontend framework, no bundler, no npm

The hard rule: **the frontend is a thin client.** All logic lives in the backend. The frontend reads from API endpoints, writes through API endpoints, and renders. It never holds canonical state.

---

## Three modes of work

The interface is organized around three modes, each answering a different question:

1. **Org-design mode** — *How is the company arranged?* Workspaces, swarms, and the resources scoped to each.
2. **Swarm-design mode** — *How does this workflow actually work?* The topology canvas — agents, edges, consultations, skill connections — for one swarm.
3. **Constitution-edit mode** — *What is this particular agent like?* Full-screen editor for one `.md` file with frontmatter form and live preview.

Each mode has its own primary screen. A persistent top bar lets you navigate between them. A persistent right sidebar shows context-sensitive panels. A persistent bottom drawer shows the live event stream when active.

A fourth view — the **Runs** screen — sits alongside the three modes. It's not a design mode; it's an observation mode. You go here to see what the swarm has been doing.

---

## Mode 1: Org-design

The entry point of the application. The screen shows workspaces as cards arranged in a grid. Each card displays:

- Display name (from `meta.yaml`)
- Description
- Number of swarms
- Last activity timestamp
- An icon

Clicking a workspace card drills into a workspace detail view: its swarms as sub-cards, plus tabs for the workspace's scoped resources (knowledge, skills, perceptionists). Clicking a swarm card drills into swarm-design mode for that swarm.

A separate "Company" tab on the top bar shows the company-wide scope: company knowledge, company skills, company perceptionists. These appear and behave identically to workspace-scoped resources, just at the broader scope.

### Editable display, stable identity

When users rename a workspace or swarm, only the display name in `meta.yaml` changes. Folder names (the stable identifiers) stay put. This means references between things never break when humans reorganize.

### Promoting and demoting resources

A resource (skill, knowledge document, perceptionist) lives at one scope. Sometimes a swarm-scoped resource turns out to be useful workspace-wide; sometimes a workspace resource should be promoted to company. The org-design mode supports this:

- Right-click a resource → "Move to..."
- Choose target scope (with permission warnings if it's destructive)
- The backend copies the file, updates references in any `hierarchy.json` files that point to it, deletes the original

The GUI is the canonical way to do this. Manual filesystem moves still work but require the user to understand the implications.

### The Org-design canvas

Beyond the cards, an optional **org-design canvas view** shows workspaces as larger nodes, swarms as nested smaller nodes, with a visual rendering of which workspaces and swarms exist. This view is for the high-level mental model — getting a sense of the whole system at once. It's not where you do detailed work; for that, you drill in.

---

## Mode 2: Swarm-design (the hero canvas)

This is where most design work happens. Open a swarm and you see its topology.

### Visual language

Each node type has a distinct visual treatment:

- **Policy** — deep-navy filled card, gavel icon, top of the layout
- **Orchestrator** — slate-blue filled card, sitemap icon, middle
- **Executioner** — charcoal filled card, gears icon, bottom
- **Perceptionist** — amber-bordered white card, eye icon, off to the side
- **Skill** — angular gray card with a sharp edge, gear icon, beside the agents that use it
- **Trigger** — angular dark-gray card, leftmost column, feeding into Orchestrators

The visual difference between agents (rounded, layer-colored) and scripts (angular, neutral) reinforces the *agent vs. script* distinction.

### Edges

- **Hierarchical edges** — solid arrows between agents, color-coded by kind:
  - `escalate` — amber arrow, pointing up
  - `delegate` — navy arrow, pointing down
  - `report` — gray arrow, pointing up (typically a return path)
- **Consultations** — dashed amber lines, no arrowhead (consultation is conceptually bidirectional in intent though directional in mechanics)
- **Skill connections** — dotted gray lines

Every edge displays its `purpose` string as a small label, dimmed but readable. Hovering an edge highlights it and shows the full purpose. **The purpose strings are the most important text on the canvas** — they're what makes the topology semantically rich.

### Layout

Auto-layout on initial load using Cytoscape's `dagre` plugin, but persist user-adjusted positions in each swarm's `meta.yaml` under a `gui` key. The backend treats `gui` as opaque metadata.

### The interaction model

- **Click** a node — selects it, opens inspector in right sidebar
- **Double-click** an agent — opens constitution-edit mode (Mode 3)
- **Right-click** a node — context menu: rename, duplicate, delete, disable/enable
- **Drag from sidebar palette** — drop a new agent on canvas. Prompts for name and layer. Creates the constitution file with starter content and adds the node to `hierarchy.json`'s `agents` list.
- **Drag from a node's edge** — start drawing an edge. Drop on target node. **A modal appears requiring a `purpose` string** before the edge is created. This is non-negotiable — purposes are what make the topology meaningful.
- **Click an existing edge** — inspector shows the purpose, allows editing
- **Drag** to pan, **scroll** to zoom

### Adding consultations and skill connections

Consultations (to perceptionists) and skill connections work differently from agent-to-agent edges because the targets aren't necessarily on the canvas — they might be at workspace or company scope. The interaction:

- Right-click an agent → "Add consultation" or "Add skill connection"
- A modal opens showing all available perceptionists/skills, grouped by scope (swarm/workspace/company)
- Pick one, enter a purpose
- A node appears on the canvas (if the perceptionist/skill wasn't already shown) and the connection is drawn

If the same perceptionist is already consulted by another agent in the swarm, the existing node gets a new connection — it's not duplicated.

### Saving topology changes

Every change to the canvas (add/remove node, add/remove edge, edit purpose) is sent to the backend as a structured operation, which:

1. Loads current `hierarchy.json`
2. Applies the operation
3. Validates the entire result
4. If valid: writes the file atomically and updates the `hierarchy_hash` in the database
5. If invalid: returns the error, the GUI rolls back the visual change

Validation failures show inline on the offending element. This is the same validator from Phase 2; the GUI just calls into it.

### The right sidebar (inspector)

When a node is selected, the inspector shows:

- Node name, layer badge, enabled toggle
- The constitution preview (rendered markdown, scrollable)
- "Edit constitution" button — switches to constitution-edit mode
- Outgoing connections grouped by type (edges, consultations, skills) — each with its purpose
- Incoming connections — each with its purpose
- Recent runs that involved this node — clickable to navigate to Runs

When an edge is selected, the inspector shows: from, to, kind, purpose (editable inline), and a "Delete" button.

When nothing is selected, the inspector shows swarm-level info: total agents, total triggers, last run, run success rate, the swarm's `meta.yaml` fields.

### Live mode

Click "Run" in the top bar to fire a simulated event into the swarm. The canvas enters **live mode**:

- The active node pulses with an amber glow
- The active edge animates with a flowing dot
- The bottom drawer slides up showing the live event log via SSE
- Each step appears in the log as the backend emits it, including the `edge_purpose` for that step
- When the run completes, the canvas returns to normal but the run is now visible in the Runs screen

This is the moment the architecture becomes vivid. A static diagram is theoretical; a live-animated graph showing each step authorized by a declared purpose is the architecture *operating itself.*

---

## Mode 3: Constitution-edit

CodeMirror 6 with markdown highlighting on the left, live-rendered preview on the right. Above the editor, a structured form for the YAML frontmatter — non-technical users edit the form, the YAML stays valid.

### Frontmatter form

For agents, the form has fields for:
- `name` (read-only after creation)
- `layer` (dropdown)
- `model` (dropdown of available LLMs)
- `knowledge` chips (autocompleted from registry, scoped — shows where each candidate lives)

Notice what's *not* here: no skill list, no perceptionist list, no edge declarations. Those live in the swarm's `hierarchy.json` and are edited in Mode 2. **Constitutions are about identity. Wiring is about composition.** The interface enforces this separation.

For skills (`.py` files), the form fields are: name, description, timeout_seconds, allowed_packages chips, input/output JSON schemas in a JSON-schema-aware editor.

For knowledge documents, no frontmatter — just title and markdown body.

### Save behavior

Save is **explicit** (Ctrl+S). Unsaved changes show a dot in the title and prompt on navigation away. Save sends the full file content to the backend, which validates frontmatter, validates references, writes atomically, returns success or structured errors.

Validation failures show inline on the offending fields. The file is *not* written until validation passes.

### Versioning (lightweight)

On every successful save, the previous version is copied to `.history/<name>/<timestamp>.md` next to the file. The editor has a "History" dropdown listing the last 20 versions, each clickable to view a diff. Restore is one click.

This is not Git. It's a simple history log. Users who want real version control put `data/` under Git themselves.

---

## The Runs screen

A two-pane view, separate from the three design modes.

### List

Paginated, filterable. Filters: status, source, swarm, date range, agent involved.

### Detail

For each run:
- Header: status, started, ended, duration, source, triggering event payload (collapsed)
- Vertical timeline of steps in chronological order
- Each step card: agent or skill name, step type, **edge purpose** (prominent — this is what makes the trail meaningful), duration, input (collapsed), output (collapsed), error if any
- Click a step to expand its input/output JSON
- A "Replay" button — re-runs the same triggering event through the current swarm config

### Live runs

A run currently in progress shows steps appearing one by one via SSE. The timeline updates without page refresh.

### Topology violations as a special case

If a run failed because an agent attempted an undeclared action, this is displayed prominently with the offending action's details and a link to the swarm's `hierarchy.json` for editing. This is not just a debug message — it's a feature. It surfaces the moments when the constitution and the topology disagreed, which is exactly what the architecture is designed to catch.

---

## The Library

A separate area accessible from the top bar. Two tabs: **Skills** and **Knowledge**, each with three sub-tabs for the three scopes (Company / Workspace / Swarm).

For each item, you see name, scope, description, last updated, and "used by" — which swarms reference it. Click to edit in Mode 3.

A search box does substring search across the active scope.

---

## Cross-cutting concerns

### Real-time updates

A single SSE endpoint `/api/v1/stream` sends events of types:

- `run.started`, `run.step`, `run.completed`, `run.failed` — for live canvas and Runs
- `topology.violation` — when an agent attempts an undeclared action
- `agent.registered`, `agent.updated`, `agent.removed` — for canvas auto-refresh
- `swarm.validation_failed` — when a `hierarchy.json` edit breaks validation
- `trigger.fired` — for canvas glow effects

The frontend keeps one persistent SSE connection open and dispatches events to whichever screen is active.

### Error surfacing

Every API error has a structured shape:

```json
{
  "error": {
    "code": "topology_violation",
    "message": "Agent 'invoice-orchestrator' attempted to call 'send-email' but no skill connection is declared in hierarchy.json",
    "field": "skills",
    "details": { "agent": "invoice-orchestrator", "attempted_target": "send-email" }
  }
}
```

The frontend has a single error toast component. Errors with a `field` highlight the offending form field.

### Keyboard shortcuts

- `Cmd/Ctrl + S` — save
- `Cmd/Ctrl + K` — quick-open palette (jump to any workspace, swarm, agent, skill, or document)
- `Cmd/Ctrl + /` — toggle live event stream drawer
- `Cmd/Ctrl + .` — switch between modes (cycle through org-design, swarm-design, constitution-edit if applicable)
- `Esc` — close any open modal or panel

### Visual design

Same palette as the management deck:
- Background: `#FAFBFC` content, `#0F1638` top bar
- Primary action: `#1E2761` navy
- Accent / live state: `#F9A826` amber
- Borders: `#E2E8F0`
- Body text: `#1F2937`
- Muted: `#6B7280`

Typography: Inter for UI, JetBrains Mono for code, Georgia for display text.

### Mobile

Out of scope. The swarm GUI is a desktop tool.

---

## Build order within Phase 3

1. **Org-design mode (read-only)** — load and render workspaces and swarms from the API. No editing yet.
2. **Org-design mode (editing)** — create/rename/delete workspaces and swarms. Resource promotion across scopes.
3. **Swarm-design canvas (read-only)** — render a swarm's topology from `hierarchy.json`. No editing yet.
4. **Swarm-design canvas (editing)** — add nodes, draw edges with required purposes, wire up consultations and skills. Every change validates against the backend.
5. **Constitution-edit mode** — full-screen editor with frontmatter form, save behavior, validation.
6. **Runs screen (historical)** — list and detail with full step trace and edge purposes.
7. **SSE and live mode** — real-time canvas glow, run timeline streaming, topology violation alerts.
8. **Library** — skills and knowledge management across scopes.
9. **Polish** — keyboard shortcuts, history versioning, search, command palette.

By step 5 you have an editable swarm. Steps 6–9 each add a slice of value.

---

## What Phase 3 deliberately does NOT include

- Authentication or multi-user collaboration
- Real-time collaborative editing
- Mobile-friendly layout
- Theming beyond light mode
- Plugin/extension system
- A marketplace for sharing swarms between organizations
- Internationalization (English UI; agent constitutions can be in any language)

---

## Acceptance checklist

- [ ] Opening the root URL shows the org-design view with all existing workspaces
- [ ] Creating a workspace via the GUI creates the folder + `meta.yaml` on disk
- [ ] Creating a swarm via the GUI creates the folder + `meta.yaml` + an empty valid `hierarchy.json`
- [ ] Renaming a workspace updates only the display name; folder name stays
- [ ] Promoting a swarm-scoped skill to workspace scope copies the file and updates references
- [ ] The swarm canvas renders agents, edges, and connection labels (with purposes)
- [ ] Drawing a new edge prompts for and requires a non-empty purpose string
- [ ] Adding a consultation to a workspace-scoped perceptionist correctly resolves the reference
- [ ] An invalid `hierarchy.json` change is rejected by the backend with inline GUI feedback
- [ ] Editing a constitution and saving updates the file and the database
- [ ] An agent file edited externally appears in the GUI within 10 seconds
- [ ] Firing a run from the canvas shows live step-by-step animation with edge purposes
- [ ] The Runs screen shows historical runs with full step detail including `edge_purpose`
- [ ] Topology violations appear prominently in the Runs screen with links to fix
- [ ] Skills and knowledge can be created, edited, deleted at all three scopes
- [ ] Keyboard shortcuts work as documented
- [ ] The interface is usable without ever opening a terminal
