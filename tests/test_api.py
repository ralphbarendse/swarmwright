from __future__ import annotations

import json


# ── Health ────────────────────────────────────────────────────────────────────

def test_health(client):
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    data = r.get_json()
    assert data["status"] == "ok"
    assert "version" in data
    assert "uptime_seconds" in data


# ── Workspaces ────────────────────────────────────────────────────────────────

def test_list_workspaces_empty(client):
    r = client.get("/api/v1/workspaces")
    assert r.status_code == 200
    assert r.get_json() == []


def test_create_workspace(client, data_dir):
    r = client.post("/api/v1/workspaces", json={"display_name": "Invoicing", "description": "Test workspace"})
    assert r.status_code == 201
    data = r.get_json()
    assert data["display_name"] == "Invoicing"
    assert data["description"] == "Test workspace"
    assert "id" in data
    return data["id"]


def test_create_workspace_empty_name_rejected(client):
    r = client.post("/api/v1/workspaces", json={"display_name": ""})
    assert r.status_code == 400


def test_get_workspace(client):
    r = client.post("/api/v1/workspaces", json={"display_name": "GetTest"})
    wid = r.get_json()["id"]

    r2 = client.get(f"/api/v1/workspaces/{wid}")
    assert r2.status_code == 200
    assert r2.get_json()["id"] == wid
    assert "swarms" in r2.get_json()


def test_get_workspace_not_found(client):
    r = client.get("/api/v1/workspaces/does-not-exist")
    assert r.status_code == 404


def test_update_workspace(client):
    r = client.post("/api/v1/workspaces", json={"display_name": "OldName"})
    wid = r.get_json()["id"]

    r2 = client.put(f"/api/v1/workspaces/{wid}", json={"display_name": "NewName"})
    assert r2.status_code == 200
    assert r2.get_json()["display_name"] == "NewName"


def test_delete_workspace_with_no_swarms(client):
    r = client.post("/api/v1/workspaces", json={"display_name": "ToDelete"})
    wid = r.get_json()["id"]

    r2 = client.delete(f"/api/v1/workspaces/{wid}")
    assert r2.status_code == 204


def test_delete_workspace_blocked_by_swarm(client):
    r = client.post("/api/v1/workspaces", json={"display_name": "HasSwarm"})
    wid = r.get_json()["id"]
    client.post(f"/api/v1/workspaces/{wid}/swarms", json={"display_name": "MySwarm"})

    r2 = client.delete(f"/api/v1/workspaces/{wid}")
    assert r2.status_code == 409


# ── Swarms ────────────────────────────────────────────────────────────────────

def _make_workspace(client, name="WS"):
    return client.post("/api/v1/workspaces", json={"display_name": name}).get_json()["id"]


def test_list_swarms_empty(client):
    wid = _make_workspace(client, "SwarmListWS")
    r = client.get(f"/api/v1/workspaces/{wid}/swarms")
    assert r.status_code == 200
    assert r.get_json() == []


def test_create_swarm(client, data_dir):
    wid = _make_workspace(client, "CreateSwarmWS")
    r = client.post(f"/api/v1/workspaces/{wid}/swarms", json={"display_name": "Invoice Intake"})
    assert r.status_code == 201
    data = r.get_json()
    assert data["display_name"] == "Invoice Intake"
    assert data["workspace_id"] == wid


def test_get_swarm(client):
    wid = _make_workspace(client, "GetSwarmWS")
    sid = client.post(f"/api/v1/workspaces/{wid}/swarms", json={"display_name": "S1"}).get_json()["id"]

    r = client.get(f"/api/v1/swarms/{sid}")
    assert r.status_code == 200
    body = r.get_json()
    assert body["id"] == sid
    assert "agents" in body
    assert "triggers" in body


def test_get_swarm_not_found(client):
    r = client.get("/api/v1/swarms/does-not-exist")
    assert r.status_code == 404


def test_update_swarm(client):
    wid = _make_workspace(client, "UpdateSwarmWS")
    sid = client.post(f"/api/v1/workspaces/{wid}/swarms", json={"display_name": "Old"}).get_json()["id"]

    r = client.put(f"/api/v1/swarms/{sid}", json={"display_name": "New"})
    assert r.status_code == 200
    assert r.get_json()["display_name"] == "New"


