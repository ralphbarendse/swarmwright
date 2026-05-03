from __future__ import annotations

import os

import pytest

from app.core.resolver import resolve, ResolverError


@pytest.fixture()
def tree(tmp_path):
    """Build a minimal three-scope directory tree."""
    company = tmp_path / "company"
    workspace = tmp_path / "workspaces" / "ws-1"
    swarm = workspace / "swarms" / "sw-1"

    for folder in [
        company / "knowledge",
        company / "skills",
        company / "perceptionists",
        company / "callers",
        workspace / "knowledge",
        workspace / "skills",
        workspace / "perceptionists",
        workspace / "callers",
        swarm / "knowledge",
        swarm / "skills",
        swarm / "perceptionists",
        swarm / "callers",
    ]:
        folder.mkdir(parents=True)

    return {
        "data_dir": str(tmp_path),
        "workspace_path": str(workspace),
        "swarm_path": str(swarm),
        "company": company,
        "workspace": workspace,
        "swarm": swarm,
    }


# ── Unqualified references ────────────────────────────────────────────────────

def test_unqualified_swarm_wins(tree):
    """Swarm-scope document shadows workspace and company copies."""
    (tree["swarm"] / "knowledge" / "glossary.md").write_text("swarm version")
    (tree["workspace"] / "knowledge" / "glossary.md").write_text("workspace version")
    (tree["company"] / "knowledge" / "glossary.md").write_text("company version")

    scope, path = resolve(
        "glossary", "knowledge",
        data_dir=tree["data_dir"],
        swarm_path=tree["swarm_path"],
        workspace_path=tree["workspace_path"],
    )
    assert scope == "swarm"
    assert path.endswith("glossary.md")
    assert open(path).read() == "swarm version"


def test_unqualified_workspace_wins_over_company(tree):
    """Without a swarm copy, workspace beats company."""
    (tree["workspace"] / "knowledge" / "procedures.md").write_text("ws procedures")
    (tree["company"] / "knowledge" / "procedures.md").write_text("co procedures")

    scope, path = resolve(
        "procedures", "knowledge",
        data_dir=tree["data_dir"],
        swarm_path=tree["swarm_path"],
        workspace_path=tree["workspace_path"],
    )
    assert scope == "workspace"
    assert open(path).read() == "ws procedures"


def test_unqualified_falls_back_to_company(tree):
    """Only company copy available — resolves there."""
    (tree["company"] / "knowledge" / "company-only.md").write_text("co only")

    scope, path = resolve(
        "company-only", "knowledge",
        data_dir=tree["data_dir"],
        swarm_path=tree["swarm_path"],
        workspace_path=tree["workspace_path"],
    )
    assert scope == "company"
    assert open(path).read() == "co only"


def test_unqualified_not_found_raises(tree):
    with pytest.raises(ResolverError, match="missing-doc"):
        resolve(
            "missing-doc", "knowledge",
            data_dir=tree["data_dir"],
            swarm_path=tree["swarm_path"],
            workspace_path=tree["workspace_path"],
        )


# ── Qualified references ──────────────────────────────────────────────────────

def test_company_qualifier_forces_company_scope(tree):
    """company/ prefix skips swarm and workspace even if they exist."""
    (tree["swarm"] / "knowledge" / "glossary.md").write_text("swarm")
    (tree["company"] / "knowledge" / "glossary.md").write_text("company")

    scope, path = resolve(
        "company/glossary", "knowledge",
        data_dir=tree["data_dir"],
        swarm_path=tree["swarm_path"],
        workspace_path=tree["workspace_path"],
    )
    assert scope == "company"
    assert open(path).read() == "company"


def test_workspace_qualifier_forces_workspace_scope(tree):
    """workspace/ prefix skips swarm scope."""
    (tree["swarm"] / "knowledge" / "finance.md").write_text("swarm finance")
    (tree["workspace"] / "knowledge" / "finance.md").write_text("workspace finance")

    scope, path = resolve(
        "workspace/finance", "knowledge",
        data_dir=tree["data_dir"],
        swarm_path=tree["swarm_path"],
        workspace_path=tree["workspace_path"],
    )
    assert scope == "workspace"
    assert open(path).read() == "workspace finance"


