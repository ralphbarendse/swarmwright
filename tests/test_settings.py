from __future__ import annotations

import io
import json

import pytest
from sqlalchemy import select

from app.core.secrets import decrypt, generate_master_key, hash_value
from app.db import get_session
from app.models.settings import Setting, SettingsAudit


# ── Helpers ──────────────────────────────────────────────────────────────────

def _clear(app, *keys: str) -> None:
    """Delete the given settings rows and any audit history for them."""
    with app.app_context():
        with get_session() as session:
            for k in keys:
                row = session.get(Setting, k)
                if row:
                    session.delete(row)
            session.execute(
                SettingsAudit.__table__.delete().where(SettingsAudit.key.in_(keys))
            )
            session.commit()


def _make_png(width: int, height: int, *, pad: int = 0) -> bytes:
    """Construct a byte sequence that satisfies our PNG dimension parser.

    Not a fully renderable PNG, but our parser only inspects the signature and
    IHDR bytes 16..24 — enough to exercise the upload validation path.
    """
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr_data = width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00"
    ihdr = b"\x00\x00\x00\r" + b"IHDR" + ihdr_data + b"\x00" * 4
    return sig + ihdr + (b"\x00" * pad)


# ── Single-setting CRUD ──────────────────────────────────────────────────────

class TestSingleSettingCRUD:
    def test_put_and_get_string_setting(self, client, app):
        _clear(app, "branding.app_name")
        r = client.put(
            "/api/v1/settings/branding.app_name",
            json={"value": "Acme", "value_type": "string"},
        )
        assert r.status_code == 200
        assert r.get_json()["value"] == "Acme"

        r2 = client.get("/api/v1/settings/branding.app_name")
        assert r2.status_code == 200
        body = r2.get_json()
        assert body["key"] == "branding.app_name"
        assert body["value"] == "Acme"
        assert body["is_secret"] is False
        assert body["value_type"] == "string"

    def test_put_json_value_round_trip(self, client, app):
        _clear(app, "models.available")
        models = ["claude-opus-4-7", "claude-sonnet-4-6", "gpt-4o"]
        r = client.put(
            "/api/v1/settings/models.available",
            json={"value": models, "value_type": "json"},
        )
        assert r.status_code == 200
        assert r.get_json()["value"] == models

    def test_get_unknown_returns_404(self, client):
        r = client.get("/api/v1/settings/no.such.thing")
        assert r.status_code == 404

    def test_put_invalid_key_rejected(self, client):
        r = client.put("/api/v1/settings/Invalid--KEY", json={"value": "x"})
        assert r.status_code == 400
        assert r.get_json()["error"]["code"] == "validation_error"

    def test_put_string_with_number_value_rejected(self, client, app):
        _clear(app, "branding.app_name")
        r = client.put(
            "/api/v1/settings/branding.app_name",
            json={"value": 42, "value_type": "string"},
        )
        assert r.status_code == 400

    def test_put_unknown_value_type_rejected(self, client, app):
        _clear(app, "x.y")
        r = client.put(
            "/api/v1/settings/x.y",
            json={"value": "v", "value_type": "blob"},
        )
        assert r.status_code == 400


# ── Secret handling ──────────────────────────────────────────────────────────