def test_delete_swarm(client):
    wid = _make_workspace(client, "DeleteSwarmWS")
    sid = client.post(f"/api/v1/workspaces/{wid}/swarms", json={"display_name": "Del"}).get_json()["id"]

    r = client.delete(f"/api/v1/swarms/{sid}")
    assert r.status_code == 204


# ── Agents (read-only, empty in Phase 1) ─────────────────────────────────────

def test_list_agents_empty(client):
    wid = _make_workspace(client, "AgentWS")
    sid = client.post(f"/api/v1/workspaces/{wid}/swarms", json={"display_name": "AS"}).get_json()["id"]

    r = client.get(f"/api/v1/swarms/{sid}/agents")
    assert r.status_code == 200
    assert r.get_json() == []


def test_get_agent_not_found(client):
    r = client.get("/api/v1/agents/does-not-exist")
    assert r.status_code == 404


# ── Events ────────────────────────────────────────────────────────────────────

def test_fire_event(client):
    wid = _make_workspace(client, "EventWS")
    sid = client.post(f"/api/v1/workspaces/{wid}/swarms", json={"display_name": "ES"}).get_json()["id"]

    r = client.post(f"/api/v1/swarms/{sid}/events", json={"type": "test_event", "payload": {"k": "v"}})
    assert r.status_code == 201
    data = r.get_json()
    assert data["swarm_id"] == sid
    assert data["source"] == "api"


def test_list_events(client):
    r = client.get("/api/v1/events")
    assert r.status_code == 200
    assert isinstance(r.get_json(), list)


def test_list_events_filtered_by_swarm(client):
    wid = _make_workspace(client, "FilterEventWS")
    sid = client.post(f"/api/v1/workspaces/{wid}/swarms", json={"display_name": "FE"}).get_json()["id"]
    client.post(f"/api/v1/swarms/{sid}/events", json={"type": "x"})

    r = client.get(f"/api/v1/events?swarm_id={sid}")
    assert r.status_code == 200
    events = r.get_json()
    assert all(e["swarm_id"] == sid for e in events)


# ── Triggers ─────────────────────────────────────────────────────────────────

def test_create_and_list_trigger(client):
    wid = _make_workspace(client, "TriggerWS")
    sid = client.post(f"/api/v1/workspaces/{wid}/swarms", json={"display_name": "TS"}).get_json()["id"]

    r = client.post(f"/api/v1/swarms/{sid}/triggers", json={
        "name": "poll-mailbox",
        "kind": "heartbeat",
        "config": {"schedule": "*/5 * * * *"},
    })
    assert r.status_code == 201
    tid = r.get_json()["id"]

    r2 = client.get(f"/api/v1/swarms/{sid}/triggers")
    assert any(t["id"] == tid for t in r2.get_json())


def test_create_trigger_invalid_kind(client):
    wid = _make_workspace(client, "TriggerBadKind")
    sid = client.post(f"/api/v1/workspaces/{wid}/swarms", json={"display_name": "TBK"}).get_json()["id"]

    r = client.post(f"/api/v1/swarms/{sid}/triggers", json={"name": "t", "kind": "invalid"})
    assert r.status_code == 400


def test_update_trigger(client):
    wid = _make_workspace(client, "TriggerUpdateWS")
    sid = client.post(f"/api/v1/workspaces/{wid}/swarms", json={"display_name": "TU"}).get_json()["id"]
    tid = client.post(f"/api/v1/swarms/{sid}/triggers", json={"name": "t", "kind": "heartbeat"}).get_json()["id"]

    r = client.put(f"/api/v1/triggers/{tid}", json={"enabled": False})
    assert r.status_code == 200
    assert r.get_json()["enabled"] is False


def test_delete_trigger(client):
    wid = _make_workspace(client, "TriggerDeleteWS")
    sid = client.post(f"/api/v1/workspaces/{wid}/swarms", json={"display_name": "TD"}).get_json()["id"]
    tid = client.post(f"/api/v1/swarms/{sid}/triggers", json={"name": "t", "kind": "invocation"}).get_json()["id"]

    r = client.delete(f"/api/v1/triggers/{tid}")
    assert r.status_code == 204


# ── Runs ──────────────────────────────────────────────────────────────────────

def test_list_runs_empty(client):
    r = client.get("/api/v1/runs")
    assert r.status_code == 200
    assert isinstance(r.get_json(), list)


def test_get_run_not_found(client):
    r = client.get("/api/v1/runs/does-not-exist")
    assert r.status_code == 404
