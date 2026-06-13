"""LLM router: offline terminal fallback, availability self-selection, status."""

from burnrate import llm


def test_offline_is_terminal_with_no_keys(monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(llm, "_ollama_reachable", lambda: False)
    res = llm.complete("sys", "user", offline=lambda s, u: "OFFLINE-OK", mode="auto")
    assert res.provider == "offline"
    assert res.text == "OFFLINE-OK"
    assert res.cost_usd == 0.0


def test_mode_offline_skips_all_providers():
    res = llm.complete("s", "u", offline=lambda s, u: "x", mode="offline")
    assert res.provider == "offline"
    assert res.mode == "offline"


def test_availability_reads_environment(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    assert llm._available("openai") is True
    monkeypatch.delenv("OPENAI_API_KEY")
    assert llm._available("openai") is False


def test_status_shape():
    s = llm.status()
    assert "providers" in s
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True
