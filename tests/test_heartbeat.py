"""Tests for app/core/heartbeat.py — scheduler registration and tick execution (item 9)."""
from __future__ import annotations

import json
import os
import textwrap
import uuid
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import select

from app.core.heartbeat import _fire_heartbeat, register_all_heartbeats
from app.db import get_session
from app.models.swarm import Swarm
from app.models.trigger import KIND_HEARTBEAT, Trigger
from app.models.workspace import Workspace


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


@pytest.fixture()
def workspace_and_swarm(app):
    """Seed a workspace + swarm row and return their IDs. Uses unique names to avoid conflicts."""
    ws_name = _unique("hb-ws")
    swarm_name = _unique("hb-swarm")
    with app.app_context():
        with get_session() as session:
            ws = Workspace(name=ws_name, display_name="HB Workspace")
            session.add(ws)
            session.commit()
            session.refresh(ws)
            ws_id = ws.id

            swarm = Swarm(
                workspace_id=ws_id,
                name=swarm_name,
                display_name="HB Swarm",
            )
            session.add(swarm)
            session.commit()
            session.refresh(swarm)
            swarm_id = swarm.id

    return ws_id, swarm_id, ws_name, swarm_name


def _make_trigger(swarm_id: str, config: dict, *, enabled: bool = True, name: str = "tick") -> Trigger:
    return Trigger(
        swarm_id=swarm_id,
        name=name,
        kind=KIND_HEARTBEAT,
        config_json=json.dumps(config),
        enabled=enabled,
    )


# ── Item 9: register_all_heartbeats wires scheduler ──────────────────────────

def test_register_all_heartbeats_wires_job(app, workspace_and_swarm):
    """Item 9 — register_all_heartbeats registers one APScheduler job per trigger."""
    _, swarm_id, _, _ = workspace_and_swarm
    config = {"schedule": "* * * * *", "script": "tick.py"}

    with app.app_context():
        with get_session() as session:
            trigger = _make_trigger(swarm_id, config, name=_unique("tick"))
            session.add(trigger)
            session.commit()
            session.refresh(trigger)
            trigger_id = trigger.id

        mock_bus = MagicMock()
        # register_heartbeat is imported lazily inside register_all_heartbeats —
        # patch it at the scheduler module level so the local import picks up the mock.
        with patch("app.scheduler.register_heartbeat") as mock_reg:
            register_all_heartbeats(app, mock_bus, data_dir="/data")

    # At least one registration happened with our trigger_id
    call_ids = [call[0][0] for call in mock_reg.call_args_list]
    assert trigger_id in call_ids
    matching = [c for c in mock_reg.call_args_list if c[0][0] == trigger_id]
    assert matching[0][0][1] == "* * * * *"


def test_register_all_heartbeats_skips_disabled(app, workspace_and_swarm):
    """Disabled heartbeat triggers are not registered."""
    _, swarm_id, _, _ = workspace_and_swarm
    config = {"schedule": "0 * * * *", "script": "tick.py"}

    with app.app_context():
        with get_session() as session:
            trigger = _make_trigger(swarm_id, config, enabled=False, name=_unique("dis"))
            session.add(trigger)
            session.commit()
            trigger_id = trigger.id

        mock_bus = MagicMock()
        with patch("app.scheduler.register_heartbeat") as mock_reg:
            register_all_heartbeats(app, mock_bus, data_dir="/data")

    call_ids = [call[0][0] for call in mock_reg.call_args_list]
    assert trigger_id not in call_ids


def test_register_all_heartbeats_skips_missing_schedule(app, workspace_and_swarm):
    """Triggers without 'schedule' key are silently skipped."""
    _, swarm_id, _, _ = workspace_and_swarm
    config = {"script": "tick.py"}  # no schedule

    with app.app_context():
        with get_session() as session:
            trigger = _make_trigger(swarm_id, config, name=_unique("nos"))
            session.add(trigger)
            session.commit()
            trigger_id = trigger.id

        mock_bus = MagicMock()
        with patch("app.scheduler.register_heartbeat") as mock_reg:
            register_all_heartbeats(app, mock_bus, data_dir="/data")

    call_ids = [call[0][0] for call in mock_reg.call_args_list]
    assert trigger_id not in call_ids


def test_register_all_heartbeats_skips_missing_script(app, workspace_and_swarm):
    """Triggers without 'script' key are silently skipped."""
    _, swarm_id, _, _ = workspace_and_swarm
    config = {"schedule": "0 * * * *"}  # no script

    with app.app_context():
        with get_session() as session:
            trigger = _make_trigger(swarm_id, config, name=_unique("noscr"))
            session.add(trigger)
            session.commit()
            trigger_id = trigger.id

        mock_bus = MagicMock()
        with patch("app.scheduler.register_heartbeat") as mock_reg:
            register_all_heartbeats(app, mock_bus, data_dir="/data")

    call_ids = [call[0][0] for call in mock_reg.call_args_list]
    assert trigger_id not in call_ids


