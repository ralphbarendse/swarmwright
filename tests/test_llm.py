from __future__ import annotations

import os
import pytest
from unittest.mock import patch, MagicMock

from app.core.llm import LLMClient


def test_anthropic_provider_selected_by_env():
    """LLMClient builds an Anthropic client when LLM_PROVIDER=anthropic."""
    with patch.dict(os.environ, {"LLM_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "sk-ant-test"}):
        with patch("anthropic.Anthropic") as mock_cls:
            client = LLMClient()
            assert client.provider == "anthropic"
            mock_cls.assert_called_once_with(api_key="sk-ant-test")


def test_openai_provider_selected_by_env():
    """LLMClient builds an OpenAI client when LLM_PROVIDER=openai."""
    with patch.dict(os.environ, {"LLM_PROVIDER": "openai", "OPENAI_API_KEY": "sk-test"}):
        with patch("openai.OpenAI") as mock_cls:
            client = LLMClient()
            assert client.provider == "openai"
            mock_cls.assert_called_once_with(api_key="sk-test")


def test_unknown_provider_raises():
    with patch.dict(os.environ, {"LLM_PROVIDER": "cohere"}):
        with pytest.raises(ValueError, match="cohere"):
            LLMClient()


def test_anthropic_missing_key_raises():
    env = {"LLM_PROVIDER": "anthropic"}
    with patch.dict(os.environ, env, clear=False):
        os.environ.pop("ANTHROPIC_API_KEY", None)
        with pytest.raises(EnvironmentError, match="ANTHROPIC_API_KEY"):
            LLMClient()


def test_openai_missing_key_raises():
    env = {"LLM_PROVIDER": "openai"}
    with patch.dict(os.environ, env, clear=False):
        os.environ.pop("OPENAI_API_KEY", None)
        with pytest.raises(EnvironmentError, match="OPENAI_API_KEY"):
            LLMClient()


def test_model_override():
    """Model can be overridden at construction time."""
    with patch.dict(os.environ, {"LLM_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "sk-ant-test"}):
        with patch("anthropic.Anthropic"):
            client = LLMClient(model="claude-haiku-4-5")
            assert client.model == "claude-haiku-4-5"


def test_complete_anthropic_calls_messages_create():
    """complete() delegates to the Anthropic messages.create API."""
    with patch.dict(os.environ, {"LLM_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "sk-ant-test"}):
        with patch("anthropic.Anthropic") as mock_cls:
            mock_instance = MagicMock()
            mock_cls.return_value = mock_instance
            mock_instance.messages.create.return_value = MagicMock(
                content=[MagicMock(text="hello")]
            )

            client = LLMClient()
            result = client.complete(system="sys", messages=[{"role": "user", "content": "hi"}])

            assert result == "hello"
            mock_instance.messages.create.assert_called_once()


def test_complete_openai_calls_chat_completions():
    """complete() delegates to the OpenAI chat.completions.create API."""
    with patch.dict(os.environ, {"LLM_PROVIDER": "openai", "OPENAI_API_KEY": "sk-test"}):
        with patch("openai.OpenAI") as mock_cls:
            mock_instance = MagicMock()
            mock_cls.return_value = mock_instance
            mock_instance.chat.completions.create.return_value = MagicMock(
                choices=[MagicMock(message=MagicMock(content="world"))]
            )

            client = LLMClient()
            result = client.complete(system="sys", messages=[{"role": "user", "content": "hi"}])

            assert result == "world"
            mock_instance.chat.completions.create.assert_called_once()
