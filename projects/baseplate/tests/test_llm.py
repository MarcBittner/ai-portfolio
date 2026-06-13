"""The routing layer: offline is always terminal; status reflects the env."""

from baseplate import llm


def test_offline_is_terminal_with_no_providers():
    res = llm.complete("sys", "user", offline=lambda s, u: "DETERMINISTIC",
                       mode="auto")
    assert res.provider == "offline"
    assert res.text == "DETERMINISTIC"
    assert res.cost_usd == 0.0


def test_forced_offline_mode_skips_providers():
    res = llm.complete("sys", "user", offline=lambda s, u: "x", mode="offline")
    assert res.provider == "offline"
    assert res.mode == "offline"


def test_status_shape():
    s = llm.status()
    assert set(s["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert s["offline_fallback"] is True
    assert "ollama_url" in s


def test_resolve_mode_default(monkeypatch):
    monkeypatch.delenv("LLM_MODE", raising=False)
    assert llm.resolve_mode(None) == "auto"
    assert llm.resolve_mode("PAID") == "paid"
