"""Built-in skill: add an agent to a swarm in one shot.

Wraps the three patch_topology calls (add_agent, set_entry_point,
add_skill_connection×N) that are otherwise needed individually.
"""
from __future__ import annotations
import json, os, sys, urllib.request, urllib.error


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
    token = os.environ.get("INTERNAL_TOKEN", "")
    swarm_id     = input_data["swarm_id"]
    agent_name   = input_data["agent_name"]
    layer        = input_data.get("layer", "orchestrator")
    constitution = input_data.get("constitution")
    set_entry    = input_data.get("set_as_entry_point", True)
    skills       = input_data.get("skills", [])  # [{skill_name, purpose}]

    add_params: dict = {"name": agent_name, "layer": layer}
    if constitution:
        add_params["constitution"] = constitution
    _patch(swarm_id, "add_agent", add_params, token)

    if set_entry:
        _patch(swarm_id, "set_entry_point", {"name": agent_name}, token)

    skills_attached = 0
    for s in skills:
        skill_name = s.get("skill_name") or s.get("skill") or ""
        if not skill_name:
            continue
        _patch(swarm_id, "add_skill_connection", {
            "agent": agent_name,
            "skill": skill_name,
            "purpose": s.get("purpose", f"Call {skill_name}"),
        }, token)
        skills_attached += 1

    return {
        "ok": True,
        "swarm_id": swarm_id,
        "agent_name": agent_name,
        "skills_attached": skills_attached,
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
