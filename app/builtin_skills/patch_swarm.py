"""Built-in skill: update a swarm's enabled flag or display metadata."""
from __future__ import annotations
import json, os, sys, urllib.request, urllib.error


def run(input_data: dict, context: dict) -> dict:
    swarm_id = input_data["swarm_id"]
    body_dict: dict = {}
    if "enabled" in input_data:
        body_dict["enabled"] = bool(input_data["enabled"])
    if "display_name" in input_data:
        body_dict["display_name"] = input_data["display_name"]
    if "description" in input_data:
        body_dict["description"] = input_data["description"]
    if not body_dict:
        raise ValueError("patch_swarm: at least one field (enabled, display_name, description) must be provided")

    body = json.dumps(body_dict).encode()
    req = urllib.request.Request(
        f"http://localhost:5001/api/v1/swarms/{swarm_id}",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Internal-Token": os.environ.get("INTERNAL_TOKEN", ""),
        },
        method="PUT",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            result = json.loads(resp.read())
        return {
            "ok": True,
            "swarm_id":    result.get("id", swarm_id),
            "name":        result.get("name", ""),
            "display_name": result.get("display_name", ""),
            "enabled":     result.get("enabled"),
        }
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        try:
            err = json.loads(body_text).get("error", {})
        except Exception:
            err = {}
        return {"ok": False, "error": err.get("code", f"http_{exc.code}"), "message": err.get("message", body_text)}


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
