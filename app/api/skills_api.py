from __future__ import annotations

import logging
import os
import re

import yaml
from flask import Blueprint, current_app, jsonify, request
from pydantic import BaseModel
from sqlalchemy import select

from app.core.skill_runner import (
    SkillValidationError,
    validate_allowed_packages,
)
from app.db import get_session
from app.models.swarm import Swarm
from app.models.workspace import Workspace

logger = logging.getLogger(__name__)
bp = Blueprint("skills_api", __name__, url_prefix="/api/v1")

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class SkillWrite(BaseModel):
    scope: str
    workspace_id: str | None = None
    swarm_id: str | None = None
    name: str
    py_content: str
    yaml_content: str


def _scope_folder(scope: str, workspace_id: str | None, swarm_id: str | None, data_dir: str) -> str | None:
    if scope == "company":
        return os.path.join(data_dir, "company", "skills")
    if scope == "workspace" and workspace_id:
        with get_session() as session:
            ws = session.get(Workspace, workspace_id)
        if not ws:
            return None
        return os.path.join(data_dir, "workspaces", ws.name, "skills")
    if scope == "swarm" and swarm_id:
        with get_session() as session:
            swarm = session.get(Swarm, swarm_id)
            if not swarm:
                return None
            ws = session.get(Workspace, swarm.workspace_id)
        if not ws:
            return None
        return os.path.join(data_dir, "workspaces", ws.name, "swarms", swarm.name, "skills")
    return None


def _skill_from_folder(folder: str, scope: str, workspace_id: str | None, swarm_id: str | None) -> list[dict]:
    if not os.path.isdir(folder):
        return []
    skills: dict[str, dict] = {}
    for fname in os.listdir(folder):
        if fname.endswith(".py"):
            name = fname[:-3]
            skills.setdefault(name, {"name": name, "scope": scope, "workspace_id": workspace_id, "swarm_id": swarm_id})
            skills[name]["py_path"] = os.path.join(folder, fname)
        elif fname.endswith(".yaml"):
            name = fname[:-5]
            skills.setdefault(name, {"name": name, "scope": scope, "workspace_id": workspace_id, "swarm_id": swarm_id})
            skills[name]["yaml_path"] = os.path.join(folder, fname)
            try:
                with open(os.path.join(folder, fname)) as f:
                    cfg = yaml.safe_load(f) or {}
                skills[name]["description"] = cfg.get("description", "")
                skills[name]["timeout_seconds"] = cfg.get("timeout_seconds", 30)
                skills[name]["allowed_packages"] = cfg.get("allowed_packages", [])
            except Exception:
                pass
    return list(skills.values())


@bp.get("/skills")
def list_skills():
    scope = request.args.get("scope")
    workspace_id = request.args.get("workspace_id")
    swarm_id = request.args.get("swarm_id")
    data_dir = current_app.config["DATA_DIR"]

    results: list[dict] = []
    if scope:
        folder = _scope_folder(scope, workspace_id, swarm_id, data_dir)
        if folder:
            results = _skill_from_folder(folder, scope, workspace_id, swarm_id)
    else:
        # Return all scopes
        results += _skill_from_folder(
            os.path.join(data_dir, "company", "skills"), "company", None, None
        )
    return jsonify(results)


@bp.get("/skills/<skill_name>")
def get_skill(skill_name: str):
    scope = request.args.get("scope", "company")
    workspace_id = request.args.get("workspace_id")
    swarm_id = request.args.get("swarm_id")
    data_dir = current_app.config["DATA_DIR"]

    folder = _scope_folder(scope, workspace_id, swarm_id, data_dir)
    if not folder:
        return jsonify({"error": {"code": "not_found", "message": "Scope not found"}}), 404

    py_path = os.path.join(folder, f"{skill_name}.py")
    yaml_path = os.path.join(folder, f"{skill_name}.yaml")

    if not os.path.isfile(py_path) and not os.path.isfile(yaml_path):
        return jsonify({"error": {"code": "not_found", "message": "Skill not found"}}), 404

    result: dict = {"name": skill_name, "scope": scope, "workspace_id": workspace_id, "swarm_id": swarm_id}
    if os.path.isfile(py_path):
        with open(py_path) as f:
            result["py_content"] = f.read()
    if os.path.isfile(yaml_path):
        with open(yaml_path) as f:
            result["yaml_content"] = f.read()
        try:
            cfg = yaml.safe_load(result["yaml_content"]) or {}
            result["description"] = cfg.get("description", "")
            result["timeout_seconds"] = cfg.get("timeout_seconds", 30)
            result["allowed_packages"] = cfg.get("allowed_packages", [])
        except Exception:
            pass

    return jsonify(result)


