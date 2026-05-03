"""Tests for app/core/registry.py — boot scan and file registration (item 1)."""
from __future__ import annotations

import json
import os

import pytest
from sqlalchemy import select

from app.core.registry import boot_scan, get_hierarchy
from app.db import get_session
from app.models.agent import Agent
from app.models.knowledge import KnowledgeDocument
from app.models.swarm import Swarm
from app.models.workspace import Workspace


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture()
def data_tree(tmp_path):
    """Minimal on-disk data tree: one workspace, one swarm, two agents."""
    ws_path = tmp_path / "workspaces" / "acme"
    swarm_path = ws_path / "swarms" / "billing"
    agents_dir = swarm_path / "agents"
    agents_dir.mkdir(parents=True)
    (tmp_path / "company" / "knowledge").mkdir(parents=True)
    (tmp_path / "company" / "perceptionists").mkdir(parents=True)
    (ws_path / "knowledge").mkdir(parents=True)
    (ws_path / "perceptionists").mkdir(parents=True)

    (ws_path / "meta.yaml").write_text("display_name: Acme\n")

    (agents_dir / "orchestrator.md").write_text(
        "---\nlayer: orchestrator\n---\nYou orchestrate billing."
    )
    (agents_dir / "processor.md").write_text(
        "---\nlayer: executioner\n---\nYou process invoices."
    )

    hierarchy = {
        "swarm": "billing",
        "agents": ["orchestrator", "processor"],
        "edges": [
            {
                "from": "orchestrator",
                "to": "processor",
                "kind": "delegate",
                "purpose": "Delegate invoice processing",
            }
        ],
        "consultations": [],
        "skills": [],
        "entry_point": "orchestrator",
    }
    (swarm_path / "meta.yaml").write_text("display_name: Billing\n")
    (swarm_path / "hierarchy.json").write_text(json.dumps(hierarchy))

    return str(tmp_path), str(ws_path), str(swarm_path)


# ── Item 1: agent registered after boot scan ──────────────────────────────────

def test_boot_scan_registers_workspace(app, data_tree):
    data_dir, _, _ = data_tree
    with app.app_context():
        boot_scan(data_dir)
        with get_session() as session:
            ws = session.execute(
                select(Workspace).where(Workspace.name == "acme")
            ).scalar_one_or_none()
        assert ws is not None
        assert ws.display_name == "Acme"


def test_boot_scan_registers_swarm(app, data_tree):
    data_dir, _, _ = data_tree
    with app.app_context():
        boot_scan(data_dir)
        with get_session() as session:
            swarm = session.execute(
                select(Swarm).where(Swarm.name == "billing")
            ).scalar_one_or_none()
        assert swarm is not None
        assert swarm.enabled is True
        assert swarm.validation_error is None


def test_boot_scan_registers_agents(app, data_tree):
    """Item 1 — agents in the agents/ folder are registered in the DB."""
    data_dir, _, _ = data_tree
    with app.app_context():
        boot_scan(data_dir)
        with get_session() as session:
            swarm = session.execute(
                select(Swarm).where(Swarm.name == "billing")
            ).scalar_one_or_none()
            agents = session.execute(
                select(Agent).where(Agent.swarm_id == swarm.id)
            ).scalars().all()
        names = {a.name for a in agents}
    assert "orchestrator" in names
    assert "processor" in names


def test_boot_scan_new_agent_picked_up(app, data_tree):
    """Dropping a new .md into agents/ and re-scanning registers the agent."""
    data_dir, _, swarm_path = data_tree
    with app.app_context():
        boot_scan(data_dir)

        # Drop a new agent file
        new_agent = os.path.join(swarm_path, "agents", "auditor.md")
        with open(new_agent, "w") as f:
            f.write("---\nlayer: executioner\n---\nYou audit invoices.")

        # Update hierarchy to include the new agent
        hier_path = os.path.join(swarm_path, "hierarchy.json")
        with open(hier_path) as f:
            hier = json.load(f)
        hier["agents"].append("auditor")
        with open(hier_path, "w") as f:
            json.dump(hier, f)

        # Re-scan (simulates what the file watcher does)
        boot_scan(data_dir)

        with get_session() as session:
            swarm = session.execute(
                select(Swarm).where(Swarm.name == "billing")
            ).scalar_one_or_none()
            agent = session.execute(
                select(Agent).where(
                    Agent.swarm_id == swarm.id, Agent.name == "auditor"
                )
            ).scalar_one_or_none()
    assert agent is not None
    assert agent.layer == "executioner"