# ── _fire_heartbeat — tick execution ─────────────────────────────────────────

@pytest.fixture()
def heartbeat_setup(app, workspace_and_swarm, tmp_path):
    """Returns (trigger_id, swarm_id, scripts_dir) with a DB-persisted trigger."""
    _, swarm_id, _, _ = workspace_and_swarm
    scripts_dir = tmp_path / "triggers"
    scripts_dir.mkdir()

    with app.app_context():
        with get_session() as session:
            trigger = Trigger(
                swarm_id=swarm_id,
                name=_unique("fire-tick"),
                kind=KIND_HEARTBEAT,
                config_json="{}",
                enabled=True,
            )
            session.add(trigger)
            session.commit()
            session.refresh(trigger)
            trigger_id = trigger.id

    return trigger_id, swarm_id, str(scripts_dir)


def _write_script(scripts_dir: str, name: str, source: str) -> str:
    path = os.path.join(scripts_dir, name)
    with open(path, "w") as f:
        f.write(textwrap.dedent(source))
    return path


def test_fire_heartbeat_persists_events(app, heartbeat_setup):
    """A heartbeat script that returns events causes Event rows in the DB."""
    from app.models.event import Event

    trigger_id, swarm_id, scripts_dir = heartbeat_setup
    script_path = _write_script(scripts_dir, "tick.py", """
        import sys, json
        watermark = sys.argv[1] if len(sys.argv) > 1 else ""
        print(json.dumps({
            "watermark": "mark-1",
            "events": [{"type": "invoice.created", "payload": {"id": 42}}]
        }))
    """)

    mock_bus = MagicMock()
    with app.app_context():
        _fire_heartbeat(
            event_bus=mock_bus,
            trigger_id=trigger_id,
            swarm_id=swarm_id,
            script_path=script_path,
            timeout=10,
        )
        with get_session() as session:
            events = session.execute(
                select(Event).where(
                    Event.swarm_id == swarm_id,
                    Event.trigger_id == trigger_id,
                    Event.source == "heartbeat",
                )
            ).scalars().all()
            trigger = session.get(Trigger, trigger_id)
            watermark = trigger.watermark

    assert len(events) == 1
    assert watermark == "mark-1"
    mock_bus.publish.assert_called_once()


def test_fire_heartbeat_no_output_ok(app, heartbeat_setup):
    """A script that produces no output is a no-op (no events, no error)."""
    trigger_id, swarm_id, scripts_dir = heartbeat_setup
    script_path = _write_script(scripts_dir, "silent.py", """
        pass  # no output = no events
    """)

    mock_bus = MagicMock()
    with app.app_context():
        _fire_heartbeat(
            event_bus=mock_bus,
            trigger_id=trigger_id,
            swarm_id=swarm_id,
            script_path=script_path,
            timeout=10,
        )

    mock_bus.publish.assert_not_called()


def test_fire_heartbeat_missing_script_skips(app, heartbeat_setup):
    """If the script file is missing, _fire_heartbeat does nothing."""
    trigger_id, swarm_id, scripts_dir = heartbeat_setup
    missing_path = os.path.join(scripts_dir, "does-not-exist.py")

    mock_bus = MagicMock()
    with app.app_context():
        _fire_heartbeat(
            event_bus=mock_bus,
            trigger_id=trigger_id,
            swarm_id=swarm_id,
            script_path=missing_path,
            timeout=10,
        )

    mock_bus.publish.assert_not_called()


def test_fire_heartbeat_watermark_passed_to_script(app, heartbeat_setup):
    """The current watermark is passed as argv[1] to the heartbeat script."""
    from app.models.event import Event

    trigger_id, swarm_id, scripts_dir = heartbeat_setup

    # Seed an initial watermark
    with app.app_context():
        with get_session() as session:
            trigger = session.get(Trigger, trigger_id)
            trigger.watermark = "initial-mark"
            session.commit()

    script_path = _write_script(scripts_dir, "echo_wm.py", """
        import sys, json
        watermark = sys.argv[1] if len(sys.argv) > 1 else ""
        print(json.dumps({
            "watermark": watermark + "-next",
            "events": [{"type": "tick", "payload": {"received_watermark": watermark}}]
        }))
    """)

    mock_bus = MagicMock()
    with app.app_context():
        _fire_heartbeat(
            event_bus=mock_bus,
            trigger_id=trigger_id,
            swarm_id=swarm_id,
            script_path=script_path,
            timeout=10,
        )
        with get_session() as session:
            trigger = session.get(Trigger, trigger_id)
            new_watermark = trigger.watermark
            events = session.execute(
                select(Event).where(
                    Event.swarm_id == swarm_id,
                    Event.trigger_id == trigger_id,
                )
            ).scalars().all()
            payload = json.loads(events[-1].payload_json)

    assert new_watermark == "initial-mark-next"
    assert payload.get("received_watermark") == "initial-mark"
