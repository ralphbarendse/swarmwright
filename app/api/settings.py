"""Settings API blueprint — Phase 5.

All endpoints under `/api/v1/settings`. JSON in, JSON out. Reads are cheap;
writes encrypt-if-secret, hash, and audit-log in a single transaction.

Per docs/CLAUDE.md the audit log stores SHA-256 hashes only — never values,
encrypted or plaintext.
"""
from __future__ import annotations

import json
import logging
import os
import re
import xml.etree.ElementTree as ET
from typing import Any

from flask import Blueprint, current_app, g, jsonify, request, send_from_directory
from pydantic import BaseModel, ValidationError, field_validator
from sqlalchemy import desc, select

from app.core import secrets
from app.core.auth import require_admin, require_permission
from app.core.secrets import (
    EncryptionKeyError,
    SecretsError,
    decrypt,
    encrypt,
    generate_master_key,
    hash_value,
    mask_secret,
    re_encrypt,
    validate_master_key,
)
from app.db import get_session
from app.models.settings import (
    Setting,
    SettingsAudit,
    VALID_VALUE_TYPES,
    VALUE_TYPE_BOOLEAN,
    VALUE_TYPE_JSON,
    VALUE_TYPE_NUMBER,
    VALUE_TYPE_STRING,
)

logger = logging.getLogger(__name__)
bp = Blueprint("settings", __name__, url_prefix="/api/v1/settings")

_KEY_RE = re.compile(r"^[a-z][a-z0-9._-]*$")

_LOGO_MAX_BYTES = 200 * 1024
_LOGO_MAX_WIDTH = 400
_LOGO_MAX_HEIGHT = 100
_PROVIDERS = {"anthropic", "openai", "deepseek"}


# ── Pydantic request models ──────────────────────────────────────────────────

class SettingWrite(BaseModel):
    value: Any = None
    is_secret: bool = False
    value_type: str = VALUE_TYPE_STRING
    description: str | None = None
    reason: str | None = None

    @field_validator("value_type")
    @classmethod
    def _check_value_type(cls, v: str) -> str:
        if v not in VALID_VALUE_TYPES:
            raise ValueError(f"value_type must be one of {sorted(VALID_VALUE_TYPES)}")
        return v


class BulkUpdateItem(BaseModel):
    key: str
    value: Any = None
    is_secret: bool = False
    value_type: str = VALUE_TYPE_STRING
    description: str | None = None

    @field_validator("value_type")
    @classmethod
    def _check_value_type(cls, v: str) -> str:
        if v not in VALID_VALUE_TYPES:
            raise ValueError(f"value_type must be one of {sorted(VALID_VALUE_TYPES)}")
        return v


class BulkUpdateRequest(BaseModel):
    updates: list[BulkUpdateItem]
    reason: str | None = None


class LLMTestRequest(BaseModel):
    provider: str
    api_key: str

    @field_validator("provider")
    @classmethod
    def _check_provider(cls, v: str) -> str:
        if v.lower() not in _PROVIDERS:
            raise ValueError(f"provider must be one of {sorted(_PROVIDERS)}")
        return v.lower()


class RotateKeyRequest(BaseModel):
    new_key: str | None = None    # if absent, server generates
    reason: str | None = None


# ── Helpers ──────────────────────────────────────────────────────────────────

def _current_actor() -> str | None:
    user = g.get("current_user")
    return user.username if user else None


def _error(code: str, message: str, status: int = 400):
    return jsonify({"error": {"code": code, "message": message}}), status


