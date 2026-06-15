from routelens.cache import (
    ResponseCache,
    prefix_signature,
    request_key,
    should_cache_prefix,
)
from routelens.cost import cost_usd
from routelens.registry import DEFAULT as REG


def test_cost_basic():
    # opus 15/75 $/Mtok; 1000 in + 1000 out
    assert cost_usd(REG, "claude-opus-4-8", 1000, 1000) == 0.09


def test_cost_cached_input_cheaper():
    full = cost_usd(REG, "claude-opus-4-8", 1000, 0)
    cached = cost_usd(REG, "claude-opus-4-8", 1000, 0, cached_in_tokens=1000)
    assert cached < full
    assert round(cached, 6) == round(full * 0.10, 6)


def test_local_is_free():
    assert cost_usd(REG, "local-small", 10000, 10000) == 0.0


def test_request_key_stable_and_sensitive():
    a = request_key("m", [{"role": "user", "content": "hi"}], 100, 0.0)
    b = request_key("m", [{"role": "user", "content": "hi"}], 100, 0.0)
    c = request_key("m", [{"role": "user", "content": "ho"}], 100, 0.0)
    assert a == b and a != c


def test_prefix_signature_and_threshold():
    msgs = [{"role": "system", "content": "S" * 8000},
            {"role": "user", "content": "q"}]
    h, toks = prefix_signature(msgs)
    assert toks >= 1024 and should_cache_prefix(toks)
    assert not should_cache_prefix(10)


def test_response_cache_hit_and_ttl():
    clock = [0.0]
    rc = ResponseCache(ttl_s=10, now=lambda: clock[0])
    rc.put("k", "text", 10, 5, "m")
    assert rc.get("k").text == "text"
    clock[0] = 100  # expire
    assert rc.get("k") is None
    assert rc.stats()["hits"] == 1
