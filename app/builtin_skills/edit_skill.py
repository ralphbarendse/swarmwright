"""Built-in skill: update an existing skill's source (.py and/or .yaml) via the internal API.

Unlike create_skill (which POSTs and fails if the skill already exists), this PUTs
to the update endpoint. Either py_content or yaml_content may be omitted — the current
file is fetched and kept unchanged, so you can tweak just one half of a skill.
"""
from __future__ import annotations
import json, os, sqlite3, urllib.request, urllib.error


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


def _structured_http_error(exc: urllib.error.HTTPError) -> dict:
    """Turn an HTTPError into a structured result the agent can act on instead of crashing."""
    body_text = exc.read().decode(errors="replace")
    try:
        body = json.loads(body_text)
        code = body.get("error", {}).get("code", f"http_{exc.code}")
        msg = body.get("error", {}).get("message", body_text)
    except Exception:
        code, msg = f"http_{exc.code}", body_text
    return {"ok": False, "error": code, "message": msg, "status": exc.code}


def _scope_params(input_data: dict, workspace_id: str | None) -> str:
    params = f"scope={input_data['scope']}"
    if workspace_id:
        params += f"&workspace_id={workspace_id}"
    if input_data.get("swarm_id"):
        params += f"&swarm_id={input_data['swarm_id']}"
    return params


def run(input_data: dict, context: dict) -> dict:
    scope = input_data["scope"]
    name = input_data["name"].replace("_", "-")

    workspace_id = input_data.get("workspace_id")
    if not workspace_id and input_data.get("workspace_name"):
        try:
            workspace_id = _resolve_workspace(input_data["workspace_name"], context["data_dir"])
        except ValueError as exc:
            return {"ok": False, "error": "workspace_not_found", "message": str(exc)}

    py_content = input_data.get("py_content")
    yaml_content = input_data.get("yaml_content")

    # Partial edit: fetch the current source for whichever half wasn't supplied, so
    # the caller can change just the .py or just the .yaml without re-sending both.
    if py_content is None or yaml_content is None:
        get_url = f"http://localhost:5001/api/v1/skills/{name}?{_scope_params(input_data, workspace_id)}"
        get_req = urllib.request.Request(
            get_url,
            headers={"X-Internal-Token": os.environ.get("INTERNAL_TOKEN", "")},
            method="GET",
        )
        try:
            with urllib.request.urlopen(get_req, timeout=20) as resp:
                current = json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            return _structured_http_error(exc)
        if py_content is None:
            py_content = current.get("py_content", "")
        if yaml_content is None:
            yaml_content = current.get("yaml_content", "")

    payload = json.dumps({
        "scope": scope,
        "name": name,
        "py_content": py_content,
        "yaml_content": yaml_content,
        "workspace_id": workspace_id,
        "swarm_id": input_data.get("swarm_id"),
    }).encode()

    req = urllib.request.Request(
        f"http://localhost:5001/api/v1/skills/{name}",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Internal-Token": os.environ.get("INTERNAL_TOKEN", ""),
        },
        method="PUT",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return {"ok": True, **json.loads(resp.read())}
    except urllib.error.HTTPError as exc:
        # All errors here are recoverable by the agent (bad YAML, missing __main__,
        # disallowed package, skill doesn't exist) — return structured rather than raise.
        return _structured_http_error(exc)


if __name__ == "__main__":
    import json as _json, sys as _sys, traceback as _tb
    try:
        _payload = _json.loads(_sys.argv[1])
        _result = run(_payload["input"], _payload["context"])
    except Exception:
        _result = {"ok": False, "error": "skill_exception", "message": _tb.format_exc(limit=5).strip()}
    print(_json.dumps(_result))
