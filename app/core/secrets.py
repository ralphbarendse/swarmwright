"""Encrypted secret storage.

This is the ONLY module in the codebase that reads `SWARM_ENCRYPTION_KEY`.
Agents and skills never see plaintext API keys — they call
`secrets.get_llm_credentials(provider)` to obtain a configured `LLMClient`.

Per docs/CLAUDE.md, this is the one principled exception to the
"filesystem is canonical" rule: secrets must be encrypted, and encryption
requires a database to hold the ciphertext.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import os
import re
from typing import TYPE_CHECKING

from cryptography.fernet import Fernet, InvalidToken

if TYPE_CHECKING:
    from app.core.llm import LLMClient

logger = logging.getLogger(__name__)


class EncryptionKeyError(RuntimeError):
    """The master encryption key is missing or malformed."""


class SecretsError(RuntimeError):
    """A secret cannot be decrypted, or no value is configured for the requested key."""


# ── Master key handling ───────────────────────────────────────────────────────

def _master_key_raw() -> str:
    raw = os.environ.get("SWARM_ENCRYPTION_KEY")
    if not raw:
        raise EncryptionKeyError(
            "SWARM_ENCRYPTION_KEY is not set. The container cannot encrypt or "
            "decrypt secrets. Set the env var to a base64-encoded 32-byte value."
        )
    return raw


def validate_master_key(raw: str) -> None:
    """Raise EncryptionKeyError if `raw` is not a valid Fernet key (URL-safe base64-encoded 32 bytes)."""
    if not raw:
        raise EncryptionKeyError("SWARM_ENCRYPTION_KEY is empty.")
    # Fernet keys are exactly 44 URL-safe base64 chars (32 bytes + one '=' pad).
    # Validate the character set strictly — Python's b64decode is otherwise
    # lenient and silently strips non-alphabet characters.
    if not re.fullmatch(r"[A-Za-z0-9_\-]{43}=", raw):
        raise EncryptionKeyError(
            "SWARM_ENCRYPTION_KEY is not valid URL-safe base64 (expected 44 chars)."
        )
    try:
        decoded = base64.urlsafe_b64decode(raw.encode("ascii"))
    except Exception as exc:
        raise EncryptionKeyError(
            "SWARM_ENCRYPTION_KEY is not valid URL-safe base64."
        ) from exc
    if len(decoded) != 32:
        raise EncryptionKeyError(
            f"SWARM_ENCRYPTION_KEY must decode to 32 bytes, got {len(decoded)}."
        )


def _fernet() -> Fernet:
    raw = _master_key_raw()
    validate_master_key(raw)
    return Fernet(raw.encode("ascii"))


def generate_master_key() -> str:
    """Return a new URL-safe base64-encoded 32-byte master key.

    Used by the rotation flow when the operator chooses "generate new key".
    """
    return Fernet.generate_key().decode("ascii")


KEY_FILE_NAME = ".encryption_key"


def resolve_or_generate_master_key(data_dir: str) -> tuple[str, str]:
    """Resolve the master key, generating + persisting one on first boot.

    Resolution order:
      1. ``SWARM_ENCRYPTION_KEY`` env var (operator-managed, wins if set)
      2. ``<data_dir>/.encryption_key`` file (container-managed, persisted across restarts)
      3. Generate a new key, write to ``<data_dir>/.encryption_key``, return it

    Returns:
        ``(key, source)`` where source is one of ``"env"``, ``"file"``, ``"generated"``.

    The encryption key shares the lifetime of the data volume — losing
    ``data/`` loses both the secrets and the key, so the security guarantee
    is preserved. Operators backing up to less-trusted locations should
    exclude ``<data_dir>/.encryption_key`` from those backups and store it
    separately.
    """
    env_key = os.environ.get("SWARM_ENCRYPTION_KEY")
    if env_key:
        validate_master_key(env_key)
        return env_key, "env"

    key_path = os.path.join(data_dir, KEY_FILE_NAME)
    if os.path.isfile(key_path):
        with open(key_path) as f:
            file_key = f.read().strip()
        validate_master_key(file_key)
        return file_key, "file"

    new_key = generate_master_key()
    os.makedirs(data_dir, exist_ok=True)
    # Atomic write so a crashed boot can never leave a partial key.
    tmp_path = key_path + ".tmp"
    with open(tmp_path, "w") as f:
        f.write(new_key + "\n")
    try:
        os.chmod(tmp_path, 0o600)
    except OSError:
        # chmod can fail on some filesystems (NTFS over a bind mount, etc.).
        # The key is gitignored via the data/ rule anyway.
        pass
    os.replace(tmp_path, key_path)
    return new_key, "generated"


# ── Encryption primitives ─────────────────────────────────────────────────────

def encrypt(plaintext: str) -> str:
    """Encrypt a UTF-8 string with the current master key. Returns a Fernet token."""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt(token: str) -> str:
    """Decrypt a Fernet token with the current master key.

    Raises SecretsError if the token is tampered, the wrong key is in use, or
    the value is otherwise corrupt.
    """
    try:
        return _fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise SecretsError(
            "Cannot decrypt token — it was encrypted with a different key, "
            "tampered with, or is corrupt."
        ) from exc


def re_encrypt(token: str, new_key: str) -> str:
    """Decrypt a token with the current master key and re-encrypt with `new_key`.

    Used by the rotation flow to migrate every secret to a new master key in
    one transaction.
    """
    validate_master_key(new_key)
    plaintext = decrypt(token)
    new_fernet = Fernet(new_key.encode("ascii"))
    return new_fernet.encrypt(plaintext.encode("utf-8")).decode("utf-8")


def hash_value(value: str) -> str:
    """Return the SHA-256 hex digest of `value`. Used for the audit log."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def mask_secret(value: str, *, visible_tail: int = 4) -> str:
    """Return a masked rendering of a secret, showing only the last few chars.

    Used by the API when returning secret settings to the GUI. Never logs the
    plaintext — the masked form is for display only.
    """
    if not value:
        return ""
    if len(value) <= visible_tail:
        return "*" * len(value)
    return f"{'*' * (len(value) - visible_tail)}{value[-visible_tail:]}"


