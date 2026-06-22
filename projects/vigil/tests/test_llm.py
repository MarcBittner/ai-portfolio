"""The vendored LLM router: chain, offline fallback, status shape."""

from vigil import llm


def test_status_shape():
    s = llm.status()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True


def test_offline_is_terminal_and_never_raises():
    r = llm.complete("sys", "user", offline=lambda s, u: "deterministic answer",
                     mode="offline")
    assert r.provider == "offline"
    assert r.text == "deterministic answer"
    assert r.cost_usd == 0.0


def test_resolve_mode_default():
    assert llm.resolve_mode(None) in ("auto", "paid", "local", "free", "offline")
