"""Tests for app/core/runtime.py — agent execution and topology enforcement."""
from __future__ import annotations

import json
import os
from unittest.mock import MagicMock, patch

import pytest

from app.core.hierarchy import ParsedHierarchy
from app.core.runtime import (
    RunContext,
    TopologyViolationError,
    _build_system_prompt,
    _dispatch_sub_action,
    _parse_action,
    _run_agent_loop,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _make_hierarchy(
    agents=None,
    edges=None,
    consultations=None,
    skills=None,
    entry_point="orchestrator",
):
    return ParsedHierarchy(
        swarm="test-swarm",
        agents=agents or ["orchestrator"],
        edges=edges or [],
        consultations=consultations or [],
        skills=skills or [],
        entry_point=entry_point,
    )


@pytest.fixture()
def simple_hierarchy():
    return _make_hierarchy(
        agents=["orchestrator", "executioner"],
        edges=[
            {
                "from": "orchestrator",
                "to": "executioner",
                "kind": "delegate",
                "purpose": "Process the request",
            }
        ],
    )


@pytest.fixture()
def ctx(tmp_path, app, simple_hierarchy):
    """A RunContext for use in unit tests (run_id is a stub)."""
    with app.app_context():
        from app.db import get_session
        from app.models.run import Run, STATUS_RUNNING
        from datetime import datetime, timezone

        with get_session() as session:
            # We need a real event + swarm to satisfy FK constraints, so just
            # create a run with a stub approach using the app fixture's DB.
            pass

    return RunContext(
        run_id="test-run-id",
        swarm_id="test-swarm-id",
        swarm_path=str(tmp_path / "swarm"),
        workspace_path=str(tmp_path / "workspace"),
        data_dir=str(tmp_path / "data"),
        hierarchy=simple_hierarchy,
    )


# ── _parse_action ──────────────────────────────────────────────────────────────

def test_parse_action_valid_json():
    raw = json.dumps({"action": "complete", "input": {"answer": 42}, "reasoning": "done"})
    result = _parse_action(raw, "agent")
    assert result["action"] == "complete"
    assert result["input"]["answer"] == 42


def test_parse_action_strips_markdown_fence():
    raw = "```json\n{\"action\": \"complete\", \"input\": {}}\n```"
    result = _parse_action(raw, "agent")
    assert result["action"] == "complete"


def test_parse_action_strips_bare_fence():
    raw = "```\n{\"action\": \"complete\", \"input\": {}}\n```"
    result = _parse_action(raw, "agent")
    assert result["action"] == "complete"


def test_parse_action_invalid_json():
    from app.core.runtime import RuntimeError as SwarmRuntimeError
    with pytest.raises(SwarmRuntimeError, match="non-JSON"):
        _parse_action("not json at all", "agent")


def test_parse_action_missing_action_field():
    from app.core.runtime import RuntimeError as SwarmRuntimeError
    with pytest.raises(SwarmRuntimeError, match="missing required.*action"):
        _parse_action(json.dumps({"reasoning": "hmm"}), "agent")


# ── _build_system_prompt ──────────────────────────────────────────────────────

def test_system_prompt_includes_constitution(ctx):
    prompt = _build_system_prompt(
        constitution_body="You are a test orchestrator.",
        knowledge_text="",
        agent_name="orchestrator",
        ctx=ctx,
    )
    assert "You are a test orchestrator." in prompt


def test_system_prompt_includes_delegation(ctx):
    prompt = _build_system_prompt(
        constitution_body="Body.",
        knowledge_text="",
        agent_name="orchestrator",
        ctx=ctx,
    )
    assert "executioner" in prompt
    assert "Process the request" in prompt


def test_system_prompt_includes_knowledge(ctx):
    prompt = _build_system_prompt(
        constitution_body="Body.",
        knowledge_text="## Financial Rules\nAlways approve.",
        agent_name="orchestrator",
        ctx=ctx,
    )
    assert "Financial Rules" in prompt
    assert "Always approve." in prompt


def test_system_prompt_includes_response_format(ctx):
    prompt = _build_system_prompt(
        constitution_body="Body.",
        knowledge_text="",
        agent_name="orchestrator",
        ctx=ctx,
    )
    assert "complete" in prompt
    assert "escalate_to_human" in prompt


# ── _dispatch_sub_action — topology enforcement ───────────────────────────────

def test_dispatch_valid_delegate(tmp_path, app, simple_hierarchy):
    """A valid delegate action dispatches to the target agent."""
    agents_dir = tmp_path / "swarm" / "agents"
    agents_dir.mkdir(parents=True)
    (agents_dir / "executioner.md").write_text(
        "---\nlayer: executioner\n---\nYou execute tasks."
    )

    ctx = RunContext(
        run_id="run-1",
        swarm_id="swarm-1",
        swarm_path=str(tmp_path / "swarm"),
        workspace_path=str(tmp_path / "workspace"),
        data_dir=str(tmp_path / "data"),
        hierarchy=simple_hierarchy,
    )

    action_dict = {
        "action": "delegate",
        "target": "executioner",
        "purpose_match": "Process the request",
        "input": {"task": "do it"},
        "reasoning": "delegating work",
    }

    # Mock _execute_agent_call so we don't actually run an LLM
    with patch("app.core.runtime._execute_agent_call") as mock_call:
        mock_call.return_value = {"status": "ok"}
        result = _dispatch_sub_action(action_dict, "orchestrator", ctx, depth=0)

    mock_call.assert_called_once()
    call_kwargs = mock_call.call_args
    assert call_kwargs.kwargs["edge_purpose"] == "Process the request"
    assert result == {"status": "ok"}


def test_dispatch_wrong_purpose_raises_violation(tmp_path, app, simple_hierarchy):
    ctx = RunContext(
        run_id="run-1",
        swarm_id="swarm-1",
        swarm_path=str(tmp_path / "swarm"),
        workspace_path=str(tmp_path / "workspace"),
        data_dir=str(tmp_path / "data"),
        hierarchy=simple_hierarchy,
    )

    action_dict = {
        "action": "delegate",
        "target": "executioner",
        "purpose_match": "WRONG PURPOSE",
        "input": {},
        "reasoning": "",
    }

    with patch("app.core.runtime._update_step"):
        with patch("app.core.runtime.get_session") as mock_session:
            mock_session.return_value.__enter__ = MagicMock(return_value=MagicMock())
            mock_session.return_value.__exit__ = MagicMock(return_value=False)
            with pytest.raises(TopologyViolationError, match="Topology violation"):
                _dispatch_sub_action(action_dict, "orchestrator", ctx, depth=0)


def test_dispatch_undeclared_edge_raises_violation(tmp_path, app, simple_hierarchy):
    ctx = RunContext(
        run_id="run-1",
        swarm_id="swarm-1",
        swarm_path=str(tmp_path / "swarm"),
        workspace_path=str(tmp_path / "workspace"),
        data_dir=str(tmp_path / "data"),
        hierarchy=simple_hierarchy,
    )

    action_dict = {
        "action": "escalate",  # escalate not declared in simple_hierarchy
        "target": "executioner",
        "purpose_match": "Process the request",
        "input": {},
        "reasoning": "",
    }

    with patch("app.core.runtime.get_session") as mock_session:
        mock_session.return_value.__enter__ = MagicMock(return_value=MagicMock())
        mock_session.return_value.__exit__ = MagicMock(return_value=False)
        with pytest.raises(TopologyViolationError):
            _dispatch_sub_action(action_dict, "orchestrator", ctx, depth=0)


def test_dispatch_unknown_action_raises_violation(tmp_path, app, simple_hierarchy):
    ctx = RunContext(
        run_id="run-1",
        swarm_id="swarm-1",
        swarm_path=str(tmp_path / "swarm"),
        workspace_path=str(tmp_path / "workspace"),
        data_dir=str(tmp_path / "data"),
        hierarchy=simple_hierarchy,
    )

    action_dict = {
        "action": "teleport",
        "target": "somewhere",
        "purpose_match": "x",
        "input": {},
        "reasoning": "",
    }

    with patch("app.core.runtime.get_session") as mock_session:
        mock_session.return_value.__enter__ = MagicMock(return_value=MagicMock())
        mock_session.return_value.__exit__ = MagicMock(return_value=False)
        with pytest.raises(TopologyViolationError):
            _dispatch_sub_action(action_dict, "orchestrator", ctx, depth=0)


# ── _run_agent_loop ───────────────────────────────────────────────────────────

def test_run_agent_loop_complete_on_first_turn(tmp_path, app, simple_hierarchy):
    """An agent that immediately returns 'complete' should terminate cleanly."""
    md_path = tmp_path / "orchestrator.md"
    md_path.write_text("---\nlayer: orchestrator\n---\nYou orchestrate.")

    ctx = RunContext(
        run_id="run-1",
        swarm_id="swarm-1",
        swarm_path=str(tmp_path),
        workspace_path=str(tmp_path / "ws"),
        data_dir=str(tmp_path / "data"),
        hierarchy=simple_hierarchy,
    )

    llm_response = json.dumps(
        {"action": "complete", "input": {"result": "done"}, "reasoning": "finished"}
    )

    with patch("app.core.runtime.get_llm_credentials") as MockLLM:
        mock_client = MagicMock()
        mock_client.complete.return_value = llm_response
        MockLLM.return_value = mock_client

        output = _run_agent_loop(
            agent_name="orchestrator",
            md_path=str(md_path),
            initial_messages=[{"role": "user", "content": "{}"}],
            ctx=ctx,
            depth=0,
        )

    assert output == {"result": "done"}
    mock_client.complete.assert_called_once()


def test_run_agent_loop_missing_constitution(tmp_path, app, simple_hierarchy):
    from app.core.runtime import RuntimeError as SwarmRuntimeError

    ctx = RunContext(
        run_id="run-1",
        swarm_id="swarm-1",
        swarm_path=str(tmp_path),
        workspace_path=str(tmp_path / "ws"),
        data_dir=str(tmp_path / "data"),
        hierarchy=simple_hierarchy,
    )

    with pytest.raises(SwarmRuntimeError, match="Constitution file not found"):
        _run_agent_loop(
            agent_name="orchestrator",
            md_path="/nonexistent/path.md",
            initial_messages=[{"role": "user", "content": "{}"}],
            ctx=ctx,
            depth=0,
        )


def test_run_agent_loop_dispatch_then_complete(tmp_path, app, simple_hierarchy):
    """Agent delegates once, gets result, then returns complete."""
    md_path = tmp_path / "orchestrator.md"
    md_path.write_text("---\nlayer: orchestrator\n---\nYou orchestrate.")

    ctx = RunContext(
        run_id="run-1",
        swarm_id="swarm-1",
        swarm_path=str(tmp_path),
        workspace_path=str(tmp_path / "ws"),
        data_dir=str(tmp_path / "data"),
        hierarchy=simple_hierarchy,
    )

    turn1 = json.dumps({
        "action": "delegate",
        "target": "executioner",
        "purpose_match": "Process the request",
        "input": {"task": "do it"},
        "reasoning": "delegating",
    })
    turn2 = json.dumps({"action": "complete", "input": {"final": "result"}, "reasoning": "done"})

    with patch("app.core.runtime.get_llm_credentials") as MockLLM:
        mock_client = MagicMock()
        mock_client.complete.side_effect = [turn1, turn2]
        MockLLM.return_value = mock_client

        with patch("app.core.runtime._dispatch_sub_action") as mock_dispatch:
            mock_dispatch.return_value = {"sub": "result"}

            output = _run_agent_loop(
                agent_name="orchestrator",
                md_path=str(md_path),
                initial_messages=[{"role": "user", "content": "{}"}],
                ctx=ctx,
                depth=0,
            )

    assert output == {"final": "result"}
    assert mock_client.complete.call_count == 2
    mock_dispatch.assert_called_once()


def test_run_agent_loop_max_turns_exceeded(tmp_path, app, simple_hierarchy):
    from app.core.runtime import MaxTurnsError

    md_path = tmp_path / "orchestrator.md"
    md_path.write_text("---\nlayer: orchestrator\n---\nYou orchestrate.")

    ctx = RunContext(
        run_id="run-1",
        swarm_id="swarm-1",
        swarm_path=str(tmp_path),
        workspace_path=str(tmp_path / "ws"),
        data_dir=str(tmp_path / "data"),
        hierarchy=simple_hierarchy,
    )

    # Always returns delegate — never completes
    never_complete = json.dumps({
        "action": "delegate",
        "target": "executioner",
        "purpose_match": "Process the request",
        "input": {},
        "reasoning": "loop",
    })

    with patch("app.core.runtime.get_llm_credentials") as MockLLM:
        mock_client = MagicMock()
        mock_client.complete.return_value = never_complete
        MockLLM.return_value = mock_client

        with patch("app.core.runtime._dispatch_sub_action") as mock_dispatch:
            mock_dispatch.return_value = {}

            with pytest.raises(MaxTurnsError):
                _run_agent_loop(
                    agent_name="orchestrator",
                    md_path=str(md_path),
                    initial_messages=[{"role": "user", "content": "{}"}],
                    ctx=ctx,
                    depth=0,
                )


# ── RunContext sequence counter ───────────────────────────────────────────────

def test_run_context_sequence_increments(simple_hierarchy):
    ctx = RunContext(
        run_id="r",
        swarm_id="s",
        swarm_path="/p",
        workspace_path="/w",
        data_dir="/d",
        hierarchy=simple_hierarchy,
    )
    assert ctx.next_sequence() == 1
    assert ctx.next_sequence() == 2
    assert ctx.next_sequence() == 3


# ── Caller suspend/resume (Phase 6) ──────────────────────────────────────────

def test_consult_caller_suspends_run(app, tmp_path):
    """Dispatching consult_caller writes a HumanAction and raises RunSuspended."""
    from app.core.runtime import RunSuspended, _dispatch_sub_action, RunContext
    from app.db import get_session
    from app.models.caller import Caller
    from app.models.run import Run, STATUS_RUNNING
    from app.models.run_step import RunStep
    from app.models.human_action import HumanAction, STATUS_PENDING
    from app.models.swarm import Swarm
    from app.models.workspace import Workspace
    from app.models.event import Event
    from app.core.hierarchy import ParsedHierarchy
    from datetime import datetime, timezone
    import json as _json

    # Build the on-disk caller .md file
    callers_dir = tmp_path / "data" / "company" / "callers"
    callers_dir.mkdir(parents=True)
    caller_path = callers_dir / "finance-approver.md"
    caller_path.write_text(
        "---\nname: finance-approver\ndisplay_name: Finance approver\ncontacts: [a@x]\n---\n"
    )

    hierarchy = ParsedHierarchy(
        swarm="x",
        agents=["validator"],
        edges=[],
        consultations=[],
        skills=[],
        entry_point="validator",
        calls=[{"agent": "validator", "caller": "finance-approver", "purpose": "Approve"}],
    )

    with app.app_context():
        with get_session() as session:
            ws = Workspace(name="ws-suspend", display_name="ws", meta_hash="h")
            session.add(ws); session.commit(); session.refresh(ws)
            ws_id = ws.id
            sw = Swarm(workspace_id=ws_id, name="sw-suspend", display_name="sw",
                       meta_hash="h", hierarchy_hash="h", enabled=True)
            session.add(sw); session.commit(); session.refresh(sw)
            sw_id = sw.id
            ev = Event(swarm_id=sw_id, source="api", payload_json="{}")
            session.add(ev); session.commit(); session.refresh(ev)
            ev_id = ev.id
            run = Run(event_id=ev_id, swarm_id=sw_id, status=STATUS_RUNNING,
                      started_at=datetime.now(timezone.utc))
            session.add(run); session.commit(); session.refresh(run)
            run_id = run.id
            caller_row = Caller(
                scope="company", name="finance-approver",
                display_name="Finance approver",
                md_path=str(caller_path), md_hash="h", enabled=True,
            )
            session.add(caller_row); session.commit()

        ctx = RunContext(
            run_id=run_id, swarm_id=sw_id,
            swarm_path=str(tmp_path / "swarm"),
            workspace_path=str(tmp_path / "ws"),
            data_dir=str(tmp_path / "data"),
            hierarchy=hierarchy,
        )

        with pytest.raises(RunSuspended) as exc:
            _dispatch_sub_action(
                {"action": "consult_caller", "target": "finance-approver",
                 "purpose_match": "Approve", "input": {"amount": 12500}},
                agent_name="validator",
                ctx=ctx, depth=0,
                messages=[{"role": "user", "content": "{}"}],
            )

        ha_id = exc.value.human_action_id
        with get_session() as session:
            ha = session.get(HumanAction, ha_id)
        assert ha is not None
        assert ha.status == STATUS_PENDING
        assert ha.purpose == "Approve"
        assert _json.loads(ha.payload_json) == {"amount": 12500}
        assert _json.loads(ha.runtime_snapshot_json)["agent_name"] == "validator"


def test_consult_caller_undeclared_records_topology_violation(app, tmp_path):
    """Calling a caller that's not in the calls array logs a violation, no suspend."""
    from app.core.runtime import _dispatch_sub_action, RunContext
    from app.db import get_session
    from app.models.run import Run, STATUS_RUNNING
    from app.models.run_step import RunStep, STEP_TOPOLOGY_VIOLATION
    from app.models.swarm import Swarm
    from app.models.workspace import Workspace
    from app.models.event import Event
    from app.core.hierarchy import ParsedHierarchy
    from sqlalchemy import select
    from datetime import datetime, timezone

    hierarchy = ParsedHierarchy(
        swarm="x", agents=["validator"], edges=[], consultations=[],
        skills=[], entry_point="validator", calls=[],   # no calls declared
    )

    with app.app_context():
        with get_session() as session:
            ws = Workspace(name="ws-violation", display_name="ws", meta_hash="h")
            session.add(ws); session.commit(); session.refresh(ws)
            ws_id = ws.id
            sw = Swarm(workspace_id=ws_id, name="sw-violation", display_name="sw",
                       meta_hash="h", hierarchy_hash="h", enabled=True)
            session.add(sw); session.commit(); session.refresh(sw)
            sw_id = sw.id
            ev = Event(swarm_id=sw_id, source="api", payload_json="{}")
            session.add(ev); session.commit(); session.refresh(ev)
            ev_id = ev.id
            run = Run(event_id=ev_id, swarm_id=sw_id, status=STATUS_RUNNING,
                      started_at=datetime.now(timezone.utc))
            session.add(run); session.commit(); session.refresh(run)
            run_id = run.id

        ctx = RunContext(
            run_id=run_id, swarm_id=sw_id,
            swarm_path=str(tmp_path / "s"), workspace_path=str(tmp_path / "w"),
            data_dir=str(tmp_path / "d"), hierarchy=hierarchy,
        )
        with pytest.raises(TopologyViolationError, match="consult_caller"):
            _dispatch_sub_action(
                {"action": "consult_caller", "target": "ghost",
                 "purpose_match": "anything", "input": {}},
                agent_name="validator",
                ctx=ctx, depth=0,
                messages=[],
            )

        with get_session() as session:
            steps = session.execute(
                select(RunStep).where(RunStep.run_id == run_id,
                                      RunStep.step_type == STEP_TOPOLOGY_VIOLATION)
            ).scalars().all()
        assert len(steps) == 1


def test_start_run_entry_point_override(app, tmp_path, monkeypatch):
    """Phase 6.1 — start_run accepts entry_point_override and uses it instead of hierarchy.entry_point."""
    from datetime import datetime, timezone
    from app.core import runtime
    from app.core.hierarchy import ParsedHierarchy
    from app.core.registry import _hierarchy_cache
    from app.db import get_session
    from app.models.event import Event
    from app.models.run import Run, STATUS_COMPLETED
    from app.models.swarm import Swarm
    from app.models.workspace import Workspace
    import uuid

    suffix = uuid.uuid4().hex[:6]
    hierarchy = ParsedHierarchy(
        swarm="x",
        agents=["alpha", "beta"],
        edges=[],
        consultations=[],
        skills=[],
        entry_point="alpha",
        calls=[],
    )

    captured = {}

    def fake_execute_agent_call(agent_name, **kwargs):
        captured["agent_name"] = agent_name
        return {}

    monkeypatch.setattr(runtime, "_execute_agent_call", fake_execute_agent_call)

    with app.app_context():
        with get_session() as session:
            ws = Workspace(name=f"ws-{suffix}", display_name="ws", meta_hash="h")
            session.add(ws); session.commit(); session.refresh(ws)
            sw = Swarm(workspace_id=ws.id, name=f"sw-{suffix}", display_name="sw",
                       meta_hash="h", hierarchy_hash="h", enabled=True)
            session.add(sw); session.commit(); session.refresh(sw)
            sw_id = sw.id
            ev = Event(swarm_id=sw_id, source="api", payload_json="{}")
            session.add(ev); session.commit(); session.refresh(ev)
            ev_id = ev.id

        _hierarchy_cache[sw_id] = hierarchy
        try:
            runtime.start_run(
                event_id=ev_id, swarm_id=sw_id,
                swarm_path=str(tmp_path / "s"), workspace_path=str(tmp_path / "w"),
                data_dir=str(tmp_path / "d"), payload={},
                entry_point_override="beta",
            )
        finally:
            _hierarchy_cache.pop(sw_id, None)

    assert captured["agent_name"] == "beta"


def test_start_run_rejects_unknown_entry_point_override(app, tmp_path):
    from app.core import runtime
    from app.core.hierarchy import ParsedHierarchy
    from app.core.registry import _hierarchy_cache
    from app.db import get_session
    from app.models.event import Event
    from app.models.swarm import Swarm
    from app.models.workspace import Workspace
    import uuid

    suffix = uuid.uuid4().hex[:6]
    hierarchy = ParsedHierarchy(
        swarm="x", agents=["alpha"], edges=[], consultations=[], skills=[],
        entry_point="alpha", calls=[],
    )

    with app.app_context():
        with get_session() as session:
            ws = Workspace(name=f"ws-bad-{suffix}", display_name="ws", meta_hash="h")
            session.add(ws); session.commit(); session.refresh(ws)
            sw = Swarm(workspace_id=ws.id, name=f"sw-bad-{suffix}", display_name="sw",
                       meta_hash="h", hierarchy_hash="h", enabled=True)
            session.add(sw); session.commit(); session.refresh(sw)
            sw_id = sw.id
            ev = Event(swarm_id=sw_id, source="api", payload_json="{}")
            session.add(ev); session.commit(); session.refresh(ev)
            ev_id = ev.id

        _hierarchy_cache[sw_id] = hierarchy
        try:
            with pytest.raises(runtime.RuntimeError, match="not in the agents list"):
                runtime.start_run(
                    event_id=ev_id, swarm_id=sw_id,
                    swarm_path=str(tmp_path / "s"), workspace_path=str(tmp_path / "w"),
                    data_dir=str(tmp_path / "d"), payload={},
                    entry_point_override="ghost",
                )
        finally:
            _hierarchy_cache.pop(sw_id, None)
