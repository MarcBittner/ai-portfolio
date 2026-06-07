"""Custom OpenAI-compatible providers + OpenRouter free discovery."""

import httpx
import pytest

from persona_twin.config import Settings
from persona_twin.llm import get_router
from persona_twin.llm.custom import (
    ExtraProvider,
    extra_specs,
    parse_extra_providers,
)
from persona_twin.llm.openrouter_llm import discover_free_models

EXTRA_JSON = """[{
  "name": "groq",
  "base_url": "https://api.groq.com/openai/v1",
  "api_key_env": "GROQ_API_KEY",
  "models": [{"id": "llama-3.3-70b-versatile", "quality": 7, "speed": 10}]
}]"""

OR_MODELS_JSON = {
    "data": [
        {
            "id": "big/free-70b:free",
            "context_length": 128000,
            "pricing": {"prompt": "0", "completion": "0"},
        },
        {
            "id": "small/free-7b:free",
            "context_length": 32000,
            "pricing": {"prompt": "0", "completion": "0"},
        },
        {
            "id": "paid/model",
            "context_length": 200000,
            "pricing": {"prompt": "0.000003", "completion": "0.000015"},
        },
    ]
}


class TestExtraProviders:
    def test_parse_and_specs(self):
        providers = parse_extra_providers(EXTRA_JSON)
        assert len(providers) == 1
        specs = extra_specs(providers[0])
        assert specs[0].provider == "groq"
        assert specs[0].id == "llama-3.3-70b-versatile"
        assert specs[0].input_per_mtok == 0.0  # free default

    def test_none_and_empty(self):
        assert parse_extra_providers(None) == []
        assert parse_extra_providers("") == []

    def test_reserved_names_rejected(self):
        with pytest.raises(ValueError, match="reserved"):
            ExtraProvider(
                name="openai", base_url="https://x", models=[{"id": "m"}]
            )

    def test_backend_listed_in_settings(self, monkeypatch):
        monkeypatch.delenv("PERSONA_TWIN_MOCK", raising=False)
        s = Settings(_env_file=None, extra_providers=EXTRA_JSON)
        assert "groq" in s.llm_backends
        assert s.llm_backends[-1] == "mock"

    def test_router_registers_provider_and_specs(self, monkeypatch):
        pytest.importorskip("openai", reason="provider SDKs are optional extras")
        monkeypatch.setenv("GROQ_API_KEY", "test-placeholder")
        router = get_router(Settings(_env_file=None, extra_providers=EXTRA_JSON))
        assert "groq" in router.providers
        assert router.providers["groq"].name == "groq"
        assert any(
            (s.provider, s.id) == ("groq", "llama-3.3-70b-versatile")
            for s in router.registry.specs
        )


class TestOpenRouterFreeDiscovery:
    def test_filters_to_zero_priced_sorted_by_context(self, monkeypatch):
        def fake_get(url, timeout):
            assert url.endswith("/models")
            return httpx.Response(
                200, json=OR_MODELS_JSON, request=httpx.Request("GET", url)
            )

        monkeypatch.setattr(httpx, "get", fake_get)
        specs = discover_free_models()
        assert [s.id for s in specs] == ["big/free-70b:free", "small/free-7b:free"]
        assert all(s.input_per_mtok == 0.0 for s in specs)

    def test_cap(self, monkeypatch):
        def fake_get(url, timeout):
            return httpx.Response(
                200, json=OR_MODELS_JSON, request=httpx.Request("GET", url)
            )

        monkeypatch.setattr(httpx, "get", fake_get)
        assert len(discover_free_models(cap=1)) == 1

    def test_failure_is_safe(self, monkeypatch):
        def fake_get(url, timeout):
            raise httpx.ConnectError("offline")

        monkeypatch.setattr(httpx, "get", fake_get)
        assert discover_free_models() == []