def test_company_qualifier_not_found_raises(tree):
    with pytest.raises(ResolverError, match="company/nonexistent"):
        resolve(
            "company/nonexistent", "knowledge",
            data_dir=tree["data_dir"],
            swarm_path=tree["swarm_path"],
            workspace_path=tree["workspace_path"],
        )


def test_workspace_qualifier_not_found_raises(tree):
    with pytest.raises(ResolverError, match="workspace/nonexistent"):
        resolve(
            "workspace/nonexistent", "knowledge",
            data_dir=tree["data_dir"],
            swarm_path=tree["swarm_path"],
            workspace_path=tree["workspace_path"],
        )


# ── Resource types ────────────────────────────────────────────────────────────

def test_skill_resolves_py_file(tree):
    (tree["swarm"] / "skills" / "post-to-erp.py").write_text("# skill")

    scope, path = resolve(
        "post-to-erp", "skill",
        data_dir=tree["data_dir"],
        swarm_path=tree["swarm_path"],
        workspace_path=tree["workspace_path"],
    )
    assert scope == "swarm"
    assert path.endswith(".py")


def test_perceptionist_resolves_md_file(tree):
    (tree["company"] / "perceptionists" / "erp-lookup.md").write_text("---\nname: erp-lookup\n---")

    scope, path = resolve(
        "erp-lookup", "perceptionist",
        data_dir=tree["data_dir"],
        swarm_path=tree["swarm_path"],
        workspace_path=tree["workspace_path"],
    )
    assert scope == "company"
    assert path.endswith(".md")


# ── Edge cases ────────────────────────────────────────────────────────────────

def test_no_swarm_context_skips_swarm_scope(tree):
    """When no swarm_path is given, swarm scope is skipped."""
    (tree["workspace"] / "knowledge" / "doc.md").write_text("ws doc")

    scope, _ = resolve(
        "doc", "knowledge",
        data_dir=tree["data_dir"],
        workspace_path=tree["workspace_path"],
        # swarm_path intentionally omitted
    )
    assert scope == "workspace"


def test_workspace_qualifier_without_workspace_context_raises(tree):
    with pytest.raises(ResolverError):
        resolve(
            "workspace/something", "knowledge",
            data_dir=tree["data_dir"],
            # workspace_path intentionally omitted
        )


# ── Callers (Phase 6) ─────────────────────────────────────────────────────────

def test_caller_resolves_at_company_scope(tree):
    (tree["company"] / "callers" / "finance-approver.md").write_text(
        "---\nname: finance-approver\ndisplay_name: Finance approver\ncontacts: [a@x]\n---\n"
    )
    scope, path = resolve(
        "finance-approver", "caller",
        data_dir=tree["data_dir"],
        workspace_path=tree["workspace_path"],
        swarm_path=tree["swarm_path"],
    )
    assert scope == "company"
    assert path.endswith("finance-approver.md")


def test_caller_swarm_shadows_workspace_and_company(tree):
    (tree["company"] / "callers" / "review.md").write_text("co")
    (tree["workspace"] / "callers" / "review.md").write_text("ws")
    (tree["swarm"] / "callers" / "review.md").write_text("sw")

    scope, path = resolve(
        "review", "caller",
        data_dir=tree["data_dir"],
        workspace_path=tree["workspace_path"],
        swarm_path=tree["swarm_path"],
    )
    assert scope == "swarm"
    assert open(path).read() == "sw"


def test_caller_qualified_company_reference(tree):
    (tree["company"] / "callers" / "legal.md").write_text("co legal")
    (tree["workspace"] / "callers" / "legal.md").write_text("ws legal")

    scope, path = resolve(
        "company/legal", "caller",
        data_dir=tree["data_dir"],
        workspace_path=tree["workspace_path"],
    )
    assert scope == "company"
    assert open(path).read() == "co legal"


def test_caller_not_found_raises(tree):
    with pytest.raises(ResolverError, match="missing-caller"):
        resolve(
            "missing-caller", "caller",
            data_dir=tree["data_dir"],
            workspace_path=tree["workspace_path"],
            swarm_path=tree["swarm_path"],
        )
