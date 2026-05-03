# Agentic Swarm Architecture

> A framework for designing and operating AI agent swarms that handle administrative work — with a strict topology, three-scope resource organization, and every interaction governed by reviewable markdown files.

---

## What this is

An end-to-end specification for building an agentic swarm system that can be deployed in a company's administrative environment. It covers backend architecture, the agent runtime, the GUI for designing swarms, a worked example, and operational settings.

The system has three properties that distinguish it from most agent frameworks:

**Hierarchical agents with a non-hierarchical support layer.** Agents come in four kinds — Policy, Orchestrator, Executioner, and Perceptionist. The first three form the chain of authority. Perceptionists are read-only grounding services available to all of them. Authority flows down. Truth flows sideways.

**A strict topology with declared purposes.** Every connection between agents (escalation, delegation, consultation, skill calls) lives in a `hierarchy.json` file. Every connection has a written *purpose* string. The runtime enforces it — agents cannot call anything that isn't declared. This means the system's behavior is auditable: every step in every run records which declared edge authorized it.

**Three-scope resource organization.** Knowledge, skills, and perceptionists live at one of three scopes — company-wide, workspace, or swarm. The same constitution can be reused across swarms with different topologies. Resources promote between scopes as patterns emerge.

The full architectural reasoning is laid out in five build documents and one example bundle.

---

## What's in this repository

This repository contains six documents. They are written to be read in order if you have time, or skimmed via the routing guide below if you don't.

| Document | What it covers | When to read it |
|---|---|---|
| **PHASE_1_BACKEND.md** | Containerized Flask service, eight-table SQLite schema, folder structure, reference resolver, API surface | First, if you're implementing |
| **PHASE_2_MODULES.md** | The five modules: hierarchy, agents, skills, knowledge, triggers. Topology validation and runtime enforcement. | After Phase 1 |
| **PHASE_3_INTERFACE.md** | The GUI: org-design / swarm-design / constitution-edit modes, plus the Runs view | After Phase 2, or alongside |
| **PHASE_4_EXAMPLE_BUNDLE.md** | A complete worked example — the invoice intake swarm with every artifact filled in | Read this *first* if you want to see the system in action |
| **PHASE_5_SETTINGS.md** | LLM credentials, models, branding, system defaults, encryption key rotation | After core system works |
| **README.md** (this file) | Orientation, build order, routing guide | Now |

There's also one external artifact:

- **Agentic_Swarm_Architecture.pptx** — a management-facing deck that sells the architectural ideas without engineering depth. Use this to get organizational buy-in before building.

---

## Where to start (a routing guide)

Different readers want different things from these documents. Here's what to read first depending on what you're doing.

### "I'm a developer about to build this"

