"""Full real-path proxy tests with a *simulated* provider, so the observe →
shadow-judge → generate-rules → route → savings flow is exercised deterministically
without a network or a live model."""

import pytest

import arbiter.providers as providers
from arbiter.providers import Completion
from arbiter.proxy import Proxy
from arbiter.registry import Registry
from arbiter.rules import RouteConfig, Ruleset, generate_rules
from arbiter.store import Store


@pytest.fixture
def simulated(monkeypatch):
    """anthropic + openai 'reachable'; every model returns the same good answer,
    and the judge model returns a high score — so cheaper models retain quality."""
    monkeypatch.setattr(providers, "available",
                        lambda p: p in ("anthropic", "openai"))

    def fake_call(model, messages, *, max_tokens=1024, temperature=0.0,
                  json_mode=False, cache_prefix=False):
        sys = " ".join(m.get("content") or "" for m in messages
                       if m.get("role") == "system")
        if "evaluation judge" in sys:
            return Completion('{"score": 0.96, "reason": "equivalent"}', model.id,
                              model.provider, 50, 20, 5.0)
        return Completion("The answer is 42.", model.id, model.provider, 120, 30, 9.0)

    monkeypatch.setattr(providers, "call", fake_call)


def _proxy(mode="observe"):
    reg = Registry()
    cfg = RouteConfig(mode=mode, floor=0.9, min_samples=1)
    store = Store(":memory:")
    return Proxy(reg, cfg, Ruleset(), store, default_model="local"), store, cfg


def _msg(text):
    return [{"role": "user", "content": text}]


def test_observe_serves_baseline_and_measures_quality(simulated):
    proxy, store, cfg = _proxy("observe")
    out = proxy.handle("claude-opus-4-8", _msg("classify this ticket as bug"))
    assert out["arbiter"]["served_model"] == "claude-opus-4-8"  # baseline served
    assert out["arbiter"]["strategy"] == "observe"
    assert out["arbiter"]["shadow"]  # candidates were judged
    stats = store.quality_stats()
    assert stats and all(s["retained"] >= 0.9 for s in stats)


def test_route_picks_cheaper_and_saves(simulated):
    proxy, store, cfg = _proxy("observe")
    for _ in range(3):
        proxy.handle("claude-opus-4-8", _msg("classify this ticket as a bug report"))
    rules = generate_rules(store.quality_stats(), proxy.reg, cfg)
    assert rules, "should generate at least one routing rule"
    proxy.ruleset.replace(rules)
    cfg.mode = "route"
    cfg.response_cache = False  # isolate the routing decision from cache hits
    out = proxy.handle("claude-opus-4-8", _msg("classify a freshly arrived ticket"))
    rl = out["arbiter"]
    assert rl["strategy"] == "route"
    assert rl["served_model"] != "claude-opus-4-8"
    assert rl["saved"] > 0
    assert rl["served_cost"] < rl["baseline_cost"]


def test_response_cache_hit(simulated):
    proxy, store, cfg = _proxy("observe")
    proxy.handle("claude-opus-4-8", _msg("a stable deterministic prompt"))
    out2 = proxy.handle("claude-opus-4-8", _msg("a stable deterministic prompt"))
    assert out2["arbiter"]["strategy"] == "response-cache"
    assert out2["arbiter"]["cache_hit"] is True
    assert proxy.response_cache.stats()["hits"] >= 1


def test_offline_when_no_provider(monkeypatch):
    monkeypatch.setattr(providers, "available", lambda p: False)
    proxy, store, cfg = _proxy("observe")
    out = proxy.handle("claude-opus-4-8", _msg("hello"))
    # no real model -> nothing spent or saved, quality not measured
    assert out["arbiter"]["served_model"] == "offline"
    assert out["arbiter"]["saved"] == 0.0
    assert store.quality_stats() == []
