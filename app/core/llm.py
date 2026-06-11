from __future__ import annotations

import logging
import os
import random
import time

logger = logging.getLogger(__name__)

# Transient provider failures are retried with exponential backoff before the
# error reaches the runtime (where it would fail the whole run).
_MAX_ATTEMPTS = int(os.environ.get("LLM_MAX_ATTEMPTS", "4"))
_BACKOFF_BASE_SECONDS = 1.0
_RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504, 529}
_RETRYABLE_CLASS_HINTS = (
    "RateLimit", "Overloaded", "InternalServer", "APIConnection",
    "APITimeout", "Timeout", "ServiceUnavailable",
)


def _is_retryable(exc: Exception) -> bool:
    """Transient errors only — auth/validation errors must surface immediately.

    Works across the anthropic and openai SDKs without importing either here:
    both attach `status_code` to API errors and use comparable class names for
    connection-level failures.
    """
    status = getattr(exc, "status_code", None)
    if status is not None:
        return status in _RETRYABLE_STATUS
    name = type(exc).__name__
    return any(hint in name for hint in _RETRYABLE_CLASS_HINTS)


class LLMClient:
    """Provider-agnostic LLM client wrapper.

    Agents never import provider SDKs directly — only this module does.
    Swap the provider via LLM_PROVIDER env var without touching agent code.
    """

    _DEFAULT_MODELS: dict[str, str] = {
        "anthropic": "claude-opus-4-6",
        "openai": "gpt-4o",
        "deepseek": "deepseek-chat",
    }

    def __init__(
        self,
        provider: str | None = None,
        model: str | None = None,
        api_key: str | None = None,
    ) -> None:
        self.provider = (provider or os.environ.get("LLM_PROVIDER", "anthropic")).lower()
        self.model = model or os.environ.get("LLM_MODEL") or self._DEFAULT_MODELS.get(self.provider, "claude-opus-4-6")
        self._api_key = api_key
        self._client = self._build_client()

    def _build_client(self):
        if self.provider == "anthropic":
            return self._build_anthropic()
        if self.provider == "openai":
            return self._build_openai()
        if self.provider == "deepseek":
            return self._build_deepseek()
        raise ValueError(f"Unknown LLM provider: {self.provider!r}. Choose 'anthropic', 'openai', or 'deepseek'.")

    def _build_anthropic(self):
        try:
            import anthropic  # noqa: PLC0415
        except ImportError as exc:
            raise ImportError("anthropic package is required for LLM_PROVIDER=anthropic") from exc

        api_key = self._api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise EnvironmentError("ANTHROPIC_API_KEY is not set")
        return anthropic.Anthropic(api_key=api_key)

    def _build_openai(self):
        try:
            import openai  # noqa: PLC0415
        except ImportError as exc:
            raise ImportError("openai package is required for LLM_PROVIDER=openai") from exc

        api_key = self._api_key or os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise EnvironmentError("OPENAI_API_KEY is not set")
        return openai.OpenAI(api_key=api_key)

    def _build_deepseek(self):
        try:
            import openai  # noqa: PLC0415
        except ImportError as exc:
            raise ImportError("openai package is required for LLM_PROVIDER=deepseek") from exc

        api_key = self._api_key or os.environ.get("DEEPSEEK_API_KEY")
        if not api_key:
            raise EnvironmentError("DEEPSEEK_API_KEY is not set")
        return openai.OpenAI(api_key=api_key, base_url="https://api.deepseek.com")

    def complete(self, system: str, messages: list[dict], **kwargs) -> str:
        """Send a completion request and return the assistant's text response."""
        text, _ = self.complete_with_usage(system, messages, **kwargs)
        return text

    def complete_with_usage(
        self, system: str, messages: list[dict], **kwargs
    ) -> tuple[str, dict]:
        """Send a completion request and return (text, usage).

        usage dict has keys: input_tokens, output_tokens (both int).

        Transient provider errors (rate limits, overloads, 5xx, connection
        drops) are retried with exponential backoff; anything else raises
        immediately.
        """
        last_exc: Exception | None = None
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                if self.provider == "anthropic":
                    return self._complete_anthropic(system, messages, **kwargs)
                return self._complete_openai(system, messages, **kwargs)  # openai + deepseek share the same wire format
            except Exception as exc:  # noqa: BLE001 — classified below
                if not _is_retryable(exc) or attempt == _MAX_ATTEMPTS:
                    raise
                last_exc = exc
                delay = _BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
                logger.warning(
                    "Transient %s error from %s (attempt %d/%d), retrying in %.1fs: %s",
                    type(exc).__name__, self.provider, attempt, _MAX_ATTEMPTS, delay, exc,
                )
                time.sleep(delay)
        raise last_exc  # pragma: no cover — loop always returns or raises above

    def _complete_anthropic(self, system: str, messages: list[dict], **kwargs) -> tuple[str, dict]:
        max_tokens = kwargs.pop("max_tokens", 4096)
        response = self._client.messages.create(
            model=self.model,
            system=system,
            messages=messages,
            max_tokens=max_tokens,
            **kwargs,
        )
        usage = {
            "input_tokens": getattr(response.usage, "input_tokens", 0) or 0,
            "output_tokens": getattr(response.usage, "output_tokens", 0) or 0,
        }
        text = next((b.text for b in response.content if hasattr(b, "text")), "")
        return text, usage

    def _complete_openai(self, system: str, messages: list[dict], **kwargs) -> tuple[str, dict]:
        full_messages = [{"role": "system", "content": system}] + messages
        response = self._client.chat.completions.create(
            model=self.model,
            messages=full_messages,
            **kwargs,
        )
        u = response.usage
        usage = {
            "input_tokens": getattr(u, "prompt_tokens", 0) or 0,
            "output_tokens": getattr(u, "completion_tokens", 0) or 0,
        }
        return response.choices[0].message.content, usage