# ── Database-backed accessors ─────────────────────────────────────────────────

def get_secret(key: str) -> str | None:
    """Return the decrypted value of a secret-typed setting, or None if absent.

    Reads `app.models.settings.Setting`. Returns None if no row exists, the row
    is not marked secret, or the stored value is empty.
    """
    from app.db import get_session
    from app.models.settings import Setting

    with get_session() as session:
        row = session.get(Setting, key)
    if not row or not row.is_secret or not row.value_encrypted:
        return None
    return decrypt(row.value_encrypted)


# ── LLM credentials ───────────────────────────────────────────────────────────

_PROVIDER_KEY_MAP: dict[str, tuple[str, str]] = {
    # provider → (settings_key, env_var_fallback)
    "anthropic": ("llm.anthropic.api_key", "ANTHROPIC_API_KEY"),
    "openai": ("llm.openai.api_key", "OPENAI_API_KEY"),
    "deepseek": ("llm.deepseek.api_key", "DEEPSEEK_API_KEY"),
}


def resolve_default_provider() -> str:
    """Return the provider new agents should use unless they override.

    Resolution order:
        1. ``llm.default_provider`` setting (operator-set via the GUI)
        2. ``LLM_PROVIDER`` env var
        3. ``"anthropic"``
    """
    from app.db import get_session
    from app.models.settings import Setting

    try:
        with get_session() as session:
            row = session.get(Setting, "llm.default_provider")
        if row and row.value_encrypted:
            import json
            value = json.loads(row.value_encrypted)
            if isinstance(value, str) and value.strip():
                return value.strip().lower()
    except Exception:
        # DB not initialised yet, or row malformed — fall through to env var.
        pass
    return os.environ.get("LLM_PROVIDER", "anthropic").lower()


def resolve_llm_api_key(provider: str) -> str:
    """Return the API key for `provider`, preferring encrypted settings.

    Falls back to the legacy env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
    if no setting is stored. Raises SecretsError if neither source has a key.
    """
    provider = provider.lower()
    if provider not in _PROVIDER_KEY_MAP:
        raise SecretsError(
            f"Unknown LLM provider: {provider!r}. Choose 'anthropic', 'openai', or 'deepseek'."
        )

    settings_key, env_var = _PROVIDER_KEY_MAP[provider]
    key = get_secret(settings_key) or os.environ.get(env_var)
    if not key:
        raise SecretsError(
            f"No API key configured for provider {provider!r}. "
            f"Set it under Settings → LLM Providers, or export {env_var}."
        )
    return key


def get_llm_credentials(
    provider: str | None = None,
    model: str | None = None,
) -> "LLMClient":
    """Return a configured `LLMClient`.

    Reads the API key from encrypted settings (preferred) or the corresponding
    environment variable (fallback). Agents and skills should call this rather
    than instantiating `LLMClient` directly so a single line change picks up
    new credentials when the operator updates them in the GUI.

    Args:
        provider: Provider id (``"anthropic"`` / ``"openai"``). If omitted,
            resolved via :func:`resolve_default_provider`.
        model: Model id passed through to ``LLMClient``. If omitted, the
            client falls back to the ``LLM_MODEL`` env var.
    """
    from app.core.llm import LLMClient

    if provider is None:
        provider = resolve_default_provider()
    api_key = resolve_llm_api_key(provider)
    return LLMClient(provider=provider, model=model, api_key=api_key)