class TestSecretSettings:
    def test_secret_round_trip_through_db_is_encrypted(self, client, app):
        _clear(app, "llm.anthropic.api_key")
        r = client.put(
            "/api/v1/settings/llm.anthropic.api_key",
            json={
                "value": "sk-ant-api03-PLAINTEXT-SECRET-DO-NOT-LEAK",
                "is_secret": True,
                "value_type": "string",
            },
        )
        assert r.status_code == 200

        with app.app_context():
            with get_session() as session:
                row = session.get(Setting, "llm.anthropic.api_key")
        assert row is not None
        assert "PLAINTEXT-SECRET-DO-NOT-LEAK" not in (row.value_encrypted or "")
        with app.app_context():
            assert decrypt(row.value_encrypted) == "sk-ant-api03-PLAINTEXT-SECRET-DO-NOT-LEAK"

    def test_get_secret_returns_masked_value(self, client, app):
        _clear(app, "llm.anthropic.api_key")
        client.put(
            "/api/v1/settings/llm.anthropic.api_key",
            json={"value": "sk-ant-supersecret-3F2A", "is_secret": True},
        )
        r = client.get("/api/v1/settings/llm.anthropic.api_key")
        assert r.status_code == 200
        body = r.get_json()
        assert "supersecret" not in body["value"]
        assert body["value"].endswith("3F2A")
        assert body["value"].startswith("*")

    def test_secret_iv_randomness(self, client, app):
        _clear(app, "llm.anthropic.api_key")
        plaintext = "sk-ant-same-value-each-time"
        client.put(
            "/api/v1/settings/llm.anthropic.api_key",
            json={"value": plaintext, "is_secret": True},
        )
        with app.app_context():
            with get_session() as session:
                first = session.get(Setting, "llm.anthropic.api_key").value_encrypted
        client.put(
            "/api/v1/settings/llm.anthropic.api_key",
            json={"value": plaintext, "is_secret": True},
        )
        with app.app_context():
            with get_session() as session:
                second = session.get(Setting, "llm.anthropic.api_key").value_encrypted
        assert first != second
        with app.app_context():
            assert decrypt(first) == decrypt(second) == plaintext

    def test_put_secret_with_non_string_rejected(self, client, app):
        _clear(app, "llm.anthropic.api_key")
        r = client.put(
            "/api/v1/settings/llm.anthropic.api_key",
            json={"value": 42, "is_secret": True},
        )
        assert r.status_code == 400


# ── List + bulk update ───────────────────────────────────────────────────────

class TestListAndBulk:
    def test_list_returns_settings_sorted_by_key(self, client, app):
        keys = ["aaa.first", "zzz.last", "mmm.middle"]
        _clear(app, *keys)
        for k in keys:
            client.put(f"/api/v1/settings/{k}", json={"value": k})

        r = client.get("/api/v1/settings")
        assert r.status_code == 200
        rows = r.get_json()
        names = [row["key"] for row in rows if row["key"] in keys]
        assert names == sorted(keys)

    def test_bulk_update_atomic(self, client, app):
        _clear(app, "system.log_level", "system.scheduler_timezone")
        r = client.put(
            "/api/v1/settings",
            json={
                "updates": [
                    {"key": "system.log_level", "value": "DEBUG"},
                    {"key": "system.scheduler_timezone", "value": "UTC"},
                ],
                "reason": "tightening up",
            },
        )
        assert r.status_code == 200
        body = r.get_json()
        assert {u["key"] for u in body["updated"]} == {
            "system.log_level",
            "system.scheduler_timezone",
        }
        assert client.get("/api/v1/settings/system.log_level").get_json()["value"] == "DEBUG"

    def test_bulk_update_empty_rejected(self, client):
        r = client.put("/api/v1/settings", json={"updates": []})
        assert r.status_code == 400


# ── Audit log ────────────────────────────────────────────────────────────────