# ── Create / Update / Delete ──────────────────────────────────────────────────

_DEFAULT_PY = '''\
"""<NAME> — describe what this skill does in one line."""
import json
import sys


def run(input: dict, context: dict) -> dict:
    """Entry point for the skill.

    Args:
        input:   Validated against ``input_schema`` in the YAML config.
        context: Read-only metadata (run_id, agent_name, swarm_id, ...).

    Returns:
        A dict that will be validated against ``output_schema``.
    """
    return {"ok": True, "echo": input}


if __name__ == "__main__":
    payload = json.loads(sys.argv[1])
    print(json.dumps(run(payload["input"], payload["context"])))
'''

_DEFAULT_YAML = '''\
description: Briefly describe what this skill does and when to use it.
timeout_seconds: 30
allowed_packages: []
input_schema:
  type: object
  additionalProperties: true
output_schema:
  type: object
  additionalProperties: true
'''


def _write_skill_files(folder: str, name: str, py_content: str, yaml_content: str) -> tuple[str, str]:
    os.makedirs(folder, exist_ok=True)
    py_path = os.path.join(folder, f"{name}.py")
    yaml_path = os.path.join(folder, f"{name}.yaml")
    # Atomic writes via tempfile + rename.
    py_tmp = py_path + ".tmp"
    yaml_tmp = yaml_path + ".tmp"
    with open(py_tmp, "w") as f:
        f.write(py_content)
    with open(yaml_tmp, "w") as f:
        f.write(yaml_content)
    os.replace(py_tmp, py_path)
    os.replace(yaml_tmp, yaml_path)
    return py_path, yaml_path


def _parse_yaml_or_400(yaml_content: str) -> dict | tuple:
    try:
        cfg = yaml.safe_load(yaml_content) or {}
    except yaml.YAMLError as exc:
        return jsonify({"error": {"code": "invalid_yaml", "message": str(exc)}}), 422
    if not isinstance(cfg, dict):
        return jsonify({"error": {"code": "invalid_yaml", "message": "YAML must define an object"}}), 422
    return cfg


@bp.post("/skills")
def create_skill():
    try:
        body = SkillWrite.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400
    if not _NAME_RE.match(body.name):
        return jsonify({"error": {"code": "validation_error", "message": "Name must be lowercase letters, digits, or '-'"}}), 400

    data_dir = current_app.config["DATA_DIR"]
    folder = _scope_folder(body.scope, body.workspace_id, body.swarm_id, data_dir)
    if not folder:
        return jsonify({"error": {"code": "not_found", "message": "Scope not found"}}), 404

    py_path = os.path.join(folder, f"{body.name}.py")
    if os.path.isfile(py_path):
        return jsonify({"error": {"code": "conflict", "message": f"Skill {body.name!r} already exists at this scope"}}), 409

    py_src = body.py_content or _DEFAULT_PY.replace("<NAME>", body.name)
    yaml_src = body.yaml_content or _DEFAULT_YAML

    cfg = _parse_yaml_or_400(yaml_src)
    if isinstance(cfg, tuple):
        return cfg

    # Static analysis: imports must be in allowed_packages (or stdlib).
    py_path_w, yaml_path_w = _write_skill_files(folder, body.name, py_src, yaml_src)
    try:
        validate_allowed_packages(py_path_w, list(cfg.get("allowed_packages") or []))
    except SkillValidationError as exc:
        # Roll back partial files so the scope stays clean.
        for p in (py_path_w, yaml_path_w):
            try: os.remove(p)
            except OSError: pass
        return jsonify({"error": {"code": "invalid_skill", "message": str(exc)}}), 422

    return jsonify({
        "name": body.name,
        "scope": body.scope,
        "workspace_id": body.workspace_id,
        "swarm_id": body.swarm_id,
        "py_path": py_path_w,
        "yaml_path": yaml_path_w,
        "description": cfg.get("description", ""),
        "timeout_seconds": cfg.get("timeout_seconds", 30),
        "allowed_packages": cfg.get("allowed_packages", []),
    }), 201


