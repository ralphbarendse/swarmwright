"""Tests for app/core/skill_runner.py — subprocess sandbox and timeout (item 8)."""
from __future__ import annotations

import os
import textwrap

import pytest

from app.core.skill_runner import (
    SkillError,
    SkillTimeoutError,
    SkillValidationError,
    run_skill,
    validate_allowed_packages,
    validate_skill_input,
    validate_skill_output,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture()
def skill_dir(tmp_path):
    return tmp_path


def _write_skill(skill_dir, name: str, source: str) -> str:
    path = os.path.join(skill_dir, f"{name}.py")
    with open(path, "w") as f:
        f.write(textwrap.dedent(source))
    return path


# ── Happy path ────────────────────────────────────────────────────────────────

def test_run_skill_returns_json(skill_dir):
    path = _write_skill(skill_dir, "echo", """
        import sys, json
        payload = json.loads(sys.argv[1])
        print(json.dumps({"echo": payload["input"]["message"]}))
    """)
    result = run_skill(path, {"message": "hello"}, {})
    assert result == {"echo": "hello"}


def test_run_skill_receives_context(skill_dir):
    path = _write_skill(skill_dir, "ctx", """
        import sys, json
        payload = json.loads(sys.argv[1])
        print(json.dumps({"run_id": payload["context"]["run_id"]}))
    """)
    result = run_skill(path, {}, {"run_id": "test-run"})
    assert result["run_id"] == "test-run"


# ── Item 8: timeout kills the skill ──────────────────────────────────────────

def test_skill_timeout_raises(skill_dir):
    """Item 8 — a skill that exceeds its timeout raises SkillTimeoutError."""
    path = _write_skill(skill_dir, "sleeper", """
        import time
        time.sleep(30)
    """)
    with pytest.raises(SkillTimeoutError, match="exceeded timeout"):
        run_skill(path, {}, {}, timeout_seconds=1)


def test_skill_nonzero_exit_raises(skill_dir):
    path = _write_skill(skill_dir, "fail", """
        import sys
        sys.exit(1)
    """)
    with pytest.raises(SkillError, match="exited with code 1"):
        run_skill(path, {}, {})


def test_skill_no_output_raises(skill_dir):
    path = _write_skill(skill_dir, "silent", """
        pass  # prints nothing
    """)
    with pytest.raises(SkillError, match="no output"):
        run_skill(path, {}, {})


def test_skill_non_json_output_raises(skill_dir):
    path = _write_skill(skill_dir, "nonjson", """
        print("this is not json")
    """)
    with pytest.raises(SkillError, match="not valid JSON"):
        run_skill(path, {}, {})


# ── Package validation ────────────────────────────────────────────────────────

def test_validate_allowed_packages_passes(skill_dir):
    path = _write_skill(skill_dir, "stdlib_only", """
        import json
        import os
        import sys
    """)
    validate_allowed_packages(path, [])  # stdlib always allowed — should not raise


def test_validate_allowed_packages_blocks_third_party(skill_dir):
    path = _write_skill(skill_dir, "uses_requests", """
        import requests
    """)
    with pytest.raises(SkillValidationError, match="disallowed"):
        validate_allowed_packages(path, [])


def test_validate_allowed_packages_permits_declared(skill_dir):
    path = _write_skill(skill_dir, "allowed_requests", """
        import requests
    """)
    validate_allowed_packages(path, ["requests"])  # should not raise


def test_validate_syntax_error(skill_dir):
    path = _write_skill(skill_dir, "broken", """
        def broken(:
            pass
    """)
    with pytest.raises(SkillValidationError, match="syntax error"):
        validate_allowed_packages(path, [])


# ── Schema validation (gap: input/output validation) ─────────────────────────

_AMOUNT_INPUT_SCHEMA = {
    "type": "object",
    "required": ["amount"],
    "properties": {
        "amount": {"type": "number"},
        "currency": {"type": "string"},
    },
}

_AMOUNT_OUTPUT_SCHEMA = {
    "type": "object",
    "required": ["valid", "reason"],
    "properties": {
        "valid": {"type": "boolean"},
        "reason": {"type": "string"},
    },
}


def test_validate_skill_input_passes():
    validate_skill_input({"amount": 1500.0, "currency": "EUR"}, _AMOUNT_INPUT_SCHEMA)


def test_validate_skill_input_fails_missing_required():
    with pytest.raises(SkillValidationError, match="schema validation"):
        validate_skill_input({"currency": "EUR"}, _AMOUNT_INPUT_SCHEMA)  # missing amount


def test_validate_skill_input_fails_wrong_type():
    with pytest.raises(SkillValidationError, match="schema validation"):
        validate_skill_input({"amount": "not-a-number"}, _AMOUNT_INPUT_SCHEMA)


def test_validate_skill_output_passes():
    validate_skill_output({"valid": True, "reason": "OK"}, _AMOUNT_OUTPUT_SCHEMA)


def test_validate_skill_output_fails_missing_field():
    with pytest.raises(SkillValidationError, match="schema validation"):
        validate_skill_output({"valid": True}, _AMOUNT_OUTPUT_SCHEMA)  # missing reason


def test_run_skill_with_schema_validation(skill_dir):
    """End-to-end: run_skill + schema validation round-trip."""
    path = _write_skill(skill_dir, "validated", """
        import sys, json
        payload = json.loads(sys.argv[1])
        amount = payload["input"]["amount"]
        print(json.dumps({"valid": amount > 0, "reason": "checked"}))
    """)
    result = run_skill(path, {"amount": 100}, {})
    validate_skill_output(result, _AMOUNT_OUTPUT_SCHEMA)
    assert result["valid"] is True
