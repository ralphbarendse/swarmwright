from __future__ import annotations

import ast
import json
import logging
import os
import subprocess
import sys
import tempfile
from typing import Any

import yaml

logger = logging.getLogger(__name__)


class SkillError(Exception):
    """Raised when a skill fails in a way the runner cannot recover from."""


class SkillTimeoutError(SkillError):
    """Kept for backwards compatibility — run_skill no longer raises this."""


class SkillValidationError(SkillError):
    """Raised when a skill's input fails schema validation."""


def load_skill_config(skill_yaml_path: str) -> dict:
    """Load and return a skill's YAML configuration."""
    with open(skill_yaml_path) as f:
        return yaml.safe_load(f)


def validate_skill_input(input_data: dict, schema: dict) -> None:
    """Validate skill input against the declared input_schema.

    Raises:
        SkillValidationError: If the input does not conform to the schema.
    """
    try:
        import jsonschema  # noqa: PLC0415
        jsonschema.validate(instance=input_data, schema=schema)
    except jsonschema.ValidationError as exc:
        raise SkillValidationError(
            f"Skill input failed schema validation: {exc.message}"
        ) from exc


def validate_skill_output(output_data: dict, schema: dict) -> None:
    """Validate skill output against the declared output_schema.

    Error-shaped outputs (ok: false) bypass required-field checks — the agent
    receives the error dict and decides how to handle it.

    Raises:
        SkillValidationError: If a *successful* output does not conform to the schema.
    """
    # Error shape — skip validation so the agent can see and handle the error.
    if output_data.get("ok") is False:
        return
    try:
        import jsonschema  # noqa: PLC0415
        jsonschema.validate(instance=output_data, schema=schema)
    except jsonschema.ValidationError as exc:
        raise SkillValidationError(
            f"Skill output failed schema validation: {exc.message}"
        ) from exc


def validate_allowed_packages(skill_py_path: str, allowed_packages: list[str]) -> None:
    """Static analysis: parse the skill file and check all imports are allowed.

    Standard library modules are always permitted.
    Third-party imports must appear in allowed_packages.

    Raises:
        SkillValidationError: If a disallowed import is found.
    """
    with open(skill_py_path) as f:
        source = f.read()

    try:
        tree = ast.parse(source, filename=skill_py_path)
    except SyntaxError as exc:
        raise SkillValidationError(f"Skill has a syntax error: {exc}") from exc

    # Collect all imported top-level module names
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imported.add(node.module.split(".")[0])

    stdlib = _stdlib_modules()
    allowed_set = set(allowed_packages)

    disallowed = [
        pkg for pkg in imported
        if pkg not in stdlib and pkg not in allowed_set
    ]
    if disallowed:
        raise SkillValidationError(
            f"Skill imports disallowed package(s): {', '.join(sorted(disallowed))}. "
            f"Allowed: {', '.join(sorted(allowed_set)) or '(none)'}."
        )


def _parse_error_from_stderr(stderr: str) -> str:
    """Return the most useful single-line summary from a Python traceback."""
    lines = [l.rstrip() for l in stderr.splitlines() if l.strip()]
    if not lines:
        return ""
    # Last line is typically the exception class + message, which is the
    # most useful thing for the agent to relay to the user.
    return lines[-1]


def run_skill(
    skill_py_path: str,
    input_data: dict,
    context: dict,
    *,
    timeout_seconds: int = 30,
) -> dict:
    """Execute a skill script in a sandboxed subprocess.

    Always returns a dict.  On success the dict is whatever the skill printed.
    On any failure (timeout, crash, bad output) the dict is:

        {"ok": false, "error": "<code>", "message": "<human-readable>"}

    so the calling agent can reason about the error rather than crashing the run.

    Raises:
        SkillError: Only for truly unrecoverable runner-level bugs (should be rare).
    """
    skill_name = os.path.basename(skill_py_path)
    payload = json.dumps({"input": input_data, "context": context})

    with tempfile.TemporaryDirectory(prefix="swarm-skill-") as workdir:
        try:
            result = subprocess.run(
                [sys.executable, skill_py_path, payload],
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                cwd=workdir,
            )
        except subprocess.TimeoutExpired:
            logger.warning("Skill '%s' timed out after %ss", skill_name, timeout_seconds)
            return {
                "ok": False,
                "error": "timeout",
                "message": (
                    f"Skill '{skill_name}' exceeded its timeout of {timeout_seconds}s. "
                    "Consider increasing timeout_seconds in the skill YAML, or simplifying the operation."
                ),
            }

    if result.returncode != 0:
        stderr = result.stderr.strip()
        stdout = result.stdout.strip()

        # If the skill wrote valid JSON to stdout despite a non-zero exit, use it.
        # A skill may exit 1 after printing a structured error.
        if stdout:
            try:
                parsed = json.loads(stdout)
                if isinstance(parsed, dict):
                    if "ok" not in parsed:
                        parsed["ok"] = False
                    return parsed
            except (json.JSONDecodeError, ValueError):
                pass

        summary = _parse_error_from_stderr(stderr) if stderr else f"exited with code {result.returncode}"
        logger.warning("Skill '%s' crashed: %s", skill_name, summary)
        return {
            "ok": False,
            "error": "skill_crash",
            "message": summary,
            "detail": stderr[:2000] if stderr else "",
        }

    stdout = result.stdout.strip()
    if not stdout:
        logger.warning("Skill '%s' produced no stdout", skill_name)
        return {
            "ok": False,
            "error": "no_output",
            "message": f"Skill '{skill_name}' ran successfully but printed nothing to stdout.",
        }

    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        logger.warning("Skill '%s' stdout is not valid JSON: %s", skill_name, stdout[:200])
        return {
            "ok": False,
            "error": "invalid_json_output",
            "message": f"Skill '{skill_name}' did not return valid JSON.",
            "detail": stdout[:500],
        }


def _stdlib_modules() -> set[str]:
    """Return the set of standard library top-level module names."""
    try:
        return sys.stdlib_module_names  # Python 3.10+
    except AttributeError:
        # Fallback for older Python
        import sysconfig
        stdlib_path = sysconfig.get_paths()["stdlib"]
        names: set[str] = set()
        if os.path.isdir(stdlib_path):
            for entry in os.listdir(stdlib_path):
                name = entry.split(".")[0]
                if name.isidentifier():
                    names.add(name)
        return names
