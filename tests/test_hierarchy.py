"""Tests for app/core/hierarchy.py — parsing and validation of hierarchy.json."""
from __future__ import annotations

import json
import os

import pytest

from app.core.hierarchy import (
    HierarchyValidationError,
    ParsedHierarchy,
    load_and_validate,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture()
def swarm_tree(tmp_path):
    """A minimal, valid swarm on disk. Returns (data_dir, workspace_path, swarm_path)."""
    data_dir = tmp_path / "data"
    ws_path = data_dir / "workspaces" / "finance"
    swarm_path = ws_path / "swarms" / "invoice-intake"
    agents_dir = swarm_path / "agents"
    agents_dir.mkdir(parents=True)
    (data_dir / "company" / "perceptionists").mkdir(parents=True)
    (ws_path / "perceptionists").mkdir(parents=True)

    # Write two agent constitutions
    (agents_dir / "orchestrator.md").write_text("---\nlayer: orchestrator\n---\nYou orchestrate.")
    (agents_dir / "executioner.md").write_text("---\nlayer: executioner\n---\nYou execute.")

    hierarchy = {
        "swarm": "invoice-intake",
        "agents": ["orchestrator", "executioner"],
        "edges": [
            {
                "from": "orchestrator",
                "to": "executioner",
                "kind": "delegate",
                "purpose": "Delegate invoice booking",
            },
            {
                "from": "executioner",
                "to": "orchestrator",
                "kind": "report",
                "purpose": "Return booking result",
            },
        ],
        "consultations": [],
        "skills": [],
        "entry_point": "orchestrator",
    }
    (swarm_path / "hierarchy.json").write_text(json.dumps(hierarchy))

    return str(data_dir), str(ws_path), str(swarm_path)


def _write_hierarchy(swarm_path: str, data: dict) -> str:
    path = os.path.join(swarm_path, "hierarchy.json")
    with open(path, "w") as f:
        json.dump(data, f)
    return path


# ── Happy path ────────────────────────────────────────────────────────────────

def test_load_valid_hierarchy(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    h = load_and_validate(
        os.path.join(swarm_path, "hierarchy.json"),
        swarm_path=swarm_path,
        workspace_path=ws_path,
        data_dir=data_dir,
    )
    assert isinstance(h, ParsedHierarchy)
    assert h.swarm == "invoice-intake"
    assert "orchestrator" in h.agents
    assert "executioner" in h.agents
    assert h.entry_point == "orchestrator"


def test_parsed_hierarchy_get_allowed_edges(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    h = load_and_validate(
        os.path.join(swarm_path, "hierarchy.json"),
        swarm_path=swarm_path,
        workspace_path=ws_path,
        data_dir=data_dir,
    )
    edges = h.get_allowed_edges("orchestrator")
    assert len(edges) == 1
    assert edges[0]["kind"] == "delegate"

    edges_exec = h.get_allowed_edges("executioner")
    assert len(edges_exec) == 1
    assert edges_exec[0]["kind"] == "report"


def test_find_edge(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    h = load_and_validate(
        os.path.join(swarm_path, "hierarchy.json"),
        swarm_path=swarm_path,
        workspace_path=ws_path,
        data_dir=data_dir,
    )
    edge = h.find_edge("orchestrator", "executioner", "delegate")
    assert edge is not None
    assert edge["purpose"] == "Delegate invoice booking"

    assert h.find_edge("orchestrator", "executioner", "escalate") is None
    assert h.find_edge("executioner", "orchestrator", "delegate") is None


# ── Missing / invalid JSON ────────────────────────────────────────────────────

def test_missing_hierarchy_file(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(
            os.path.join(swarm_path, "does-not-exist.json"),
            swarm_path=swarm_path,
            workspace_path=ws_path,
            data_dir=data_dir,
        )
    assert exc_info.value.code == "file_not_found"


def test_invalid_json(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    path = os.path.join(swarm_path, "hierarchy.json")
    with open(path, "w") as f:
        f.write("{ not json }")
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "invalid_json"


# ── Missing top-level keys ────────────────────────────────────────────────────

@pytest.mark.parametrize("missing_key", ["swarm", "agents", "edges", "consultations", "skills"])
def test_missing_required_key(swarm_tree, missing_key):
    data_dir, ws_path, swarm_path = swarm_tree
    base = {
        "swarm": "x",
        "agents": [],
        "edges": [],
        "consultations": [],
        "skills": [],
    }
    del base[missing_key]
    path = _write_hierarchy(swarm_path, base)
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "missing_key"


# ── Agent resolution ──────────────────────────────────────────────────────────

def test_agent_not_found(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    hier = {
        "swarm": "x",
        "agents": ["orchestrator", "ghost"],
        "edges": [],
        "consultations": [],
        "skills": [],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "agent_not_found"


def test_invalid_entry_point(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    hier = {
        "swarm": "x",
        "agents": ["orchestrator"],
        "edges": [],
        "consultations": [],
        "skills": [],
        "entry_point": "ghost",
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "invalid_entry_point"


# ── Edge validation ───────────────────────────────────────────────────────────

def test_edge_missing_field(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    hier = {
        "swarm": "x",
        "agents": ["orchestrator", "executioner"],
        "edges": [{"from": "orchestrator", "to": "executioner", "kind": "delegate"}],  # no purpose
        "consultations": [],
        "skills": [],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "edge_missing_field"


def test_edge_empty_purpose(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    hier = {
        "swarm": "x",
        "agents": ["orchestrator", "executioner"],
        "edges": [{"from": "orchestrator", "to": "executioner", "kind": "delegate", "purpose": "  "}],
        "consultations": [],
        "skills": [],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "empty_purpose"


def test_edge_invalid_kind(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    hier = {
        "swarm": "x",
        "agents": ["orchestrator", "executioner"],
        "edges": [{"from": "orchestrator", "to": "executioner", "kind": "teleport", "purpose": "x"}],
        "consultations": [],
        "skills": [],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "invalid_edge_kind"


def test_edge_unknown_from_agent(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    hier = {
        "swarm": "x",
        "agents": ["orchestrator", "executioner"],
        "edges": [{"from": "ghost", "to": "executioner", "kind": "delegate", "purpose": "x"}],
        "consultations": [],
        "skills": [],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "unknown_agent"


def test_duplicate_edge(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    edge = {"from": "orchestrator", "to": "executioner", "kind": "delegate", "purpose": "x"}
    hier = {
        "swarm": "x",
        "agents": ["orchestrator", "executioner"],
        "edges": [edge, edge],
        "consultations": [],
        "skills": [],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "duplicate_edge"


# ── Consultation validation ───────────────────────────────────────────────────

def test_consultation_missing_field(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    hier = {
        "swarm": "x",
        "agents": ["orchestrator"],
        "edges": [],
        "consultations": [{"agent": "orchestrator", "perceptionist": "erp-lookup"}],  # no purpose
        "skills": [],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "consultation_missing_field"


def test_consultation_perceptionist_not_found(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    hier = {
        "swarm": "x",
        "agents": ["orchestrator"],
        "edges": [],
        "consultations": [{"agent": "orchestrator", "perceptionist": "ghost", "purpose": "x"}],
        "skills": [],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "perceptionist_not_found"


def test_consultation_resolved_via_company_scope(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    # Place a perceptionist at company scope
    perc_dir = os.path.join(data_dir, "company", "perceptionists")
    os.makedirs(perc_dir, exist_ok=True)
    with open(os.path.join(perc_dir, "erp-lookup.md"), "w") as f:
        f.write("---\nlayer: perceptionist\n---\nLook up ERP data.")

    hier = {
        "swarm": "x",
        "agents": ["orchestrator"],
        "edges": [],
        "consultations": [
            {"agent": "orchestrator", "perceptionist": "company/erp-lookup", "purpose": "Look up supplier"}
        ],
        "skills": [],
    }
    path = _write_hierarchy(swarm_path, hier)
    # Should not raise
    h = load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert len(h.consultations) == 1


# ── Item 2: constitution frontmatter and layer validation ─────────────────────

def test_invalid_constitution_frontmatter(swarm_tree):
    """Item 2 — an agent constitution with broken YAML frontmatter is rejected."""
    data_dir, ws_path, swarm_path = swarm_tree
    # Overwrite one constitution with invalid YAML in the frontmatter block
    agents_dir = os.path.join(swarm_path, "agents")
    with open(os.path.join(agents_dir, "orchestrator.md"), "w") as f:
        f.write("---\nlayer: [unclosed bracket\n---\nBody text.")

    hier = {
        "swarm": "x",
        "agents": ["orchestrator"],
        "edges": [],
        "consultations": [],
        "skills": [],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "invalid_constitution"


def test_invalid_agent_layer(swarm_tree):
    """Item 2 — an agent constitution declaring an unknown layer is rejected."""
    data_dir, ws_path, swarm_path = swarm_tree
    agents_dir = os.path.join(swarm_path, "agents")
    with open(os.path.join(agents_dir, "orchestrator.md"), "w") as f:
        f.write("---\nlayer: supervisor\n---\nNot a valid layer.")

    hier = {
        "swarm": "x",
        "agents": ["orchestrator"],
        "edges": [],
        "consultations": [],
        "skills": [],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "invalid_layer"


# ── Item 12: knowledge references resolved at validation time ─────────────────

def test_knowledge_ref_not_found(swarm_tree):
    """Item 12 — a knowledge reference in a constitution that cannot be resolved raises."""
    data_dir, ws_path, swarm_path = swarm_tree
    agents_dir = os.path.join(swarm_path, "agents")
    # Constitution references a knowledge doc that doesn't exist on disk
    with open(os.path.join(agents_dir, "orchestrator.md"), "w") as f:
        f.write("---\nlayer: orchestrator\nknowledge:\n  - ghost-doc\n---\nBody.")

    hier = {
        "swarm": "x",
        "agents": ["orchestrator"],
        "edges": [],
        "consultations": [],
        "skills": [],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "knowledge_not_found"


def test_knowledge_ref_resolved_at_swarm_scope(swarm_tree):
    """Item 12 — a knowledge doc that exists in the swarm's knowledge/ folder resolves OK."""
    data_dir, ws_path, swarm_path = swarm_tree
    # Create the knowledge doc at swarm scope
    k_dir = os.path.join(swarm_path, "knowledge")
    os.makedirs(k_dir, exist_ok=True)
    with open(os.path.join(k_dir, "billing-rules.md"), "w") as f:
        f.write("# Billing Rules\nInvoices over €10k need approval.")

    agents_dir = os.path.join(swarm_path, "agents")
    with open(os.path.join(agents_dir, "orchestrator.md"), "w") as f:
        f.write("---\nlayer: orchestrator\nknowledge:\n  - billing-rules\n---\nBody.")

    hier = {
        "swarm": "x",
        "agents": ["orchestrator"],
        "edges": [],
        "consultations": [],
        "skills": [],
    }
    path = _write_hierarchy(swarm_path, hier)
    # Should not raise
    h = load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert "orchestrator" in h.agents


# ── Skill validation ──────────────────────────────────────────────────────────

def test_skill_not_found(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    hier = {
        "swarm": "x",
        "agents": ["orchestrator"],
        "edges": [],
        "consultations": [],
        "skills": [{"agent": "orchestrator", "skill": "ghost-skill", "purpose": "x"}],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc_info:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc_info.value.code == "skill_not_found"


# ── Calls (Phase 6) ───────────────────────────────────────────────────────────

def test_calls_validates_when_caller_exists(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    callers_dir = os.path.join(data_dir, "company", "callers")
    os.makedirs(callers_dir, exist_ok=True)
    with open(os.path.join(callers_dir, "finance-approver.md"), "w") as f:
        f.write("---\nname: finance-approver\ndisplay_name: Finance approver\ncontacts: [a@x]\n---\n")

    hier = {
        "swarm": "x",
        "agents": ["orchestrator"],
        "edges": [],
        "consultations": [],
        "skills": [],
        "calls": [{"agent": "orchestrator", "caller": "finance-approver",
                   "purpose": "Approve high-value invoices"}],
    }
    path = _write_hierarchy(swarm_path, hier)
    h = load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert h.find_call("orchestrator", "finance-approver") is not None
    assert h.get_allowed_calls("orchestrator")[0]["purpose"].startswith("Approve")


def test_calls_missing_caller_raises(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    hier = {
        "swarm": "x",
        "agents": ["orchestrator"],
        "edges": [],
        "consultations": [],
        "skills": [],
        "calls": [{"agent": "orchestrator", "caller": "ghost", "purpose": "p"}],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc.value.code == "caller_not_found"


def test_calls_empty_purpose_rejected(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    callers_dir = os.path.join(data_dir, "company", "callers")
    os.makedirs(callers_dir, exist_ok=True)
    (open(os.path.join(callers_dir, "rev.md"), "w")).write(
        "---\nname: rev\ndisplay_name: Rev\ncontacts: [a@b]\n---\n"
    )

    hier = {
        "swarm": "x",
        "agents": ["orchestrator"],
        "edges": [],
        "consultations": [],
        "skills": [],
        "calls": [{"agent": "orchestrator", "caller": "rev", "purpose": "  "}],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc.value.code == "empty_purpose"


def test_calls_unknown_agent_rejected(swarm_tree):
    data_dir, ws_path, swarm_path = swarm_tree
    callers_dir = os.path.join(data_dir, "company", "callers")
    os.makedirs(callers_dir, exist_ok=True)
    with open(os.path.join(callers_dir, "rev.md"), "w") as f:
        f.write("---\nname: rev\ndisplay_name: Rev\ncontacts: [a@b]\n---\n")

    hier = {
        "swarm": "x",
        "agents": ["orchestrator"],
        "edges": [],
        "consultations": [],
        "skills": [],
        "calls": [{"agent": "phantom", "caller": "rev", "purpose": "p"}],
    }
    path = _write_hierarchy(swarm_path, hier)
    with pytest.raises(HierarchyValidationError) as exc:
        load_and_validate(path, swarm_path=swarm_path, workspace_path=ws_path, data_dir=data_dir)
    assert exc.value.code == "unknown_agent"
