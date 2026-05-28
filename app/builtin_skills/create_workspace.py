"""Built-in skill: provision a new workspace via the internal API."""
from __future__ import annotations
import json, os, sys, urllib.request, urllib.error


def run(input_data: dict, context: dict) -> dict:
    display_name = input_data.get("display_name") or input_data.get("name")
    if not display_name:
        raise ValueError("Either 'display_name' or 'name' must be provided")
    body = json.dumps({
        "display_name": display_name,
        "description": input_data.get("description", ""),
    }).encode()
    req = urllib.request.Request(
        "http://localhost:5001/api/v1/workspaces",
        data=body,
        headers={"Content-Type": "application/json", "X-Internal-Token": os.environ.get("INTERNAL_TOKEN", "")},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            result = json.loads(resp.read())
        return {
            "ok": True,
            "workspace_id": result["id"],
            "name": result["name"],
            "display_name": result["display_name"],
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
