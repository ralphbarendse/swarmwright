"""Compound skill: find-or-create workspace, create swarm, build full topology.

Accepts either workspace_id (existing) or workspace_name (find or create).
Returns workspace_id, swarm_id, and agent name->UUID map.
"""
from __future__ import annotations
import json
import os
import sys
import urllib.request
import urllib.error


def _get(url: str) -> dict | list:
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read())


def _post(url: str, body: dict) -> dict:
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"POST {url} failed ({e.code}): {e.read().decode()}")


def _patch_topology(swarm_id: str, op: str, params: dict) -> dict:
    payload = json.dumps({"op": op, "params": params}).encode()
    req = urllib.request.Request(
        f"http://localhost:5001/api/v1/swarms/{swarm_id}/topology",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="PATCH",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"PATCH {op} failed ({e.code}): {e.read().decode()}")


def _ensure_workspace(workspace_id: str | None, workspace_name: str | None, workspace_description: str) -> tuple[str, str]:
    """Returns (workspace_id, workspace_slug)."""
    workspaces = _get("http://localhost:5001/api/v1/workspaces")
    if workspace_id:
        for ws in workspaces:
            if ws["id"] == workspace_id:
                return workspace_id, ws["name"]
        return workspace_id, workspace_id  # fallback
    # Search by display name
    for ws in workspaces:
        if ws["display_name"].lower() == (workspace_name or "").lower():
            return ws["id"], ws["name"]
    # Create new
    result = _post("http://localhost:5001/api/v1/workspaces", {
        "display_name": workspace_name,
        "description": workspace_description,
    })
    return result["id"], result["name"]


def run(input: dict, context: dict) -> dict:
    # Workspace resolution
    workspace_id, workspace_slug = _ensure_workspace(
        input.get("workspace_id"),
        input.get("workspace_name"),
        input.get("workspace_description", ""),
    )

    # Create swarm
    swarm = _post(
        f"http://localhost:5001/api/v1/workspaces/{workspace_id}/swarms",
        {
            "display_name": input["swarm_name"],
            "description": input.get("swarm_description", ""),
        },
    )
    swarm_id = swarm["id"]
    swarm_slug = swarm["name"]
    steps = [f"created_swarm:{swarm_id}"]

    agents = input.get("agents", [])
    entry_point = input.get("entry_point", "")
    edges = input.get("edges", [])
    skill_connections = input.get("skill_connections", [])
    knowledge = input.get("knowledge", [])
    custom_skills = input.get("custom_skills", [])

    # Add agents
    for agent in agents:
        _patch_topology(swarm_id, "add_agent", {
            "name": agent["name"],
            "layer": agent.get("layer", "executioner"),
            "model": agent.get("model", "claude-sonnet-4-6"),
        })
        steps.append(f"add_agent:{agent['name']}")

    # Set entry point
    if entry_point:
        _patch_topology(swarm_id, "set_entry_point", {"name": entry_point})
        steps.append(f"entry_point:{entry_point}")

    # Add edges
    for edge in edges:
        _patch_topology(swarm_id, "add_edge", {
            "from": edge["from"],
            "to": edge["to"],
            "kind": edge.get("kind", "delegate"),
            "purpose": edge["purpose"],
        })
        steps.append(f"edge:{edge['from']}->{edge['to']}")

    # Create knowledge documents
    knowledge_ids = []
    for doc in knowledge:
        result = _post("http://localhost:5001/api/v1/knowledge", {
            "scope": doc["scope"],
            "name": doc["name"],
            "title": doc.get("title", doc["name"]),
            "content": doc["content"],
            "workspace_id": doc.get("workspace_id", workspace_id),
            "swarm_id": doc.get("swarm_id", swarm_id if doc["scope"] == "swarm" else None),
        })
        knowledge_ids.append({"name": doc["name"], "id": result.get("id")})
        steps.append(f"knowledge:{doc['name']}")

    # Create custom skills
    created_skills = []
    for skill in custom_skills:
        result = _post("http://localhost:5001/api/v1/skills", {
            "scope": skill["scope"],
            "name": skill["name"],
            "py_content": skill["py_content"],
            "yaml_content": skill["yaml_content"],
            "workspace_id": skill.get("workspace_id", workspace_id),
            "swarm_id": skill.get("swarm_id", swarm_id if skill["scope"] == "swarm" else None),
        })
        created_skills.append(skill["name"])
        steps.append(f"skill:{skill['name']}")

    # Add skill connections
    for conn in skill_connections:
        _patch_topology(swarm_id, "add_skill_connection", {
            "agent": conn["agent"],
            "skill": conn["skill"],
            "purpose": conn["purpose"],
        })
        steps.append(f"skill_conn:{conn['agent']}->{conn['skill']}")

    # Place Caller nodes on canvas — create the .md file first so add_call can resolve it
    callers = input.get("callers", [])
    callers_dir = f"/data/workspaces/{workspace_slug}/swarms/{swarm_slug}/callers"
    os.makedirs(callers_dir, exist_ok=True)
    for caller in callers:
        caller_name = caller if isinstance(caller, str) else caller["name"]
        display_name = caller.get("display_name", caller_name.replace("-", " ").title()) if isinstance(caller, dict) else caller_name.replace("-", " ").title()
        description = caller.get("description", "") if isinstance(caller, dict) else ""
        md_path = os.path.join(callers_dir, f"{caller_name}.md")
        if not os.path.exists(md_path):
            with open(md_path, "w") as f:
                f.write(f"---\ncontacts: []\ndisplay_name: {display_name}\nname: {caller_name}\n---\n\n{description}\n")
            steps.append(f"created_caller_file:{caller_name}")
        _patch_topology(swarm_id, "add_canvas_caller", {"caller": caller_name})
        steps.append(f"add_caller:{caller_name}")

    # Wire agent → Caller connections
    caller_connections = input.get("caller_connections", [])
    for conn in caller_connections:
        _patch_topology(swarm_id, "add_call", {
            "agent": conn["agent"],
            "caller": conn["caller"],
            "purpose": conn["purpose"],
        })
        steps.append(f"caller_conn:{conn['agent']}->{conn['caller']}")

    # Place Informer nodes on canvas
    informers = input.get("informers", [])
    for informer_name in informers:
        _patch_topology(swarm_id, "add_canvas_informer", {"informer": informer_name})
        steps.append(f"add_informer:{informer_name}")

    # Wire agent → Informer connections
    informer_connections = input.get("informer_connections", [])
    for conn in informer_connections:
        _patch_topology(swarm_id, "add_inform", {
            "agent": conn["agent"],
            "informer": conn["informer"],
            "purpose": conn["purpose"],
        })
        steps.append(f"informer_conn:{conn['agent']}->{conn['informer']}")

    # Fetch agent UUIDs
    agent_list = _get(f"http://localhost:5001/api/v1/swarms/{swarm_id}/agents")
    agent_map = {a["name"]: a["id"] for a in agent_list}
    steps.append("fetched_agent_uuids")

    return {
        "workspace_id": workspace_id,
        "swarm_id": swarm_id,
        "agent_map": agent_map,
        "knowledge_ids": knowledge_ids,
        "created_skills": created_skills,
        "steps": steps,
    }


if __name__ == "__main__":
    payload = json.loads(sys.argv[1])
    try:
        print(json.dumps(run(payload["input"], payload["context"])))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
