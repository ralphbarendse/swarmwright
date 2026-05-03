from __future__ import annotations

import base64
import os

import pytest

from app.core import secrets
from app.core.secrets import (
    EncryptionKeyError,
    SecretsError,
    decrypt,
    encrypt,
    generate_master_key,
    hash_value,
    mask_secret,
    re_encrypt,
    resolve_llm_api_key,
    validate_master_key,
)


# ── Master key validation ────────────────────────────────────────────────────

class TestMasterKeyValidation:
    def test_valid_key_passes(self):
        validate_master_key(generate_master_key())

    def test_empty_key_raises(self):
        with pytest.raises(EncryptionKeyError, match="empty"):
            validate_master_key("")

    def test_non_base64_key_raises(self):
        with pytest.raises(EncryptionKeyError, match="base64"):
            validate_master_key("not!!!valid!!!base64!!!at-all")

    def test_wrong_length_raises(self):
        # 16-byte payload base64-encodes to 24 chars — fails the 44-char check.
        too_short = base64.urlsafe_b64encode(b"\x00" * 16).decode()
        with pytest.raises(EncryptionKeyError, match="44 chars"):
            validate_master_key(too_short)

    def test_generate_master_key_is_valid(self):
        for _ in range(5):
            key = generate_master_key()
            validate_master_key(key)
            assert len(base64.urlsafe_b64decode(key)) == 32

    def test_generated_keys_are_unique(self):
        keys = {generate_master_key() for _ in range(10)}
        assert len(keys) == 10


# ── Encrypt/decrypt round-trip ───────────────────────────────────────────────

class TestEncryptDecrypt:
    def test_round_trip(self):
        plaintext = "sk-ant-api03-supersecret"
        token = encrypt(plaintext)
        assert token != plaintext
        assert decrypt(token) == plaintext

    def test_distinct_iv_per_call(self):
        plaintext = "the-same-thing-twice"
        a = encrypt(plaintext)
        b = encrypt(plaintext)
        assert a != b
        assert decrypt(a) == decrypt(b) == plaintext

    def test_decrypt_tampered_raises(self):
        token = encrypt("hello")
        tampered = token[:-2] + "AA"
        with pytest.raises(SecretsError):
            decrypt(tampered)

    def test_decrypt_wrong_key_raises(self, monkeypatch):
        token = encrypt("hello")
        monkeypatch.setenv("SWARM_ENCRYPTION_KEY", generate_master_key())
        with pytest.raises(SecretsError):
            decrypt(token)

    def test_missing_key_raises(self, monkeypatch):
        monkeypatch.delenv("SWARM_ENCRYPTION_KEY", raising=False)
        with pytest.raises(EncryptionKeyError, match="not set"):
            encrypt("hello")


# ── Re-encryption (key rotation primitive) ───────────────────────────────────

class TestReEncrypt:
    def test_rotates_to_new_key(self, monkeypatch):
        token_v1 = encrypt("rotate-me")
        new_key = generate_master_key()
        token_v2 = re_encrypt(token_v1, new_key)

        with pytest.raises(SecretsError):
            decrypt(token_v2)

        monkeypatch.setenv("SWARM_ENCRYPTION_KEY", new_key)
        assert decrypt(token_v2) == "rotate-me"

    def test_re_encrypt_rejects_invalid_new_key(self):
        token = encrypt("foo")
        with pytest.raises(EncryptionKeyError):
            re_encrypt(token, "not-a-valid-key")


# ── Helpers ──────────────────────────────────────────────────────────────────

class TestHelpers:
    def test_hash_value_deterministic(self):
        assert hash_value("abc") == hash_value("abc")
        assert hash_value("abc") != hash_value("abd")
        assert len(hash_value("anything")) == 64

    def test_mask_short_value(self):
        assert mask_secret("abc") == "***"

    def test_mask_long_value(self):
        masked = mask_secret("sk-ant-api03-very-long-key-3F2A")
        assert masked.endswith("3F2A")
        assert masked.startswith("*")
        assert "very-long-key" not in masked

    def test_mask_empty(self):
        assert mask_secret("") == ""