def test_boot_scan_hierarchy_cached(app, data_tree):
    """After boot scan the hierarchy is in the in-memory cache."""
    data_dir, _, _ = data_tree
    with app.app_context():
        boot_scan(data_dir)
        with get_session() as session:
            swarm = session.execute(
                select(Swarm).where(Swarm.name == "billing")
            ).scalar_one_or_none()
            swarm_id = swarm.id
        cached = get_hierarchy(swarm_id)
    assert cached is not None
    assert "orchestrator" in cached.agents


def test_boot_scan_invalid_hierarchy_marks_swarm_disabled(app, data_tree):
    """A broken hierarchy.json marks the swarm enabled=False."""
    data_dir, _, swarm_path = data_tree
    # Break the hierarchy
    with open(os.path.join(swarm_path, "hierarchy.json"), "w") as f:
        json.dump({"swarm": "billing", "agents": ["ghost"], "edges": [],
                   "consultations": [], "skills": []}, f)

    with app.app_context():
        boot_scan(data_dir)
        with get_session() as session:
            swarm = session.execute(
                select(Swarm).where(Swarm.name == "billing")
            ).scalar_one_or_none()
        assert swarm.enabled is False
        assert swarm.validation_error is not None


def test_boot_scan_registers_knowledge_docs(app, data_tree):
    """Knowledge documents in the knowledge/ folder are indexed."""
    data_dir, _, swarm_path = data_tree
    k_dir = os.path.join(swarm_path, "knowledge")
    os.makedirs(k_dir, exist_ok=True)
    with open(os.path.join(k_dir, "billing-rules.md"), "w") as f:
        f.write("# Billing Rules\nInvoices over €10k require approval.")

    with app.app_context():
        boot_scan(data_dir)
        with get_session() as session:
            doc = session.execute(
                select(KnowledgeDocument).where(KnowledgeDocument.name == "billing-rules")
            ).scalar_one_or_none()
    assert doc is not None
    assert doc.title == "Billing Rules"


def test_boot_scan_idempotent(app, data_tree):
    """Running boot_scan twice does not duplicate rows."""
    data_dir, _, _ = data_tree
    with app.app_context():
        boot_scan(data_dir)
        boot_scan(data_dir)
        with get_session() as session:
            count = len(session.execute(
                select(Swarm).where(Swarm.name == "billing")
            ).scalars().all())
    assert count == 1


# ── Caller registry (Phase 6) ────────────────────────────────────────────────

def test_boot_scan_registers_caller_at_company_scope(app, data_tree):
    from app.models.caller import Caller
    data_dir, _, _ = data_tree
    callers_dir = os.path.join(data_dir, "company", "callers")
    os.makedirs(callers_dir, exist_ok=True)
    with open(os.path.join(callers_dir, "finance-approver.md"), "w") as f:
        f.write(
            "---\n"
            "name: finance-approver\n"
            "display_name: Finance approver\n"
            "contacts: [marija@example.com]\n"
            "---\n\n"
            "Approves payments over €10k."
        )

    with app.app_context():
        boot_scan(data_dir)
        with get_session() as session:
            row = session.execute(
                select(Caller).where(Caller.name == "finance-approver")
            ).scalar_one_or_none()
    assert row is not None
    assert row.scope == "company"
    assert row.display_name == "Finance approver"
    assert row.enabled is True


def test_boot_scan_caller_with_invalid_timeout_action_is_disabled(app, data_tree):
    from app.models.caller import Caller
    data_dir, _, _ = data_tree
    callers_dir = os.path.join(data_dir, "company", "callers")
    os.makedirs(callers_dir, exist_ok=True)
    with open(os.path.join(callers_dir, "broken.md"), "w") as f:
        f.write(
            "---\n"
            "name: broken\n"
            "display_name: Broken caller\n"
            "contacts: [a@b]\n"
            "timeout_action: ignite\n"  # invalid
            "---\n"
        )

    with app.app_context():
        boot_scan(data_dir)
        with get_session() as session:
            row = session.execute(
                select(Caller).where(Caller.name == "broken")
            ).scalar_one_or_none()
    assert row is not None
    assert row.enabled is False


def test_boot_scan_caller_idempotent(app, data_tree):
    from app.models.caller import Caller
    data_dir, _, _ = data_tree
    callers_dir = os.path.join(data_dir, "company", "callers")
    os.makedirs(callers_dir, exist_ok=True)
    with open(os.path.join(callers_dir, "support.md"), "w") as f:
        f.write("---\nname: support\ndisplay_name: Support\ncontacts: [s@x]\n---\n")
    with app.app_context():
        boot_scan(data_dir)
        boot_scan(data_dir)
        with get_session() as session:
            n = len(session.execute(
                select(Caller).where(Caller.name == "support")
            ).scalars().all())
    assert n == 1