@bp.put("/skills/<skill_name>")
def update_skill(skill_name: str):
    try:
        body = SkillWrite.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400
    if body.name != skill_name:
        return jsonify({"error": {"code": "validation_error", "message": "Rename not supported — delete and recreate"}}), 400

    data_dir = current_app.config["DATA_DIR"]
    folder = _scope_folder(body.scope, body.workspace_id, body.swarm_id, data_dir)
    if not folder:
        return jsonify({"error": {"code": "not_found", "message": "Scope not found"}}), 404

    py_path = os.path.join(folder, f"{skill_name}.py")
    yaml_path = os.path.join(folder, f"{skill_name}.yaml")
    if not (os.path.isfile(py_path) or os.path.isfile(yaml_path)):
        return jsonify({"error": {"code": "not_found", "message": "Skill not found"}}), 404

    cfg = _parse_yaml_or_400(body.yaml_content)
    if isinstance(cfg, tuple):
        return cfg

    py_path_w, yaml_path_w = _write_skill_files(folder, skill_name, body.py_content, body.yaml_content)
    try:
        validate_allowed_packages(py_path_w, list(cfg.get("allowed_packages") or []))
    except SkillValidationError as exc:
        return jsonify({"error": {"code": "invalid_skill", "message": str(exc)}}), 422

    return jsonify({
        "name": skill_name,
        "scope": body.scope,
        "workspace_id": body.workspace_id,
        "swarm_id": body.swarm_id,
        "py_path": py_path_w,
        "yaml_path": yaml_path_w,
        "description": cfg.get("description", ""),
        "timeout_seconds": cfg.get("timeout_seconds", 30),
        "allowed_packages": cfg.get("allowed_packages", []),
    })


_USEFUL_THIRD_PARTY = {
    "httpx":         "HTTP client (sync + async).",
    "requests":      "Classic HTTP client (if installed).",
    "pyyaml":        "YAML parsing.",
    "jsonschema":    "JSON Schema validation.",
    "pydantic":      "Typed data validation.",
    "cryptography":  "Crypto primitives, JWT, Fernet, etc.",
    "python-dateutil": "Robust date parsing.",
    "python-frontmatter": "YAML frontmatter parsing.",
}


class SkillDraftRequest(BaseModel):
    prompt: str = ""
    name: str = "skill"


@bp.post("/skills/_meta/draft")
def draft_skill():
    try:
        body = SkillDraftRequest.model_validate(request.get_json(force=True) or {})
    except Exception as exc:
        return jsonify({"error": {"code": "validation_error", "message": str(exc)}}), 400

    # Gather runtime context so the LLM knows what's available
    import sys
    try:
        from importlib.metadata import distributions
        installed = {d.metadata["Name"].lower(): d.version for d in distributions() if d.metadata.get("Name")}
    except Exception:
        installed = {}
    third_party_lines = []
    for pkg, hint in _USEFUL_THIRD_PARTY.items():
        if pkg.lower() in installed:
            third_party_lines.append(f"  - {pkg} {installed[pkg.lower()]}: {hint}")

    stdlib_list = "json, urllib.request, urllib.parse, datetime, re, math, os, sys, pathlib, hashlib, hmac, base64, csv, sqlite3, subprocess, tempfile, uuid, time, io, collections, itertools, functools, dataclasses, typing"
    third_party_block = "\n".join(third_party_lines) if third_party_lines else "  (none installed)"

    system = f"""You are a Python developer writing sandboxed skills for an AI agent swarm platform (SwarmWright).

Rules you MUST follow:
1. Every skill is two files: a .py file and a config.yaml file. Output BOTH.
2. The Python entry point must be exactly: def run(input: dict, context: dict) -> dict
3. The skill runs in a subprocess sandbox. Only stdlib and packages listed in allowed_packages are permitted.
4. Any third-party package you import MUST be listed in allowed_packages in the YAML.
5. Return a dict — never raise unhandled exceptions. Catch errors and include them in the returned dict.
6. The __main__ block must be exactly:
   if __name__ == "__main__":
       payload = json.loads(sys.argv[1])
       print(json.dumps(run(payload["input"], payload["context"])))
7. input_schema is validated with jsonschema BEFORE the skill runs. If the calling agent passes data
   that does not match input_schema, the skill is rejected without executing. Design input_schema to
   match exactly what the agent will provide.
8. output_schema is validated with jsonschema AFTER run() returns. The dict you return must satisfy it.
   Use additionalProperties: true if you want flexibility, or define every field precisely.
9. The context dict passed to run() contains exactly these read-only keys at runtime:
   - run_id: the current run's UUID
   - agent_name: name of the agent that called this skill
   - swarm_id: UUID of the swarm

Stdlib always available (no need to list in allowed_packages):
{stdlib_list}

Third-party packages installed in this container (must be in allowed_packages to use):
{third_party_block}

YAML structure:
description: <one-line description of what the skill does and when to use it>
timeout_seconds: <integer, default 30>
allowed_packages: [<list only the packages you actually import — empty list if stdlib only>]
input_schema:
  type: object
  properties:
    <field>: {{type: <type>, description: <desc>}}
  required: [<required fields>]
  additionalProperties: false
output_schema:
  type: object
  properties:
    <field>: {{type: <type>}}
  additionalProperties: true

Output format — return exactly two fenced code blocks, nothing else:
```python
<skill.py content>
```
```yaml
<config.yaml content>
```"""

    user_msg = f"Skill name: {body.name}\n"
    if body.prompt:
        user_msg += f"Instructions: {body.prompt}"
    else:
        user_msg += "Draft a skill based on the name above."

    try:
        from app.core.secrets import get_llm_credentials  # noqa: PLC0415
        llm = get_llm_credentials()
        raw = llm.complete(system, [{"role": "user", "content": user_msg}], max_tokens=2048)
    except Exception as exc:
        logger.error("LLM skill draft failed: %s", exc)
        return jsonify({"error": {"code": "llm_error", "message": str(exc)}}), 502

    # Parse the two fenced blocks out of the response
    import re as _re
    py_match   = _re.search(r"```python\n(.*?)```", raw, _re.DOTALL)
    yaml_match = _re.search(r"```yaml\n(.*?)```",   raw, _re.DOTALL)
    return jsonify({
        "py_content":   py_match.group(1).rstrip()   if py_match   else raw,
        "yaml_content": yaml_match.group(1).rstrip() if yaml_match else "",
    })


