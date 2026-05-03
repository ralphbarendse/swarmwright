"""Tests for /api/v1/callers, /api/v1/informers, /api/v1/inbox, /api/v1/informs — Phase 6 / 6.1."""
from __future__ import annotations

import json
import os

import pytest
from sqlalchemy import select

from app.db import get_session
from app.models.caller import Caller
from app.models.human_action import HumanAction, STATUS_PENDING, STATUS_YES, STATUS_NO
from app.models.informer import Informer
from app.models.human_inform import HumanInform, STATUS_UNREAD, STATUS_READ, STATUS_DISMISSED


# ── Caller CRUD ──────────────────────────────────────────────────────────────

class TestCallerCRUD:
    def test_create_company_caller(self, client, app, data_dir):
        r = client.post("/api/v1/callers", json={
            "scope": "company",
            "name": "fin-app",
            "display_name": "Finance approver",
            "contacts": ["a@x"],
            "body": "Approve big invoices.",
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body["name"] == "fin-app"
        assert body["display_name"] == "Finance approver"
        assert "Approve big invoices" in body["body"]

        assert os.path.isfile(os.path.join(data_dir, "company", "callers", "fin-app.md"))

    def test_create_with_invalid_name_rejected(self, client, app):
        r = client.post("/api/v1/callers", json={
            "scope": "company",
            "name": "Invalid--Name",
            "display_name": "x",
            "contacts": ["a@x"],
        })
        assert r.status_code == 400

    def test_create_duplicate_returns_conflict(self, client, app):
        for _ in range(2):
            r = client.post("/api/v1/callers", json={
                "scope": "company", "name": "dup-call",
                "display_name": "D", "contacts": ["a@x"],
            })
        assert r.status_code == 409

    def test_get_caller_returns_body_and_contacts(self, client, app):
        client.post("/api/v1/callers", json={
            "scope": "company", "name": "review",
            "display_name": "Reviewer", "contacts": ["r@x", "s@x"],
            "body": "What I review.",
        })
        r = client.get("/api/v1/callers/review?scope=company")
        assert r.status_code == 200
        body = r.get_json()
        assert body["contacts"] == ["r@x", "s@x"]
        assert "What I review." in body["body"]

    def test_list_callers_filters_by_scope(self, client, app):
        client.post("/api/v1/callers", json={
            "scope": "company", "name": "list-a",
            "display_name": "A", "contacts": ["a@x"],
        })
        r = client.get("/api/v1/callers?scope=company")
        assert r.status_code == 200
        names = [c["name"] for c in r.get_json()]
        assert "list-a" in names

    def test_delete_caller(self, client, app, data_dir):
        client.post("/api/v1/callers", json={
            "scope": "company", "name": "del-me",
            "display_name": "X", "contacts": ["a@x"],
        })
        path = os.path.join(data_dir, "company", "callers", "del-me.md")
        assert os.path.isfile(path)
        r = client.delete("/api/v1/callers/del-me?scope=company")
        assert r.status_code == 200
        assert not os.path.isfile(path)


# ── Informer CRUD ─────────────────────────────────────────────────────────────

class TestInformerCRUD:
    def test_create_company_informer(self, client, app, data_dir):
        r = client.post("/api/v1/informers", json={
            "scope": "company",
            "name": "ops-team",
            "display_name": "Operations team",
            "contacts": ["ops@x"],
            "body": "Notified on payment events.",
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body["name"] == "ops-team"
        assert body["display_name"] == "Operations team"
        assert "payment events" in body["body"]
        assert os.path.isfile(os.path.join(data_dir, "company", "informers", "ops-team.md"))

    def test_create_with_invalid_name_rejected(self, client, app):
        r = client.post("/api/v1/informers", json={
            "scope": "company",
            "name": "Bad Name",
            "display_name": "x",
            "contacts": [],
        })
        assert r.status_code == 400

    def test_create_duplicate_returns_conflict(self, client, app):
        for _ in range(2):
            r = client.post("/api/v1/informers", json={
                "scope": "company", "name": "dup-inf",
                "display_name": "D", "contacts": [],
            })
        assert r.status_code == 409

    def test_get_informer_returns_body_and_contacts(self, client, app):
        client.post("/api/v1/informers", json={
            "scope": "company", "name": "inf-review",
            "display_name": "Reviewer", "contacts": ["r@x"],
            "body": "FYI context.",
        })
        r = client.get("/api/v1/informers/inf-review?scope=company")
        assert r.status_code == 200
        body = r.get_json()
        assert body["contacts"] == ["r@x"]
        assert "FYI context" in body["body"]

    def test_list_informers_filters_by_scope(self, client, app):
        client.post("/api/v1/informers", json={
            "scope": "company", "name": "list-inf",
            "display_name": "A", "contacts": [],
        })
        r = client.get("/api/v1/informers?scope=company")
        assert r.status_code == 200
        names = [c["name"] for c in r.get_json()]
        assert "list-inf" in names

    def test_delete_informer(self, client, app, data_dir):
        client.post("/api/v1/informers", json={
            "scope": "company", "name": "del-inf",
            "display_name": "X", "contacts": [],
        })
        path = os.path.join(data_dir, "company", "informers", "del-inf.md")
        assert os.path.isfile(path)
        r = client.delete("/api/v1/informers/del-inf?scope=company")
        assert r.status_code == 200
        assert not os.path.isfile(path)


# ── Inbox (blocking calls) ───────────────────────────────────────────────────

@pytest.fixture()
def pending_human_action(app):
    """Insert a pending HumanAction directly (skipping the runtime path)."""
    from datetime import datetime, timezone
    from app.models.event import Event
    from app.models.run import Run, STATUS_RUNNING, STATUS_AWAITING_HUMAN
    from app.models.run_step import RunStep, STEP_CALLER_CALL
    from app.models.swarm import Swarm
    from app.models.workspace import Workspace

    import uuid
    suffix = uuid.uuid4().hex[:8]
    with app.app_context():
        with get_session() as session:
            ws = Workspace(name=f"ws-inbox-{suffix}", display_name="ws", meta_hash="h")
            session.add(ws); session.commit(); session.refresh(ws)
            sw = Swarm(workspace_id=ws.id, name=f"sw-inbox-{suffix}", display_name="sw",
                       meta_hash="h", hierarchy_hash="h", enabled=True)
            session.add(sw); session.commit(); session.refresh(sw)
            ev = Event(swarm_id=sw.id, source="api", payload_json="{}")
            session.add(ev); session.commit(); session.refresh(ev)
            run = Run(event_id=ev.id, swarm_id=sw.id,
                      status=STATUS_AWAITING_HUMAN,
                      started_at=datetime.now(timezone.utc))
            session.add(run); session.commit(); session.refresh(run)

            caller = Caller(
                scope="company", name=f"ix-finapp-{suffix}",
                display_name="Inbox finance approver",
                md_path="/dev/null", md_hash="x", enabled=True,
            )
            session.add(caller); session.commit(); session.refresh(caller)

            step = RunStep(
                run_id=run.id, agent_id=None, step_type=STEP_CALLER_CALL,
                step_name="ix-finapp", edge_purpose="Approve big invoice",
                caller_id=caller.id,
                input_json='{"amount": 12500}', sequence=1,
                started_at=datetime.now(timezone.utc),
            )
            session.add(step); session.commit(); session.refresh(step)

            ha = HumanAction(
                run_id=run.id, step_id=step.id, caller_id=caller.id,
                purpose="Approve big invoice",
                payload_json='{"amount": 12500}',
                runtime_snapshot_json=json.dumps({
                    "agent_name": "validator",
                    "messages": [{"role": "user", "content": "{}"}],
                    "depth": 0,
                }),
                status=STATUS_PENDING,
            )
            session.add(ha); session.commit(); session.refresh(ha)
            return ha.id


class TestInbox:
    def test_list_pending(self, client, app, pending_human_action):
        r = client.get("/api/v1/inbox")
        assert r.status_code == 200
        items = r.get_json()
        assert any(i["id"] == pending_human_action for i in items)

    def test_get_item_includes_caller_briefing(self, client, app, pending_human_action):
        r = client.get(f"/api/v1/inbox/{pending_human_action}")
        assert r.status_code == 200
        body = r.get_json()
        assert body["status"] == "pending"
        assert body["caller_display_name"] == "Inbox finance approver"
        assert body["purpose"] == "Approve big invoice"

    def test_decide_yes_marks_yes(self, client, app, pending_human_action, monkeypatch):
        from app.core import runtime
        called = {}
        monkeypatch.setattr(runtime, "resume_run", lambda ha_id: called.setdefault("id", ha_id))

        r = client.post(
            f"/api/v1/inbox/{pending_human_action}/decide",
            json={"decision": "yes", "reason": "ok", "amend": {"amount": 12500, "po": "PO-1"}},
        )
        assert r.status_code == 200
        with app.app_context():
            with get_session() as session:
                row = session.get(HumanAction, pending_human_action)
        assert row.status == STATUS_YES
        assert row.decision_reason == "ok"
        assert json.loads(row.amend_json) == {"amount": 12500, "po": "PO-1"}
        assert called["id"] == pending_human_action

    def test_decide_no_marks_no(self, client, app, pending_human_action, monkeypatch):
        from app.core import runtime
        monkeypatch.setattr(runtime, "resume_run", lambda ha_id: None)

        r = client.post(
            f"/api/v1/inbox/{pending_human_action}/decide",
            json={"decision": "no", "reason": "missing PO"},
        )
        assert r.status_code == 200
        with app.app_context():
            with get_session() as session:
                row = session.get(HumanAction, pending_human_action)
        assert row.status == STATUS_NO

    def test_decide_no_with_amend(self, client, app, pending_human_action, monkeypatch):
        from app.core import runtime
        monkeypatch.setattr(runtime, "resume_run", lambda ha_id: None)

        r = client.post(
            f"/api/v1/inbox/{pending_human_action}/decide",
            json={"decision": "no", "amend": {"corrected_amount": 9000}, "reason": "over budget"},
        )
        assert r.status_code == 200
        with app.app_context():
            with get_session() as session:
                row = session.get(HumanAction, pending_human_action)
        assert row.status == STATUS_NO
        assert json.loads(row.amend_json) == {"corrected_amount": 9000}

    def test_decide_invalid_decision_rejected(self, client, app, pending_human_action):
        r = client.post(
            f"/api/v1/inbox/{pending_human_action}/decide",
            json={"decision": "maybe"},
        )
        assert r.status_code == 400

    def test_decide_twice_conflict(self, client, app, pending_human_action, monkeypatch):
        from app.core import runtime
        monkeypatch.setattr(runtime, "resume_run", lambda ha_id: None)
        client.post(f"/api/v1/inbox/{pending_human_action}/decide", json={"decision": "yes"})
        r = client.post(f"/api/v1/inbox/{pending_human_action}/decide", json={"decision": "yes"})
        assert r.status_code == 409

    def test_decide_no_amend_leaves_amend_json_null(self, client, app, pending_human_action, monkeypatch):
        from app.core import runtime
        monkeypatch.setattr(runtime, "resume_run", lambda ha_id: None)
        r = client.post(
            f"/api/v1/inbox/{pending_human_action}/decide",
            json={"decision": "yes"},
        )
        assert r.status_code == 200
        with app.app_context():
            with get_session() as session:
                row = session.get(HumanAction, pending_human_action)
        assert row.amend_json is None


# ── Informs (non-blocking) ───────────────────────────────────────────────────

@pytest.fixture()
def pending_human_inform(app):
    """Insert a pending HumanInform directly (skipping the runtime path)."""
    from datetime import datetime, timezone
    from app.models.event import Event
    from app.models.run import Run, STATUS_RUNNING
    from app.models.run_step import RunStep, STEP_INFORMER_NOTIFY
    from app.models.swarm import Swarm
    from app.models.workspace import Workspace

    import uuid
    suffix = uuid.uuid4().hex[:8]
    with app.app_context():
        with get_session() as session:
            ws = Workspace(name=f"ws-inf-{suffix}", display_name="ws", meta_hash="h")
            session.add(ws); session.commit(); session.refresh(ws)
            sw = Swarm(workspace_id=ws.id, name=f"sw-inf-{suffix}", display_name="sw",
                       meta_hash="h", hierarchy_hash="h", enabled=True)
            session.add(sw); session.commit(); session.refresh(sw)
            ev = Event(swarm_id=sw.id, source="api", payload_json="{}")
            session.add(ev); session.commit(); session.refresh(ev)
            run = Run(event_id=ev.id, swarm_id=sw.id, status=STATUS_RUNNING,
                      started_at=datetime.now(timezone.utc))
            session.add(run); session.commit(); session.refresh(run)

            informer = Informer(
                scope="company", name=f"ops-{suffix}",
                display_name="Ops team",
                md_path="/dev/null", md_hash="x", enabled=True,
            )
            session.add(informer); session.commit(); session.refresh(informer)

            step = RunStep(
                run_id=run.id, agent_id=None, step_type=STEP_INFORMER_NOTIFY,
                step_name=f"ops-{suffix}", edge_purpose="Notify on payment",
                informer_id=informer.id,
                input_json='{"amount": 500}', sequence=1,
                started_at=datetime.now(timezone.utc),
                ended_at=datetime.now(timezone.utc),
            )
            session.add(step); session.commit(); session.refresh(step)

            hi = HumanInform(
                run_id=run.id, step_id=step.id, informer_id=informer.id,
                purpose="Notify on payment",
                payload_json='{"amount": 500}',
                status=STATUS_UNREAD,
            )
            session.add(hi); session.commit(); session.refresh(hi)
            return hi.id


class TestInforms:
    def test_list_unread(self, client, app, pending_human_inform):
        r = client.get("/api/v1/informs")
        assert r.status_code == 200
        items = r.get_json()
        assert any(i["id"] == pending_human_inform for i in items)

    def test_get_inform_item(self, client, app, pending_human_inform):
        r = client.get(f"/api/v1/informs/{pending_human_inform}")
        assert r.status_code == 200
        body = r.get_json()
        assert body["status"] == "unread"
        assert body["purpose"] == "Notify on payment"

    def test_read_marks_read(self, client, app, pending_human_inform):
        r = client.post(f"/api/v1/informs/{pending_human_inform}/read", json={})
        assert r.status_code == 200
        with app.app_context():
            with get_session() as session:
                row = session.get(HumanInform, pending_human_inform)
        assert row.status == STATUS_READ

    def test_dismiss_marks_dismissed(self, client, app, pending_human_inform):
        r = client.post(f"/api/v1/informs/{pending_human_inform}/dismiss", json={})
        assert r.status_code == 200
        with app.app_context():
            with get_session() as session:
                row = session.get(HumanInform, pending_human_inform)
        assert row.status == STATUS_DISMISSED

    def test_read_twice_conflict(self, client, app, pending_human_inform):
        client.post(f"/api/v1/informs/{pending_human_inform}/read", json={})
        r = client.post(f"/api/v1/informs/{pending_human_inform}/read", json={})
        assert r.status_code == 409
