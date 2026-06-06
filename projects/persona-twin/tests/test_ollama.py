"""Ollama provider: backend activation, discovery parsing, registry merge."""

import httpx
import pytest

from persona_twin.config import Settings
from persona_twin.llm import get_router
from persona_twin.llm.ollama_llm import _v1, discover_ollama_models

TAGS_JSON = {
    "models": [
        {"name": "qwen2.5-coder:7b", "size": 4_700_000_000},
        {"name": "llama3.2:3b", "size": 2_000_000_000},
    ]
}


def test_backend_activates_from_env(monkeypatch):
    monkeypatch.delenv("PERSONA_TWIN_MOCK", raising=False)
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:11434")
    s = Settings(_env_file=None)
    assert "ollama" in s.llm_backends
    assert s.llm_backends[-1] == "mock"


def test_v1_normalization():
    assert _v1("http://localhost:11434") == "http://localhost:11434/v1"
    assert _v1("http://localhost:11434/") == "http://localhost:11434/v1"
    assert _v1("http://localhost:11434/v1") == "http://localhost:11434/v1"


def test_discovery_parses_tags(monkeypatch):
    def fake_get(url, timeout):
        assert url.endswith("/api/tags")
        return httpx.Response(200, json=TAGS_JSON, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", fake_get)
    specs = discover_ollama_models("http://localhost:11434")
    assert [s.id for s in specs] == ["llama3.2:3b", "qwen2.5-coder:7b"]  # sorted
    assert all(s.provider == "ollama" for s in specs)
    assert all(s.input_per_mtok == 0.0 and s.output_per_mtok == 0.0 for s in specs)


def test_discovery_failure_is_safe(monkeypatch):
    def fake_get(url, timeout):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(httpx, "get", fake_get)
    assert discover_ollama_models("http://localhost:11434") == []


def test_router_merges_discovered_models(monkeypatch):
    pytest.importorskip("openai", reason="provider SDKs are optional extras")

    def fake_get(url, timeout):
        return httpx.Response(200, json=TAGS_JSON, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", fake_get)
    monkeypatch.delenv("PERSONA_TWIN_MOCK", raising=False)
    router = get_router(
        Settings(_env_file=None, ollama_base_url="http://localhost:11434")
    )
    assert "ollama" in router.providers
    ids = {(s.provider, s.id) for s in router.registry.specs}
    assert ("ollama", "qwen2.5-coder:7b") in ids
    # free local models win the cost objective; mock still terminal
    plan = router.plan(objective="cost")
    assert plan[0].provider == "ollama"
    assert plan[-1].provider == "mock"


def test_offline_default_has_no_ollama():
    router = get_router(Settings(_env_file=None))
    assert "ollama" not in router.providers
    assert all(s.provider != "ollama" for s in router.registry.specs)
