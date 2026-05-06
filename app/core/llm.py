from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)


class LLMClient:
    """Provider-agnostic LLM client wrapper.

    Agents never import provider SDKs directly — only this module does.
    Swap the provider via LLM_PROVIDER env var without touching agent code.
    """

    def __init__(
        self,
        provider: str | None = None,
        model: str | None = None,
        api_key: str | None = None,
    ) -> None:
        self.provider = (provider or os.environ.get("LLM_PROVIDER", "anthropic")).lower()
        self.model = model or os.environ.get("LLM_MODEL", "claude-opus-4-6")
        self._api_key = api_key
        self._client = self._build_client()

    def _build_client(self):
        if self.provider == "anthropic":
            return self._build_anthropic()
        if self.provider == "openai":
            return self._build_openai()
        raise ValueError(f"Unknown LLM provider: {self.provider!r}. Choose 'anthropic' or 'openai'.")

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

    def complete(self, system: str, messages: list[dict], **kwargs) -> str:
        """Send a completion request and return the assistant's text response."""
        text, _ = self.complete_with_usage(system, messages, **kwargs)
        return text

    def complete_with_usage(
        self, system: str, messages: list[dict], **kwargs
    ) -> tuple[str, dict]:
        """Send a completion request and return (text, usage).

        usage dict has keys: input_tokens, output_tokens (both int).
        """
        if self.provider == "anthropic":
            return self._complete_anthropic(system, messages, **kwargs)
        return self._complete_openai(system, messages, **kwargs)

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
        return response.content[0].text, usage

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