def _validate_value(value: Any, value_type: str) -> None:
    """Raise ValueError if `value` does not match the declared `value_type`."""
    if value_type == VALUE_TYPE_STRING:
        if not isinstance(value, str):
            raise ValueError(f"Expected string, got {type(value).__name__}")
    elif value_type == VALUE_TYPE_NUMBER:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"Expected number, got {type(value).__name__}")
    elif value_type == VALUE_TYPE_BOOLEAN:
        if not isinstance(value, bool):
            raise ValueError(f"Expected boolean, got {type(value).__name__}")
    elif value_type == VALUE_TYPE_JSON:
        # any JSON-serialisable value is fine
        try:
            json.dumps(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Value is not JSON-serialisable: {exc}") from exc


def _serialize_for_storage(value: Any, *, is_secret: bool, value_type: str) -> str:
    """Return the string that goes into `Setting.value_encrypted`."""
    _validate_value(value, value_type)
    if is_secret:
        if not isinstance(value, str):
            raise ValueError("Secret values must be strings (the secret itself).")
        return encrypt(value)
    return json.dumps(value)


def _deserialize_value(stored: str | None, *, is_secret: bool):
    if stored is None or stored == "":
        return None
    if is_secret:
        return decrypt(stored)
    return json.loads(stored)


def _hash_for_audit(stored: str | None, *, is_secret: bool) -> str | None:
    """Return a SHA-256 hash suitable for the audit log, or None if no prior value."""
    if stored is None or stored == "":
        return None
    if is_secret:
        try:
            return hash_value(decrypt(stored))
        except SecretsError:
            return None
    return hash_value(stored)


def _row_to_dict(row: Setting, *, reveal: bool = False) -> dict:
    if row.is_secret:
        if not row.value_encrypted:
            value = "" if reveal else ""
        else:
            try:
                plain = decrypt(row.value_encrypted)
            except SecretsError:
                plain = None
            if reveal:
                value = plain
            else:
                value = mask_secret(plain or "")
    else:
        try:
            value = json.loads(row.value_encrypted) if row.value_encrypted else None
        except (TypeError, ValueError):
            value = None

    return {
        "key": row.key,
        "value": value,
        "is_secret": row.is_secret,
        "value_type": row.value_type,
        "description": row.description,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "updated_by": row.updated_by,
    }


def _upsert_setting(
    session,
    *,
    key: str,
    value: Any,
    is_secret: bool,
    value_type: str,
    description: str | None,
    actor: str | None,
    reason: str | None,
) -> Setting:
    """Upsert a single Setting row and append a SettingsAudit entry. Caller commits."""
    new_stored = _serialize_for_storage(value, is_secret=is_secret, value_type=value_type)

    row = session.get(Setting, key)
    previous_hash = _hash_for_audit(
        row.value_encrypted if row else None,
        is_secret=row.is_secret if row else is_secret,
    )

    if row is None:
        row = Setting(
            key=key,
            value_encrypted=new_stored,
            is_secret=is_secret,
            value_type=value_type,
            description=description,
            updated_by=actor,
        )
        session.add(row)
    else:
        row.value_encrypted = new_stored
        row.is_secret = is_secret
        row.value_type = value_type
        if description is not None:
            row.description = description
        row.updated_by = actor

    new_hash = hash_value(value if is_secret else new_stored) if is_secret else hash_value(new_stored)
    session.add(SettingsAudit(
        key=key,
        previous_value_hash=previous_hash,
        new_value_hash=new_hash,
        actor=actor,
        reason=reason,
    ))
    return row


# ── Routes: list / get / put / bulk ──────────────────────────────────────────

@bp.get("")
@require_permission("can_view_settings")
def list_settings():
    with get_session() as session:
        rows = session.execute(select(Setting).order_by(Setting.key)).scalars().all()
        return jsonify([_row_to_dict(r) for r in rows])


@bp.get("/audit")
@require_permission("can_view_settings")
def audit_log():
    key = request.args.get("key")
    try:
        limit = max(1, min(int(request.args.get("limit", "50")), 500))
    except ValueError:
        return _error("validation_error", "limit must be an integer", 400)

    with get_session() as session:
        stmt = select(SettingsAudit).order_by(desc(SettingsAudit.changed_at)).limit(limit)
        if key:
            stmt = select(SettingsAudit).where(SettingsAudit.key == key).order_by(
                desc(SettingsAudit.changed_at)
            ).limit(limit)
        rows = session.execute(stmt).scalars().all()
        return jsonify([r.to_dict() for r in rows])


@bp.put("")
@require_admin
def bulk_update():
    try:
        body = BulkUpdateRequest.model_validate(request.get_json(force=True) or {})
    except ValidationError as exc:
        return _error("validation_error", str(exc), 400)

    if not body.updates:
        return _error("validation_error", "updates list is empty", 400)

    for item in body.updates:
        if not _KEY_RE.match(item.key):
            return _error(
                "validation_error",
                f"Invalid key {item.key!r} (must match [a-z][a-z0-9._-]*)",
                400,
            )
        try:
            _validate_value(item.value, item.value_type)
            if item.is_secret and not isinstance(item.value, str):
                raise ValueError("Secret values must be strings.")
        except ValueError as exc:
            return _error("validation_error", f"{item.key}: {exc}", 400)

    with get_session() as session:
        results = []
        for item in body.updates:
            row = _upsert_setting(
                session,
                key=item.key,
                value=item.value,
                is_secret=item.is_secret,
                value_type=item.value_type,
                description=item.description,
                actor=_current_actor(),
                reason=body.reason,
            )
            results.append(row.key)
        session.commit()

        rows = session.execute(
            select(Setting).where(Setting.key.in_(results)).order_by(Setting.key)
        ).scalars().all()
        return jsonify({"updated": [_row_to_dict(r) for r in rows]})


@bp.post("/llm/test")
@require_permission("can_view_settings")
def llm_test_connection():
    try:
        body = LLMTestRequest.model_validate(request.get_json(force=True) or {})
    except ValidationError as exc:
        return _error("validation_error", str(exc), 400)

    # Format prevalidation: each provider has a known prefix. Catches obvious
    # paste mistakes before we even attempt a network call.
    if body.provider == "anthropic" and not body.api_key.startswith("sk-ant-"):
        return jsonify({"ok": False, "message": "Invalid Anthropic key format"}), 200
    if body.provider == "openai" and not body.api_key.startswith("sk-"):
        return jsonify({"ok": False, "message": "Invalid OpenAI key format"}), 200
    if body.provider == "deepseek" and not body.api_key.startswith("sk-"):
        return jsonify({"ok": False, "message": "Invalid Deepseek key format"}), 200

    # Make a cheap probe call. Errors must NEVER include the api_key value.
    try:
        from app.core.llm import LLMClient

        client = LLMClient(provider=body.provider, api_key=body.api_key)
        # 1-token probe — provider-agnostic via the wrapper.
        client.complete(system="ping", messages=[{"role": "user", "content": "hi"}], max_tokens=1)
        return jsonify({"ok": True, "message": "Connection successful"}), 200
    except Exception as exc:  # noqa: BLE001 — surface error class without value leakage
        raw = str(exc)
        key_leaked = body.api_key in raw
        if key_leaked:
            logger.warning("LLM test error contained api_key — sanitised before responding")
        safe = raw.replace(body.api_key, "***") if key_leaked else raw
        status_code = getattr(exc, "status_code", None)
        detail = f"{type(exc).__name__} {status_code}: {safe}" if status_code else f"{type(exc).__name__}: {safe}"
        logger.error("LLM test failed for provider %s: %s", body.provider, detail)
        return jsonify({"ok": False, "message": f"Connection failed: {detail}"}), 200


@bp.post("/security/rotate-key")
@require_admin
def rotate_master_key():
    try:
        body = RotateKeyRequest.model_validate(request.get_json(force=True) or {})
    except ValidationError as exc:
        return _error("validation_error", str(exc), 400)

    new_key = body.new_key or generate_master_key()
    try:
        validate_master_key(new_key)
    except EncryptionKeyError as exc:
        return _error("validation_error", str(exc), 400)

    with get_session() as session:
        secret_rows = session.execute(
            select(Setting).where(Setting.is_secret.is_(True))
        ).scalars().all()

        rotated = 0
        for row in secret_rows:
            if not row.value_encrypted:
                continue
            try:
                row.value_encrypted = re_encrypt(row.value_encrypted, new_key)
                rotated += 1
            except SecretsError as exc:
                # Abort the entire rotation if any row fails — atomicity matters.
                session.rollback()
                return _error(
                    "rotation_failed",
                    f"Could not re-encrypt setting {row.key!r}: {exc}",
                    500,
                )

        # Update encryption_key_id with a short fingerprint of the new key,
        # for audit/traceability. The full key is never stored.
        key_id = hash_value(new_key)[:12]
        existing = session.get(Setting, "security.encryption_key_id")
        if existing is None:
            session.add(Setting(
                key="security.encryption_key_id",
                value_encrypted=json.dumps(key_id),
                is_secret=False,
                value_type=VALUE_TYPE_STRING,
                updated_by=_current_actor(),
            ))
        else:
            existing.value_encrypted = json.dumps(key_id)
            existing.updated_by = _current_actor()

        session.add(SettingsAudit(
            key="_rotation_event",
            previous_value_hash=None,
            new_value_hash=hash_value(new_key),
            actor=_current_actor(),
            reason=body.reason,
        ))
        session.commit()

    # The new key is returned to the caller exactly once. The operator must
    # update SWARM_ENCRYPTION_KEY before the next container restart, or the
    # process will be unable to decrypt.
    return jsonify({
        "ok": True,
        "rotated_count": rotated,
        "new_key": new_key,
        "encryption_key_id": key_id,
        "message": (
            "Update SWARM_ENCRYPTION_KEY in your environment before the next "
            "container restart, or the system will not be able to decrypt."
        ),
    }), 200


@bp.post("/branding/logo")
@require_admin
def upload_logo():
    if "file" not in request.files:
        return _error("validation_error", "Missing 'file' field in multipart form", 400)
    f = request.files["file"]
    if not f.filename:
        return _error("validation_error", "Empty filename", 400)

    data = f.read()
    if len(data) == 0:
        return _error("validation_error", "Uploaded file is empty", 400)
    if len(data) > _LOGO_MAX_BYTES:
        return _error(
            "file_too_large",
            f"Logo must be ≤ {_LOGO_MAX_BYTES} bytes (got {len(data)})",
            413,
        )

    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in (".png", ".svg"):
        return _error("invalid_format", "Logo must be PNG or SVG", 415)

    try:
        if ext == ".png":
            w, h = _png_dimensions(data)
        else:
            dims = _svg_dimensions(data)
            if dims is None:
                # Responsive SVG without explicit dimensions — accept it.
                w = h = 0
            else:
                w, h = dims
    except ValueError as exc:
        return _error("invalid_format", str(exc), 400)

    if w > _LOGO_MAX_WIDTH or h > _LOGO_MAX_HEIGHT:
        return _error(
            "dimensions_too_large",
            f"Logo dimensions {w}×{h}px exceed limit {_LOGO_MAX_WIDTH}×{_LOGO_MAX_HEIGHT}px",
            400,
        )

    data_dir = current_app.config["DATA_DIR"]
    branding_dir = os.path.join(data_dir, "branding")
    os.makedirs(branding_dir, exist_ok=True)
    target = os.path.join(branding_dir, f"logo{ext}")
    tmp = target + ".tmp"
    with open(tmp, "wb") as out:
        out.write(data)
    os.replace(tmp, target)

    relative = os.path.relpath(target, data_dir)
    with get_session() as session:
        _upsert_setting(
            session,
            key="branding.logo_path",
            value=relative,
            is_secret=False,
            value_type=VALUE_TYPE_STRING,
            description="Path to the uploaded logo, relative to DATA_DIR.",
            actor=_current_actor(),
            reason=request.form.get("reason"),
        )
        session.commit()

    return jsonify({
        "ok": True,
        "path": relative,
        "width": w,
        "height": h,
        "size_bytes": len(data),
    }), 200


@bp.delete("/branding/logo")
@require_admin
def delete_logo():
    """Delete the uploaded logo file(s) and clear branding.logo_path."""
    data_dir = current_app.config["DATA_DIR"]
    branding_dir = os.path.join(data_dir, "branding")
    deleted = []
    for fname in ("logo.svg", "logo.png"):
        path = os.path.join(branding_dir, fname)
        if os.path.isfile(path):
            os.remove(path)
            deleted.append(fname)

    with get_session() as session:
        _upsert_setting(
            session,
            key="branding.logo_path",
            value="",
            is_secret=False,
            value_type=VALUE_TYPE_STRING,
            description="Path to the uploaded logo, relative to DATA_DIR.",
            actor=None,
            reason="logo deleted",
        )
        session.commit()

    return jsonify({"ok": True, "deleted": deleted})


@bp.get("/branding/logo")
def serve_logo():
    """Stream the uploaded logo file referenced by ``branding.logo_path``.

    The upload endpoint stores the file at ``<DATA_DIR>/branding/logo.{png,svg}``
    and the GUI references it via this route. Returns 404 if no logo has been
    uploaded yet.
    """
    data_dir = current_app.config["DATA_DIR"]
    branding_dir = os.path.join(data_dir, "branding")
    if not os.path.isdir(branding_dir):
        return _error("not_found", "No logo uploaded", 404)
    # Prefer SVG over PNG when both exist (rare; the upload endpoint replaces
    # whichever extension is uploaded but doesn't delete the other variant).
    for fname in ("logo.svg", "logo.png"):
        path = os.path.join(branding_dir, fname)
        if os.path.isfile(path):
            return send_from_directory(branding_dir, fname)
    return _error("not_found", "No logo uploaded", 404)


@bp.post("/system/packages/install")
@require_admin
def install_package():
    """Pip-install a package into the current Python environment.

    Adds the package to ``system.allowed_packages`` only when installation
    succeeds. Idempotent: re-installing an already-present package is fine.
    """
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()
    if not name or not re.match(r"^[A-Za-z0-9_][A-Za-z0-9_.\-]*$", name):
        return _error("validation_error", "Invalid package name", 400)

    import importlib.metadata
    import subprocess
    import sys

    # Skip pip entirely when the distribution is already present.
    try:
        importlib.metadata.version(name)
        already_installed = True
        output = f"{name} is already installed."
    except importlib.metadata.PackageNotFoundError:
        already_installed = False
        output = ""

    if not already_installed:
        try:
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", name],
                capture_output=True,
                text=True,
                timeout=120,
            )
        except subprocess.TimeoutExpired:
            return jsonify({"ok": False, "output": "pip install timed out after 120s"}), 200
        except Exception as exc:
            return jsonify({"ok": False, "output": str(exc)}), 200

        output = (result.stdout + result.stderr).strip()
        if result.returncode != 0:
            return jsonify({"ok": False, "output": output}), 200

    # Persist the package into the global allowlist
    with get_session() as session:
        row = session.get(Setting, "system.allowed_packages")
        existing: list = json.loads(row.value_encrypted) if (row and row.value_encrypted) else []
        if name not in existing:
            _upsert_setting(
                session,
                key="system.allowed_packages",
                value=existing + [name],
                is_secret=False,
                value_type=VALUE_TYPE_JSON,
                description="Packages allowed in skill .yaml files and installed in the runtime.",
                actor=_current_actor(),
                reason="installed via UI",
            )
            session.commit()

    return jsonify({"ok": True, "output": output, "already_installed": already_installed}), 200


