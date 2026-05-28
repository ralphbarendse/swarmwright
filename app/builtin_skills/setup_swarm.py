"""Built-in skill: create a swarm and add its first agent in one shot."""
from __future__ import annotations
import json, os, sqlite3, sys, urllib.request, urllib.error


def _resolve_workspace(name: str, data_dir: str) -> str:
    con = sqlite3.connect(os.path.join(data_dir, "swarm.db"))
    try:
        row = con.execute(
            "SELECT id FROM workspaces WHERE lower(name)=lower(?) OR lower(display_name)=lower(?)",
            (name, name),
        ).fetchone()
    finally:
        con.close()
    if not row:
        raise ValueError(f"Workspace not found: {name!r}")
    return row[0]


def _post(url: str, body: dict, token: str) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json", "X-Internal-Token": token},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        raise RuntimeError(f"POST {url} failed: {exc.code} {body_text}") from exc


def _patch(swarm_id: str, op: str, params: dict, token: str) -> None:
    body = json.dumps({"op": op, "params": params}).encode()
    req = urllib.request.Request(
        f"http://localhost:5001/api/v1/swarms/{swarm_id}/topology",
        data=body,
        headers={"Content-Type": "application/json", "X-Internal-Token": token},
        method="PATCH",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        raise RuntimeError(f"patch_topology ({op}) failed: {exc.code} {body_text}") from exc


def run(input_data: dict, context: dict) -> dict:
    token    = os.environ.get("INTERNAL_TOKEN", "")
    data_dir = context["data_dir"]

    workspace_id = input_data.get("workspace_id")
    if not workspace_id and input_data.get("workspace_name"):
        workspace_id = _resolve_workspace(input_data["workspace_name"], data_dir)
    if not workspace_id:
        raise ValueError("Either workspace_id or workspace_name is required")

    swarm_name   = input_data["swarm_name"]
    agent_name   = input_data["agent_name"]
    layer        = input_data.get("layer", "orchestrator")
    constitution = input_data.get("constitution")
    skills       = input_data.get("skills", [])  # [{skill_name, purpose}]
    description  = input_data.get("description", "")

    # 1. Create the swarm
    swarm = _post(
        f"http://localhost:5001/api/v1/workspaces/{workspace_id}/swarms",
        {"display_name": swarm_name, "description": description},
        token,
    )
    swarm_id = swarm["id"]

    # 2. Add the agent
    add_params: dict = {"name": agent_name, "layer": layer}
    if constitution:
        add_params["constitution"] = constitution
    _patch(swarm_id, "add_agent", add_params, token)

    # 3. Set entry point
    _patch(swarm_id, "set_entry_point", {"name": agent_name}, token)

    # 4. Attach skills
    for s in skills:
        skill_name = s.get("skill_name") or s.get("skill") or ""
        if not skill_name:
            continue
        _patch(swarm_id, "add_skill_connection", {
            "agent": agent_name,
            "skill": skill_name,
            "purpose": s.get("purpose", f"Call {skill_name}"),
        }, token)

    return {
        "ok": True,
        "swarm_id":   swarm_id,
        "swarm_name": swarm.get("display_name", swarm_name),
        "agent_name": agent_name,
        "skills_attached": len([s for s in skills if s.get("skill_name") or s.get("skill")]),
    }


def run_safe(input_data: dict, context: dict) -> dict:
    try:
        return run(input_data, context)
    except RuntimeError as exc:
        return {"ok": False, "error": "api_error", "message": str(exc)}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
