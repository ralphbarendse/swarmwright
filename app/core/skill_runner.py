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
    """Raised when a skill fails to execute or validate."""


class SkillTimeoutError(SkillError):
    """Raised when a skill exceeds its configured timeout."""


class SkillValidationError(SkillError):
    """Raised when a skill's input or output fails schema validation."""


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

    Raises:
        SkillValidationError: If the output does not conform to the schema.
    """
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


def run_skill(
    skill_py_path: str,
    input_data: dict,
    context: dict,
    *,
    timeout_seconds: int = 30,
) -> dict:
    """Execute a skill script in a sandboxed subprocess.

    The skill receives {"input": ..., "context": ...} as a JSON string in argv[1].
    It must print a single JSON object to stdout and exit 0 on success.

    Args:
        skill_py_path:   Absolute path to the skill .py file.
        input_data:      Validated input dict for the skill.
        context:         Read-only metadata (run_id, agent_name, etc.).
        timeout_seconds: Hard kill timeout.

    Returns:
        The skill's parsed JSON output dict.

    Raises:
        SkillTimeoutError:    If the skill exceeds its timeout.
        SkillError:           If the skill exits non-zero or stdout is not valid JSON.
    """
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
        except subprocess.TimeoutExpired as exc:
            raise SkillTimeoutError(
                f"Skill '{os.path.basename(skill_py_path)}' exceeded timeout of {timeout_seconds}s"
            ) from exc

    if result.returncode != 0:
        stderr = result.stderr.strip()[:500]
        raise SkillError(
            f"Skill '{os.path.basename(skill_py_path)}' exited with code {result.returncode}. "
            f"stderr: {stderr}"
        )

    stdout = result.stdout.strip()
    if not stdout:
        raise SkillError(
            f"Skill '{os.path.basename(skill_py_path)}' produced no output on stdout."
        )

    try:
        return json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise SkillError(
            f"Skill '{os.path.basename(skill_py_path)}' stdout is not valid JSON: {exc}. "
            f"Output was: {stdout[:200]}"
        ) from exc


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
