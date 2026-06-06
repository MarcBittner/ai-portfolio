"""Settings must resolve to offline defaults with no environment at all."""

from persona_twin.config import Settings


def make_settings(**env: str) -> Settings:
    # _env_file=None: ignore any local .env so tests are hermetic
    return Settings(_env_file=None, **env)


def test_offline_defaults(monkeypatch):
    for var in (
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "MONGODB_URI",
        "REDIS_URL",
        "PERSONA_TWIN_MOCK",
        "PERSONA_TWIN_ROUTE_OBJECTIVE",
    ):
        monkeypatch.delenv(var, raising=False)
    s = make_settings()
    assert s.llm_backends == ["mock"]
    assert s.vector_backend == "memory"
    assert s.embedding_backend == "hash"
    assert s.cache_backend == "memory"
    assert s.route_objective == "cost"


def test_providers_activate_from_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-placeholder")
    monkeypatch.setenv("OPENAI_API_KEY", "test-placeholder")
    monkeypatch.setenv("MONGODB_URI", "mongodb://localhost:27017")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")
    s = make_settings()
    assert s.llm_backends == ["anthropic", "openai", "mock"]
    assert s.vector_backend == "atlas"
    assert s.embedding_backend == "openai"
    assert s.cache_backend == "redis"


def test_mock_mode_overrides_keys(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-placeholder")
    monkeypatch.setenv("OPENAI_API_KEY", "test-placeholder")
    monkeypatch.setenv("PERSONA_TWIN_MOCK", "1")
    s = make_settings()
    assert s.llm_backends == ["mock"]
    assert s.embedding_backend == "hash"


def test_mock_provider_is_always_last_fallback(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("PERSONA_TWIN_MOCK", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-placeholder")
    s = make_settings()
    assert s.llm_backends[-1] == "mock"
