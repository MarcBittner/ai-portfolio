from perimeter import llm


def test_offline_is_terminal_with_no_providers(monkeypatch):
    # No keys, no Ollama → the chain must fall through to the offline fn and
    # never raise, regardless of mode.
    for var in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(llm, "_ollama_reachable", lambda: False)

    res = llm.complete("sys", "user", offline=lambda s, u: "OFFLINE")
    assert res.provider == "offline"
    assert res.model == "deterministic"
    assert res.text == "OFFLINE"
    assert res.cost_usd == 0.0


def test_mode_offline_skips_all_providers(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")  # available but must be skipped
    called = {"n": 0}

    def off(_s, _u):
        called["n"] += 1
        return "det"

    res = llm.complete("s", "u", offline=off, mode="offline")
    assert res.provider == "offline" and called["n"] == 1


def test_status_reports_providers(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(llm, "_ollama_reachable", lambda: False)
    st = llm.status()
    assert set(st["providers"]) == {"anthropic", "openai", "ollama", "openrouter"}
    assert st["offline_fallback"] is True


def test_resolve_mode_default(monkeypatch):
    monkeypatch.delenv("LLM_MODE", raising=False)
    assert llm.resolve_mode(None) == "auto"
    assert llm.resolve_mode("PAID") == "paid"


def test_empty_provider_text_falls_through(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "x")
    monkeypatch.setattr(llm, "_ollama_reachable", lambda: False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    # provider returns blank → recorded as a fallback, offline wins
    monkeypatch.setattr(llm, "_call", lambda *a, **k: ("   ", "m", 1, 1))
    res = llm.complete("s", "u", offline=lambda s, u: "det", mode="free")
    assert res.provider == "offline"
    assert "openrouter" in res.fallbacks