@bp.get("/system/packages/check")
def check_package_installed():
    """Return whether a package is installed in this container.

    Checks by distribution name (e.g. "beautifulsoup4") via importlib.metadata,
    which correctly resolves packages whose import name differs from their PyPI
    name (beautifulsoup4 → bs4, pillow → PIL, pyyaml → yaml, etc.).
    """
    name = (request.args.get("name") or "").strip()
    if not name or not re.match(r"^[A-Za-z0-9_][A-Za-z0-9_.\-]*$", name):
        return _error("validation_error", "Invalid package name", 400)
    import importlib.metadata
    try:
        importlib.metadata.version(name)
        installed = True
    except importlib.metadata.PackageNotFoundError:
        installed = False
    return jsonify({"name": name, "installed": installed})


# ── Catch-all single-key routes (registered after specific routes) ───────────

@bp.get("/<string:key>")
@require_permission("can_view_settings")
def get_setting(key: str):
    with get_session() as session:
        row = session.get(Setting, key)
        if not row:
            return _error("not_found", f"Setting {key!r} not found", 404)
        return jsonify(_row_to_dict(row))


@bp.put("/<string:key>")
@require_admin
def put_setting(key: str):
    if not _KEY_RE.match(key):
        return _error("validation_error", f"Invalid key {key!r}", 400)
    try:
        body = SettingWrite.model_validate(request.get_json(force=True) or {})
    except ValidationError as exc:
        return _error("validation_error", str(exc), 400)

    try:
        _validate_value(body.value, body.value_type)
        if body.is_secret and not isinstance(body.value, str):
            raise ValueError("Secret values must be strings.")
    except ValueError as exc:
        return _error("validation_error", str(exc), 400)

    with get_session() as session:
        row = _upsert_setting(
            session,
            key=key,
            value=body.value,
            is_secret=body.is_secret,
            value_type=body.value_type,
            description=body.description,
            actor=_current_actor(),
            reason=body.reason,
        )
        session.commit()
        # Re-fetch to get server-generated timestamp
        row = session.get(Setting, key)
        return jsonify(_row_to_dict(row))