@bp.get("/skills/_meta/runtime")
def skills_runtime_info():
    """Surface what's available to skills at runtime.

    Skills run in a subprocess that inherits the container's Python install.
    Stdlib is always allowed; third-party imports must be added to the skill's
    ``allowed_packages`` list. This endpoint enumerates packages we know are
    installed AND useful for skills.
    """
    import sys
    try:
        from importlib.metadata import distributions
        installed = {
            d.metadata["Name"].lower(): d.version
            for d in distributions()
            if d.metadata.get("Name")
        }
    except Exception:
        installed = {}

    third_party = []
    for pkg, hint in _USEFUL_THIRD_PARTY.items():
        if pkg.lower() in installed:
            third_party.append({"name": pkg, "version": installed[pkg.lower()], "hint": hint})

    # A small selection of the most useful stdlib modules — full list is huge
    # and not worth scrolling through. Skills can import any stdlib module.
    stdlib_highlights = [
        "json", "urllib.request", "urllib.parse", "datetime", "re", "math",
        "os", "sys", "pathlib", "hashlib", "hmac", "base64", "csv",
        "sqlite3", "subprocess", "tempfile", "uuid", "time", "io",
        "collections", "itertools", "functools", "dataclasses", "typing",
    ]

    return jsonify({
        "python_version": sys.version.split()[0],
        "stdlib_highlights": stdlib_highlights,
        "third_party": third_party,
    })


@bp.delete("/skills/<skill_name>")
def delete_skill(skill_name: str):
    scope = request.args.get("scope", "company")
    workspace_id = request.args.get("workspace_id")
    swarm_id = request.args.get("swarm_id")
    data_dir = current_app.config["DATA_DIR"]

    folder = _scope_folder(scope, workspace_id, swarm_id, data_dir)
    if not folder:
        return jsonify({"error": {"code": "not_found", "message": "Scope not found"}}), 404

    removed = False
    for ext in (".py", ".yaml"):
        path = os.path.join(folder, f"{skill_name}{ext}")
        if os.path.isfile(path):
            try:
                os.remove(path)
                removed = True
            except OSError as exc:
                logger.warning("Could not delete %s: %s", path, exc)
    if not removed:
        return jsonify({"error": {"code": "not_found", "message": "Skill not found"}}), 404
    return "", 204