class TestAuditLog:
    def test_audit_row_recorded_on_put(self, client, app):
        _clear(app, "branding.app_name")
        client.put("/api/v1/settings/branding.app_name", json={"value": "First"})

        with app.app_context():
            with get_session() as session:
                rows = session.execute(
                    select(SettingsAudit).where(SettingsAudit.key == "branding.app_name")
                ).scalars().all()
        assert len(rows) == 1
        assert rows[0].previous_value_hash is None
        assert rows[0].new_value_hash == hash_value(json.dumps("First"))

    def test_audit_chains_previous_value_hash(self, client, app):
        _clear(app, "branding.app_name")
        client.put("/api/v1/settings/branding.app_name", json={"value": "v1"})
        client.put("/api/v1/settings/branding.app_name", json={"value": "v2"})

        with app.app_context():
            with get_session() as session:
                rows = session.execute(
                    select(SettingsAudit)
                    .where(SettingsAudit.key == "branding.app_name")
                    .order_by(SettingsAudit.changed_at)
                ).scalars().all()
        assert len(rows) == 2
        assert rows[1].previous_value_hash == hash_value(json.dumps("v1"))
        assert rows[1].new_value_hash == hash_value(json.dumps("v2"))

    def test_audit_for_secret_uses_plaintext_hash(self, client, app):
        _clear(app, "llm.anthropic.api_key")
        client.put(
            "/api/v1/settings/llm.anthropic.api_key",
            json={"value": "sk-ant-v1", "is_secret": True},
        )
        client.put(
            "/api/v1/settings/llm.anthropic.api_key",
            json={"value": "sk-ant-v2", "is_secret": True},
        )

        with app.app_context():
            with get_session() as session:
                rows = session.execute(
                    select(SettingsAudit)
                    .where(SettingsAudit.key == "llm.anthropic.api_key")
                    .order_by(SettingsAudit.changed_at)
                ).scalars().all()
        assert rows[0].new_value_hash == hash_value("sk-ant-v1")
        assert rows[1].previous_value_hash == hash_value("sk-ant-v1")
        assert rows[1].new_value_hash == hash_value("sk-ant-v2")
        for r in rows:
            assert "sk-ant" not in (r.new_value_hash or "")
            assert "sk-ant" not in (r.previous_value_hash or "")

    def test_audit_endpoint_filters_by_key(self, client, app):
        _clear(app, "k.alpha", "k.beta")
        client.put("/api/v1/settings/k.alpha", json={"value": "a"})
        client.put("/api/v1/settings/k.beta", json={"value": "b"})

        r = client.get("/api/v1/settings/audit?key=k.alpha")
        assert r.status_code == 200
        rows = r.get_json()
        assert rows
        assert all(row["key"] == "k.alpha" for row in rows)


# ── LLM test endpoint ────────────────────────────────────────────────────────

class TestLLMTest:
    def test_unknown_provider_rejected(self, client):
        r = client.post(
            "/api/v1/settings/llm/test", json={"provider": "google", "api_key": "x"}
        )
        assert r.status_code == 400

    def test_anthropic_bad_prefix_returns_ok_false(self, client):
        r = client.post(
            "/api/v1/settings/llm/test",
            json={"provider": "anthropic", "api_key": "wrong-prefix-key"},
        )
        assert r.status_code == 200
        body = r.get_json()
        assert body["ok"] is False
        assert "format" in body["message"].lower()

    def test_openai_bad_prefix_returns_ok_false(self, client):
        r = client.post(
            "/api/v1/settings/llm/test",
            json={"provider": "openai", "api_key": "definitely-not-openai"},
        )
        assert r.status_code == 200
        body = r.get_json()
        assert body["ok"] is False

    def test_response_never_echoes_api_key(self, client):
        api_key = "sk-ant-this-key-must-never-leak-into-response"
        r = client.post(
            "/api/v1/settings/llm/test",
            json={"provider": "anthropic", "api_key": api_key},
        )
        assert r.status_code == 200
        assert api_key not in r.get_data(as_text=True)


# ── Logo upload ──────────────────────────────────────────────────────────────

class TestLogoUpload:
    def test_missing_file_rejected(self, client):
        r = client.post("/api/v1/settings/branding/logo", data={})
        assert r.status_code == 400

    def test_oversized_rejected(self, client):
        big = _make_png(100, 50, pad=300_000)
        r = client.post(
            "/api/v1/settings/branding/logo",
            data={"file": (io.BytesIO(big), "logo.png")},
            content_type="multipart/form-data",
        )
        assert r.status_code == 413
        assert r.get_json()["error"]["code"] == "file_too_large"

    def test_wrong_extension_rejected(self, client):
        r = client.post(
            "/api/v1/settings/branding/logo",
            data={"file": (io.BytesIO(b"hello"), "logo.jpg")},
            content_type="multipart/form-data",
        )
        assert r.status_code == 415

    def test_oversized_dimensions_rejected(self, client):
        png = _make_png(800, 50)
        r = client.post(
            "/api/v1/settings/branding/logo",
            data={"file": (io.BytesIO(png), "logo.png")},
            content_type="multipart/form-data",
        )
        assert r.status_code == 400
        assert r.get_json()["error"]["code"] == "dimensions_too_large"

    def test_valid_png_accepted(self, client, app):
        _clear(app, "branding.logo_path")
        png = _make_png(200, 60)
        r = client.post(
            "/api/v1/settings/branding/logo",
            data={"file": (io.BytesIO(png), "logo.png")},
            content_type="multipart/form-data",
        )
        assert r.status_code == 200
        body = r.get_json()
        assert body["width"] == 200
        assert body["height"] == 60
        r2 = client.get("/api/v1/settings/branding.logo_path")
        assert r2.status_code == 200

    def test_valid_svg_with_dimensions_accepted(self, client, app):
        _clear(app, "branding.logo_path")
        svg = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="300" height="80"><rect/></svg>'
        r = client.post(
            "/api/v1/settings/branding/logo",
            data={"file": (io.BytesIO(svg), "logo.svg")},
            content_type="multipart/form-data",
        )
        assert r.status_code == 200
        body = r.get_json()
        assert body["width"] == 300
        assert body["height"] == 80