# ── Image dimension helpers (no Pillow dependency) ───────────────────────────

def _png_dimensions(data: bytes) -> tuple[int, int]:
    """Parse width/height from a PNG IHDR chunk."""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("File is not a PNG")
    w = int.from_bytes(data[16:20], "big")
    h = int.from_bytes(data[20:24], "big")
    return w, h


def _svg_dimensions(data: bytes) -> tuple[int, int] | None:
    """Parse width/height from an SVG `<svg>` root tag, falling back to `viewBox`.

    Returns (w, h) in CSS pixels, or None if the SVG is intentionally responsive.
    """
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise ValueError(f"Invalid SVG XML: {exc}") from exc

    tag = root.tag.lower()
    if not (tag.endswith("}svg") or tag == "svg"):
        raise ValueError("Root element is not <svg>")

    def _to_int(s: str | None) -> int | None:
        if not s:
            return None
        m = re.match(r"^([0-9]+(?:\.[0-9]+)?)", s.strip())
        return int(float(m.group(1))) if m else None

    w = _to_int(root.get("width"))
    h = _to_int(root.get("height"))
    if w is not None and h is not None:
        return w, h

    vb = (root.get("viewBox") or "").split()
    if len(vb) == 4:
        try:
            return int(float(vb[2])), int(float(vb[3]))
        except ValueError:
            return None
    return None