Read the **README** (you're here), then **PHASE_4_EXAMPLE_BUNDLE.md** to see the whole system in concrete form, then **PHASE_1_BACKEND.md** to start implementing. Phase 4 first is non-obvious advice but worth it — concrete examples make abstract specs much easier to read. By the time you reach Phase 1, you already know what an agent constitution looks like, what `hierarchy.json` contains, and what a swarm folder holds.

### "I'm a manager deciding whether this is worth building"

Open the **management deck** (PowerPoint). It explains the *why* and the *what* without engineering depth. After that, read this README and skim **PHASE_4_EXAMPLE_BUNDLE.md** to see the system at work. The build phases are reference material — you don't need to read them.

### "I'm a designer working on the GUI"

Read this README, then jump straight to **PHASE_3_INTERFACE.md**. Use **PHASE_4_EXAMPLE_BUNDLE.md** as your data — every screen in the GUI should be designable using the names and structures from the example. Don't invent placeholder data; use the invoice-intake example throughout.

### "I'm an operator deploying this for my company"

Read this README, then **PHASE_5_SETTINGS.md** to understand what you'll need to configure. The other phases are interesting context but not essential for deployment. Once the system is running, you'll spend most of your time in the Settings screen.

### "I'm a stakeholder being asked to approve a pilot"

Read the **management deck** and the "What this is" section above. That's enough. The build documents exist to prove the system is real and buildable — you don't need to read them to make a decision.

---

## Build order

If you're implementing the full system from scratch:

1. **Phase 1** — Backend skeleton. ~1 week of focused work. You get a Docker container that boots, has all eight tables, exposes the API surface, and does nothing yet. The reference resolver passes its unit tests.

2. **Phase 2** — Modules, in this order: hierarchy → agents → skills → knowledge → triggers. ~3-4 weeks. By the end you have a working swarm. Demo it with the example bundle.

3. **Phase 3** — Interface, built incrementally screen-by-screen. ~3-4 weeks. Org-design first (read-only, then editable), then swarm-design canvas, then constitution editor, then Runs, then live mode.

4. **Phase 5** — Settings. ~1 week. Build this when the rest is stable so you know what really needs configuring.

The example bundle (Phase 4) isn't a build phase — it's reference material you populate at any time after Phase 2 is working.

Total: 8-10 weeks for a single developer with focus. Faster with two. The architecture is designed to be buildable by a small team.

---

## Architectural principles, in brief

The five documents repeat a small set of principles. Internalize these and the rest of the design decisions become predictable.

**Constitutions are identity. Topology is composition.** Agent `.md` files describe what an agent is and values. They do *not* declare what the agent connects to. That lives in `hierarchy.json`, scoped to the swarm. The same constitution can participate in multiple swarms with different topologies.

**Triggers are scripts, not agents.** Anything that doesn't need judgment is a script. Heartbeats, listeners, invocations: all deterministic Python. No LLM calls at the boundary of the system. Use the dumbest thing that works.

**Strict mode for the topology.** No agent can call anything that isn't declared in `hierarchy.json`. Violations are logged, surfaced in the Runs view, and treated as design conversations between the constitution and the topology rather than runtime errors.

**Three scopes for everything reusable.** Company-wide, workspace, swarm. Resources resolve from the most-local match outward. Qualified references (`company/glossary`, `workspace/finance-procedures`) override resolution when explicitness matters.

**The filesystem is structure; the database is index.** Constitutions, hierarchies, knowledge documents, skills, trigger configs all live as files on disk. The database holds runtime state and indexes for fast queries. You can `git diff` your swarm. You can grep it. You can back it up by copying the folder.

**Cloud LLMs to start, swappable later.** Anthropic and OpenAI behind one interface. Local models (Ollama) are a future swap, not a day-one requirement.

**Single container, single SQLite file.** Phase 1 deliberately avoids Redis, Postgres, message brokers. Earn complexity, don't pre-import it. The seams are clean for adding those when you actually need them.

---

## What this system is *not*

Worth being explicit about, because most agent frameworks make at least one of these promises:

- It is **not a no-code platform.** Skills are written in Python. Constitutions are written in markdown. Both are reviewable by non-developers, but writing them well is a skill.
- It is **not a multi-tenant SaaS.** One installation = one company. Multi-tenant deployment is a different product.
- It is **not designed for chat.** Agents respond to events, not to user messages. There's no "talk to your swarm" interface.
- It is **not a workflow engine.** Workflow engines (Temporal, n8n, Power Automate) handle deterministic processes with branches. This system handles *interpretive* work where the next step depends on judgment about messy inputs.
- It is **not RAG-first.** Knowledge is plain markdown injected into prompts. When the corpus grows beyond what fits in context, vector retrieval can be added — but starting there is over-engineering.
- It is **not yet authenticated.** Phase 1-5 assume localhost or behind-proxy deployment. Real auth comes in a later phase.

---

## A short glossary

Worth keeping in one place because the documents reuse these terms heavily.

- **Agent** — an LLM-powered component with a constitution, governed by topology
- **Constitution** — the markdown file that defines an agent's role and values
- **Edge** — a declared connection between two agents in `hierarchy.json`, with a kind (escalate / delegate / report) and a purpose
- **Heartbeat** — a scheduled trigger that polls something and produces events
- **Hierarchy** — the topology of a swarm; lives in `hierarchy.json`
- **Invocation** — a manual trigger fired by a human
- **Knowledge** — a markdown reference document agents read
- **Layer** — one of four agent kinds: Policy, Orchestrator, Executioner, Perceptionist
- **Listener** — a webhook trigger that receives external HTTP POSTs
- **Perceptionist** — a read-only grounding agent that maps external reality to internal data
- **Purpose** — a string explaining *why* a topology connection exists
- **Run** — one execution of a swarm in response to an event
- **Run step** — one action within a run (agent call, skill call, perceptionist call, escalation)
- **Scope** — one of three resource ownership levels: company / workspace / swarm
- **Skill** — a sandboxed Python script callable by an agent
- **Swarm** — a coherent set of agents that collaborate to handle one class of work
- **Topology** — the declared graph of agents, edges, consultations, and skill connections in a swarm
- **Trigger** — a script (not an agent) that produces events to wake the swarm
- **Workspace** — a department-like container for swarms and shared resources

---

## Conventions used across the documents

A few stylistic conventions worth knowing about:

**File names use kebab-case.** `invoice-orchestrator.md`, not `invoice_orchestrator.md` or `InvoiceOrchestrator.md`. Folder names are the same.

**JSON examples are realistic.** When a document shows JSON, the field values are what you'd actually see in production, not `"foo": "bar"` placeholders. This makes the examples runnable as test fixtures.

**Acceptance checklists at the end of each phase are real.** They're written as testable assertions, not aspirational prose. If a checklist item can't be verified by reading the system's output, it's worded badly and should be revised.

**"Phase X deliberately does NOT include" sections are load-bearing.** They explain what was scoped out and why. If something seems missing from a phase, check that section before assuming it was overlooked.

**The architecture is opinionated.** Phrases like "we picked SQLite because..." or "subprocess sandboxing is enough for trusted internal code" reflect deliberate choices, not gaps. Where a choice could reasonably be made differently, the document calls it out.

---

## Getting help with the documents

The build phases are detailed enough to hand directly to a coding agent (Claude, Cursor, Aider, etc.) and get reasonable output. The example bundle in particular is structured as runnable fixture data — drop the files into the right folders and the system should boot.

If you find inconsistencies between phases, the **example bundle (Phase 4)** is canonical. The build phases describe how the system works in general; the example shows how a real swarm is composed. If they conflict, fix the build phase.

If you find ambiguity in a phase, the **architectural principles** section above is the tiebreaker. When in doubt: constitutions are identity, topology is composition, triggers are scripts, three scopes for everything, strict mode always.

---

*This README and the documents it routes to were written iteratively over several philosophical discussions about how administrative agentic swarms should be structured. The reasoning behind major decisions — why constitutions hold knowledge but not skills, why perceptionists sit beside the hierarchy rather than within it, why purposes are required on every edge — is the result of those discussions. The rationale isn't always reproduced inline; if a decision seems arbitrary, it probably has a story behind it that the team can revisit.*