# ── Master-key rotation ──────────────────────────────────────────────────────

class TestKeyRotation:
    def test_rotation_re_encrypts_secrets_with_new_key(self, client, app):
        from cryptography.fernet import Fernet

        _clear(app, "llm.anthropic.api_key", "security.encryption_key_id", "_rotation_event")

        plaintext = "sk-ant-rotate-me"
        client.put(
            "/api/v1/settings/llm.anthropic.api_key",
            json={"value": plaintext, "is_secret": True},
        )

        new_key = generate_master_key()
        r = client.post("/api/v1/settings/security/rotate-key", json={"new_key": new_key})
        assert r.status_code == 200
        body = r.get_json()
        assert body["ok"] is True
        assert body["rotated_count"] >= 1
        assert body["new_key"] == new_key

        with app.app_context():
            with get_session() as session:
                row = session.get(Setting, "llm.anthropic.api_key")
        assert Fernet(new_key.encode()).decrypt(row.value_encrypted.encode()).decode() == plaintext

        with app.app_context():
            with get_session() as session:
                events = session.execute(
                    select(SettingsAudit).where(SettingsAudit.key == "_rotation_event")
                ).scalars().all()
        assert len(events) == 1
        assert events[0].new_value_hash == hash_value(new_key)

        r2 = client.get("/api/v1/settings/security.encryption_key_id")
        assert r2.status_code == 200
        assert len(r2.get_json()["value"]) == 12

    def test_rotation_rejects_invalid_new_key(self, client):
        r = client.post(
            "/api/v1/settings/security/rotate-key",
            json={"new_key": "not-a-fernet-key"},
        )
        assert r.status_code == 400

    def test_rotation_generates_key_when_none_provided(self, client, app):
        # Clear any secret left over from prior tests — rotation re-encrypts
        # every secret in the DB, and a row encrypted with a now-unknown key
        # would (correctly) abort the rotation.
        with app.app_context():
            with get_session() as session:
                for row in session.execute(
                    select(Setting).where(Setting.is_secret.is_(True))
                ).scalars().all():
                    session.delete(row)
                session.commit()
        _clear(app, "security.encryption_key_id", "_rotation_event")

        r = client.post("/api/v1/settings/security/rotate-key", json={})
        assert r.status_code == 200
        body = r.get_json()
        assert body["new_key"]
        assert len(body["new_key"]) == 44


# ── System: package-installed check ──────────────────────────────────────────

class TestPackageCheck:
    def test_known_stdlib_module_installed(self, client):
        r = client.get("/api/v1/settings/system/packages/check?name=json")
        assert r.status_code == 200
        assert r.get_json() == {"name": "json", "installed": True}

    def test_missing_module_reported_not_installed(self, client):
        r = client.get(
            "/api/v1/settings/system/packages/check?name=does_not_exist_xyz_pkg"
        )
        assert r.status_code == 200
        assert r.get_json()["installed"] is False

    def test_invalid_package_name_rejected(self, client):
        r = client.get("/api/v1/settings/system/packages/check?name=../etc/passwd")
        assert r.status_code == 400
