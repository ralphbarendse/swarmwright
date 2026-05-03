"""Tests for trigger API endpoints — listener and invocation routes."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest


# ── Helpers ───────────────────────────────────────────────────────────────────

def _create_workspace_and_swarm(client):
    ws = client.post(
        "/api/v1/workspaces",
        json={"display_name": "Finance"},
        content_type="application/json",
    )
    ws_id = ws.get_json()["id"]

    sw = client.post(
        f"/api/v1/workspaces/{ws_id}/swarms",
        json={"display_name": "Invoice Intake"},
        content_type="application/json",
    )
    return ws_id, sw.get_json()["id"]


# ── Listener endpoint ─────────────────────────────────────────────────────────

class TestListenerWebhook:
    def test_listener_fires_event(self, client, app):
        _, swarm_id = _create_workspace_and_swarm(client)

        # Create a listener trigger
        resp = client.post(
            f"/api/v1/swarms/{swarm_id}/triggers",
            json={
                "name": "invoice-hook",
                "kind": "listener",
                "config": {"endpoint": "invoice-hook"},
                "enabled": True,
            },
            content_type="application/json",
        )
        assert resp.status_code == 201

        with patch.object(app.event_bus, "publish") as mock_pub:
            resp = client.post(
                "/api/v1/triggers/listener/invoice-hook",
                json={"type": "invoice.received", "amount": 1500},
                content_type="application/json",
            )
        assert resp.status_code == 202
        data = resp.get_json()
        assert "event_id" in data
        mock_pub.assert_called_once()

    def test_listener_not_found(self, client):
        resp = client.post(
            "/api/v1/triggers/listener/nonexistent-hook",
            json={},
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_listener_secret_required(self, client, app):
        _, swarm_id = _create_workspace_and_swarm(client)

        client.post(
            f"/api/v1/swarms/{swarm_id}/triggers",
            json={
                "name": "secure-hook",
                "kind": "listener",
                "config": {"endpoint": "secure-hook", "secret": "s3cr3t"},
                "enabled": True,
            },
            content_type="application/json",
        )

        # Without secret — should fail
        resp = client.post(
            "/api/v1/triggers/listener/secure-hook",
            json={"type": "test"},
            content_type="application/json",
        )
        assert resp.status_code == 401

        # With correct secret — should succeed
        with patch.object(app.event_bus, "publish"):
            resp = client.post(
                "/api/v1/triggers/listener/secure-hook",
                json={"type": "test"},
                content_type="application/json",
                headers={"Authorization": "Bearer s3cr3t"},
            )
        assert resp.status_code == 202

    def test_listener_wrong_secret(self, client):
        _, swarm_id = _create_workspace_and_swarm(client)

        client.post(
            f"/api/v1/swarms/{swarm_id}/triggers",
            json={
                "name": "gated-hook",
                "kind": "listener",
                "config": {"endpoint": "gated-hook", "secret": "correct"},
                "enabled": True,
            },
            content_type="application/json",
        )

        resp = client.post(
            "/api/v1/triggers/listener/gated-hook",
            json={"type": "test"},
            content_type="application/json",
            headers={"Authorization": "Bearer wrong"},
        )
        assert resp.status_code == 401

    def test_listener_filter_mismatch(self, client):
        _, swarm_id = _create_workspace_and_swarm(client)

        client.post(
            f"/api/v1/swarms/{swarm_id}/triggers",
            json={
                "name": "filtered-hook",
                "kind": "listener",
                "config": {
                    "endpoint": "filtered-hook",
                    "filter": {
                        "type": "object",
                        "required": ["invoice_id"],
                        "properties": {"invoice_id": {"type": "string"}},
                    },
                },
                "enabled": True,
            },
            content_type="application/json",
        )

        # Payload missing required field
        resp = client.post(
            "/api/v1/triggers/listener/filtered-hook",
            json={"amount": 100},
            content_type="application/json",
        )
        assert resp.status_code == 422

    def test_listener_filter_match(self, client, app):
        _, swarm_id = _create_workspace_and_swarm(client)

        client.post(
            f"/api/v1/swarms/{swarm_id}/triggers",
            json={
                "name": "strict-hook",
                "kind": "listener",
                "config": {
                    "endpoint": "strict-hook",
                    "filter": {
                        "type": "object",
                        "required": ["invoice_id"],
                        "properties": {"invoice_id": {"type": "string"}},
                    },
                },
                "enabled": True,
            },
            content_type="application/json",
        )

        with patch.object(app.event_bus, "publish"):
            resp = client.post(
                "/api/v1/triggers/listener/strict-hook",
                json={"invoice_id": "INV-001", "amount": 500},
                content_type="application/json",
            )
        assert resp.status_code == 202


# ── Invocation endpoint ───────────────────────────────────────────────────────

class TestInvocationTrigger:
    def test_invocation_fires_event(self, client, app):
        _, swarm_id = _create_workspace_and_swarm(client)

        resp = client.post(
            f"/api/v1/swarms/{swarm_id}/triggers",
            json={
                "name": "manual-run",
                "kind": "invocation",
                "config": {},
                "enabled": True,
            },
            content_type="application/json",
        )
        trigger_id = resp.get_json()["id"]

        with patch.object(app.event_bus, "publish") as mock_pub:
            resp = client.post(
                f"/api/v1/triggers/invocations/{trigger_id}",
                json={"task": "process report", "invoked_by": "alice@example.com"},
                content_type="application/json",
            )
        assert resp.status_code == 202
        data = resp.get_json()
        assert "event_id" in data
        mock_pub.assert_called_once()

    def test_invocation_not_found(self, client):
        resp = client.post(
            "/api/v1/triggers/invocations/nonexistent-id",
            json={},
            content_type="application/json",
        )
        assert resp.status_code == 404

    def test_invocation_disabled_trigger(self, client):
        _, swarm_id = _create_workspace_and_swarm(client)

        resp = client.post(
            f"/api/v1/swarms/{swarm_id}/triggers",
            json={
                "name": "disabled-run",
                "kind": "invocation",
                "config": {},
                "enabled": False,
            },
            content_type="application/json",
        )
        trigger_id = resp.get_json()["id"]

        resp = client.post(
            f"/api/v1/triggers/invocations/{trigger_id}",
            json={},
            content_type="application/json",
        )
        assert resp.status_code == 409

    def test_invocation_schema_validation(self, client):
        _, swarm_id = _create_workspace_and_swarm(client)

        resp = client.post(
            f"/api/v1/swarms/{swarm_id}/triggers",
            json={
                "name": "typed-run",
                "kind": "invocation",
                "config": {
                    "schema": {
                        "type": "object",
                        "required": ["report_date"],
                        "properties": {"report_date": {"type": "string"}},
                    }
                },
                "enabled": True,
            },
            content_type="application/json",
        )
        trigger_id = resp.get_json()["id"]

        # Missing required field
        resp = client.post(
            f"/api/v1/triggers/invocations/{trigger_id}",
            json={"something_else": "x"},
            content_type="application/json",
        )
        assert resp.status_code == 422

    def test_invocation_wrong_kind(self, client):
        _, swarm_id = _create_workspace_and_swarm(client)

        resp = client.post(
            f"/api/v1/swarms/{swarm_id}/triggers",
            json={
                "name": "heartbeat-trigger",
                "kind": "heartbeat",
                "config": {"schedule": "* * * * *", "script": "tick.py"},
                "enabled": True,
            },
            content_type="application/json",
        )
        trigger_id = resp.get_json()["id"]

        resp = client.post(
            f"/api/v1/triggers/invocations/{trigger_id}",
            json={},
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_invoked_by_recorded_in_payload(self, client, app):
        _, swarm_id = _create_workspace_and_swarm(client)

        resp = client.post(
            f"/api/v1/swarms/{swarm_id}/triggers",
            json={
                "name": "attributed-run",
                "kind": "invocation",
                "config": {},
                "enabled": True,
            },
            content_type="application/json",
        )
        trigger_id = resp.get_json()["id"]

        captured = {}

        def capture_event(event):
            captured["payload"] = json.loads(event.payload_json)

        with patch.object(app.event_bus, "publish", side_effect=capture_event):
            client.post(
                f"/api/v1/triggers/invocations/{trigger_id}",
                json={"invoked_by": "bob@example.com", "note": "monthly"},
                content_type="application/json",
            )

        assert captured["payload"].get("invoked_by") == "bob@example.com"
        assert captured["payload"].get("note") == "monthly"

    def test_invocation_default_anonymous(self, client, app):
        _, swarm_id = _create_workspace_and_swarm(client)

        resp = client.post(
            f"/api/v1/swarms/{swarm_id}/triggers",
            json={
                "name": "anon-run",
                "kind": "invocation",
                "config": {},
                "enabled": True,
            },
            content_type="application/json",
        )
        trigger_id = resp.get_json()["id"]

        captured = {}

        def capture(event):
            captured["payload"] = json.loads(event.payload_json)

        with patch.object(app.event_bus, "publish", side_effect=capture):
            client.post(
                f"/api/v1/triggers/invocations/{trigger_id}",
                json={},
                content_type="application/json",
            )

        assert captured["payload"].get("invoked_by") == "anonymous"


# ── Listener deduplication ────────────────────────────────────────────────────

class TestListenerDeduplication:
    def _setup_listener(self, client, endpoint: str) -> str:
        _, swarm_id = _create_workspace_and_swarm(client)
        client.post(
            f"/api/v1/swarms/{swarm_id}/triggers",
            json={"name": f"dedup-{endpoint}", "kind": "listener",
                  "config": {"endpoint": endpoint}, "enabled": True},
            content_type="application/json",
        )
        return endpoint

    def test_duplicate_event_id_is_dropped(self, client, app):
        """Second request with the same event_id returns 202 but does not publish."""
        endpoint = self._setup_listener(client, "dedup-test-1")

        with patch.object(app.event_bus, "publish") as mock_pub:
            # First request — accepted and published
            r1 = client.post(
                f"/api/v1/triggers/listener/{endpoint}",
                json={"type": "tick", "event_id": "evt-abc-001"},
                content_type="application/json",
            )
            assert r1.status_code == 202
            assert mock_pub.call_count == 1

            # Second request — same event_id, should be deduplicated
            r2 = client.post(
                f"/api/v1/triggers/listener/{endpoint}",
                json={"type": "tick", "event_id": "evt-abc-001"},
                content_type="application/json",
            )
            assert r2.status_code == 202
            assert r2.get_json().get("deduplicated") is True
            # publish should still be called only once
            assert mock_pub.call_count == 1

    def test_different_event_ids_both_published(self, client, app):
        """Two requests with different event_ids are both accepted."""
        endpoint = self._setup_listener(client, "dedup-test-2")

        with patch.object(app.event_bus, "publish") as mock_pub:
            client.post(
                f"/api/v1/triggers/listener/{endpoint}",
                json={"type": "tick", "event_id": "evt-001"},
                content_type="application/json",
            )
            client.post(
                f"/api/v1/triggers/listener/{endpoint}",
                json={"type": "tick", "event_id": "evt-002"},
                content_type="application/json",
            )
        assert mock_pub.call_count == 2

    def test_no_event_id_never_deduplicated(self, client, app):
        """Payloads without event_id are always accepted (no dedup key)."""
        endpoint = self._setup_listener(client, "dedup-test-3")

        with patch.object(app.event_bus, "publish") as mock_pub:
            for _ in range(3):
                client.post(
                    f"/api/v1/triggers/listener/{endpoint}",
                    json={"type": "tick"},
                    content_type="application/json",
                )
        assert mock_pub.call_count == 3

    def test_dedup_cache_is_per_trigger(self, client, app):
        """The same event_id on different listener endpoints is not deduplicated."""
        _, swarm_id = _create_workspace_and_swarm(client)
        for suffix in ("ded-ep-a", "ded-ep-b"):
            client.post(
                f"/api/v1/swarms/{swarm_id}/triggers",
                json={"name": f"t-{suffix}", "kind": "listener",
                      "config": {"endpoint": suffix}, "enabled": True},
                content_type="application/json",
            )

        with patch.object(app.event_bus, "publish") as mock_pub:
            client.post(
                "/api/v1/triggers/listener/ded-ep-a",
                json={"event_id": "shared-id"},
                content_type="application/json",
            )
            client.post(
                "/api/v1/triggers/listener/ded-ep-b",
                json={"event_id": "shared-id"},
                content_type="application/json",
            )
        assert mock_pub.call_count == 2


# ── _DedupeCache unit tests ───────────────────────────────────────────────────

def test_dedupe_cache_basic():
    from app.api.triggers import _DedupeCache
    cache = _DedupeCache(ttl_seconds=60, max_size=100)
    assert cache.is_duplicate("key-1") is False   # first time — not a dupe
    assert cache.is_duplicate("key-1") is True    # second time — dupe
    assert cache.is_duplicate("key-2") is False   # different key — not a dupe


def test_dedupe_cache_evicts_at_capacity():
    from app.api.triggers import _DedupeCache
    cache = _DedupeCache(ttl_seconds=3600, max_size=3)
    cache.is_duplicate("a")
    cache.is_duplicate("b")
    cache.is_duplicate("c")
    # Adding "d" evicts "a"
    cache.is_duplicate("d")
    # "a" should no longer be considered duplicate (evicted)
    assert cache.is_duplicate("a") is False


# ── Event firing via POST /swarms/<id>/events publishes to bus ────────────────

class TestEventFiring:
    def test_fire_event_publishes_to_bus(self, client, app):
        _, swarm_id = _create_workspace_and_swarm(client)

        with patch.object(app.event_bus, "publish") as mock_pub:
            resp = client.post(
                f"/api/v1/swarms/{swarm_id}/events",
                json={"type": "test.event", "payload": {"key": "value"}},
                content_type="application/json",
            )

        assert resp.status_code == 201
        mock_pub.assert_called_once()
        event_arg = mock_pub.call_args[0][0]
        assert event_arg.swarm_id == swarm_id
        assert event_arg.source == "api"

    def test_fire_event_swarm_not_found(self, client):
        resp = client.post(
            "/api/v1/swarms/nonexistent-id/events",
            json={"type": "test"},
            content_type="application/json",
        )
        assert resp.status_code == 404


def test_invocation_uses_default_payload_when_body_empty(app, client):
    """Phase 6.1 — POST /triggers/invocations/<id> with empty body uses config.default_payload."""
    import json
    from datetime import datetime, timezone
    from app.db import get_session
    from app.models.event import Event
    from app.models.swarm import Swarm
    from app.models.trigger import Trigger
    from app.models.workspace import Workspace
    from sqlalchemy import select
    import uuid

    suffix = uuid.uuid4().hex[:6]
    with app.app_context():
        with get_session() as session:
            ws = Workspace(name=f"ws-inv-{suffix}", display_name="ws", meta_hash="h")
            session.add(ws); session.commit(); session.refresh(ws)
            sw = Swarm(workspace_id=ws.id, name=f"sw-inv-{suffix}", display_name="sw",
                       meta_hash="h", hierarchy_hash="h", enabled=True)
            session.add(sw); session.commit(); session.refresh(sw)
            sw_id = sw.id

            trig = Trigger(
                swarm_id=sw_id,
                name="manual-run",
                kind="invocation",
                config_json=json.dumps({"default_payload": {"message": "Run the daily routine"}}),
                enabled=True,
            )
            session.add(trig); session.commit(); session.refresh(trig)
            trig_id = trig.id

    # Empty body -> default_payload should be used
    r = client.post(f"/api/v1/triggers/invocations/{trig_id}",
                    data="", content_type="application/json")
    assert r.status_code == 202
    event_id = r.get_json()["event_id"]

    with app.app_context():
        with get_session() as session:
            ev = session.get(Event, event_id)
    payload = json.loads(ev.payload_json)
    assert payload.get("message") == "Run the daily routine"


def test_invocation_overrides_default_when_body_provided(app, client):
    """Body always wins over default_payload."""
    import json
    from app.db import get_session
    from app.models.event import Event
    from app.models.swarm import Swarm
    from app.models.trigger import Trigger
    from app.models.workspace import Workspace
    import uuid

    suffix = uuid.uuid4().hex[:6]
    with app.app_context():
        with get_session() as session:
            ws = Workspace(name=f"ws-inv2-{suffix}", display_name="ws", meta_hash="h")
            session.add(ws); session.commit(); session.refresh(ws)
            sw = Swarm(workspace_id=ws.id, name=f"sw-inv2-{suffix}", display_name="sw",
                       meta_hash="h", hierarchy_hash="h", enabled=True)
            session.add(sw); session.commit(); session.refresh(sw)
            sw_id = sw.id
            trig = Trigger(
                swarm_id=sw_id, name="manual",
                kind="invocation",
                config_json=json.dumps({"default_payload": {"message": "default"}}),
                enabled=True,
            )
            session.add(trig); session.commit(); session.refresh(trig)
            trig_id = trig.id

    r = client.post(f"/api/v1/triggers/invocations/{trig_id}",
                    json={"message": "override"})
    assert r.status_code == 202
    event_id = r.get_json()["event_id"]

    with app.app_context():
        with get_session() as session:
            ev = session.get(Event, event_id)
    assert json.loads(ev.payload_json)["message"] == "override"