# ── get_secret + LLM credentials ─────────────────────────────────────────────

class TestSecretAccessors:
    def test_get_secret_missing_returns_none(self, app):
        with app.app_context():
            assert secrets.get_secret("does.not.exist") is None

    def test_get_secret_round_trip(self, app):
        from app.db import get_session
        from app.models.settings import Setting

        with app.app_context():
            with get_session() as session:
                existing = session.get(Setting, "llm.test.api_key")
                if existing:
                    session.delete(existing)
                    session.commit()
                session.add(Setting(
                    key="llm.test.api_key",
                    value_encrypted=encrypt("test-secret-value"),
                    is_secret=True,
                    value_type="string",
                ))
                session.commit()

            assert secrets.get_secret("llm.test.api_key") == "test-secret-value"

    def test_get_secret_returns_none_for_non_secret_row(self, app):
        from app.db import get_session
        from app.models.settings import Setting

        with app.app_context():
            with get_session() as session:
                existing = session.get(Setting, "branding.app_name")
                if existing:
                    session.delete(existing)
                    session.commit()
                session.add(Setting(
                    key="branding.app_name",
                    value_encrypted='"Acme"',
                    is_secret=False,
                    value_type="string",
                ))
                session.commit()
            assert secrets.get_secret("branding.app_name") is None

    def test_resolve_llm_api_key_unknown_provider(self, app):
        with app.app_context():
            with pytest.raises(SecretsError, match="Unknown LLM provider"):
                resolve_llm_api_key("google")

    def test_resolve_llm_api_key_uses_env_fallback(self, app, monkeypatch):
        from app.db import get_session
        from app.models.settings import Setting

        monkeypatch.setenv("ANTHROPIC_API_KEY", "env-fallback-key")
        with app.app_context():
            with get_session() as session:
                existing = session.get(Setting, "llm.anthropic.api_key")
                if existing:
                    session.delete(existing)
                    session.commit()
            assert resolve_llm_api_key("anthropic") == "env-fallback-key"

    def test_resolve_llm_api_key_prefers_settings_over_env(self, app, monkeypatch):
        from app.db import get_session
        from app.models.settings import Setting

        monkeypatch.setenv("ANTHROPIC_API_KEY", "env-key-loses")
        with app.app_context():
            with get_session() as session:
                existing = session.get(Setting, "llm.anthropic.api_key")
                if existing:
                    session.delete(existing)
                    session.commit()
                session.add(Setting(
                    key="llm.anthropic.api_key",
                    value_encrypted=encrypt("settings-key-wins"),
                    is_secret=True,
                ))
                session.commit()

            assert resolve_llm_api_key("anthropic") == "settings-key-wins"

    def test_resolve_llm_api_key_no_source_raises(self, app, monkeypatch):
        from app.db import get_session
        from app.models.settings import Setting

        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        with app.app_context():
            with get_session() as session:
                existing = session.get(Setting, "llm.anthropic.api_key")
                if existing:
                    session.delete(existing)
                    session.commit()
            with pytest.raises(SecretsError, match="No API key configured"):
                resolve_llm_api_key("anthropic")


# ── First-boot key resolver ──────────────────────────────────────────────────

class TestKeyResolver:
    def test_env_wins_over_file(self, tmp_path, monkeypatch):
        from app.core.secrets import resolve_or_generate_master_key

        env_key = generate_master_key()
        monkeypatch.setenv("SWARM_ENCRYPTION_KEY", env_key)

        # Plant a different key in the file — env should still win.
        file_key = generate_master_key()
        (tmp_path / ".encryption_key").write_text(file_key + "\n")

        key, source = resolve_or_generate_master_key(str(tmp_path))
        assert key == env_key
        assert source == "env"

    def test_falls_back_to_file_when_env_missing(self, tmp_path, monkeypatch):
        from app.core.secrets import resolve_or_generate_master_key

        monkeypatch.delenv("SWARM_ENCRYPTION_KEY", raising=False)
        file_key = generate_master_key()
        (tmp_path / ".encryption_key").write_text(file_key + "\n")

        key, source = resolve_or_generate_master_key(str(tmp_path))
        assert key == file_key
        assert source == "file"

    def test_generates_and_persists_on_first_boot(self, tmp_path, monkeypatch):
        from app.core.secrets import KEY_FILE_NAME, resolve_or_generate_master_key

        monkeypatch.delenv("SWARM_ENCRYPTION_KEY", raising=False)
        assert not (tmp_path / KEY_FILE_NAME).exists()

        key, source = resolve_or_generate_master_key(str(tmp_path))
        assert source == "generated"
        validate_master_key(key)

        # Persisted to disk
        on_disk = (tmp_path / KEY_FILE_NAME).read_text().strip()
        assert on_disk == key

    def test_second_call_reads_persisted_key(self, tmp_path, monkeypatch):
        from app.core.secrets import resolve_or_generate_master_key

        monkeypatch.delenv("SWARM_ENCRYPTION_KEY", raising=False)
        first_key, first_source = resolve_or_generate_master_key(str(tmp_path))
        second_key, second_source = resolve_or_generate_master_key(str(tmp_path))

        assert first_source == "generated"
        assert second_source == "file"
        assert first_key == second_key

    def test_corrupt_file_raises(self, tmp_path, monkeypatch):
        from app.core.secrets import resolve_or_generate_master_key

        monkeypatch.delenv("SWARM_ENCRYPTION_KEY", raising=False)
        (tmp_path / ".encryption_key").write_text("not-a-valid-fernet-key\n")

        with pytest.raises(EncryptionKeyError):
            resolve_or_generate_master_key(str(tmp_path))

    def test_get_llm_credentials_uses_settings_key(self, app, monkeypatch):
        """The end-to-end path the runtime hits: settings store wins over env."""
        from app.core import secrets as sec
        from app.db import get_session
        from app.models.settings import Setting
        from unittest.mock import patch

        monkeypatch.setenv("ANTHROPIC_API_KEY", "env-key-must-not-win")
        with app.app_context():
            with get_session() as session:
                for k in ("llm.anthropic.api_key", "llm.default_provider"):
                    row = session.get(Setting, k)
                    if row:
                        session.delete(row)
                        session.commit()
                session.add(Setting(
                    key="llm.anthropic.api_key",
                    value_encrypted=encrypt("settings-key-from-gui"),
                    is_secret=True,
                ))
                session.commit()

            captured = {}
            class FakeClient:
                def __init__(self, **kwargs):
                    captured.update(kwargs)
            with patch.object(sec, "LLMClient", FakeClient, create=True):
                # The dynamic import inside get_llm_credentials still resolves
                # against app.core.llm, so patch it there too.
                from app.core import llm as llm_mod
                with patch.object(llm_mod, "LLMClient", FakeClient):
                    sec.get_llm_credentials(model="some-model")

            assert captured.get("api_key") == "settings-key-from-gui"
            assert captured.get("provider") == "anthropic"
            assert captured.get("model") == "some-model"

    def test_resolve_default_provider_reads_setting(self, app):
        from app.core.secrets import resolve_default_provider
        from app.db import get_session
        from app.models.settings import Setting
        import json

        with app.app_context():
            with get_session() as session:
                row = session.get(Setting, "llm.default_provider")
                if row:
                    session.delete(row)
                    session.commit()
                session.add(Setting(
                    key="llm.default_provider",
                    value_encrypted=json.dumps("openai"),
                    is_secret=False,
                ))
                session.commit()

            assert resolve_default_provider() == "openai"

    def test_creates_data_dir_if_missing(self, tmp_path, monkeypatch):
        from app.core.secrets import resolve_or_generate_master_key

        monkeypatch.delenv("SWARM_ENCRYPTION_KEY", raising=False)
        target = tmp_path / "fresh" / "data"
        assert not target.exists()

        key, source = resolve_or_generate_master_key(str(target))
        assert source == "generated"
        assert (target / ".encryption_key").exists()
        validate_master_key(key)
