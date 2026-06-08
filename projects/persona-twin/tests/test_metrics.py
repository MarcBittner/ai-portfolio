"""Hand-rolled Prometheus metrics: data model, exposition format, endpoint."""

import httpx
import pytest

from persona_twin.api.app import app, build_state
from persona_twin.chunking import get_chunker
from persona_twin.config import Settings
from persona_twin.observability.metrics import Counter, Gauge, Histogram, render
from persona_twin.pipeline import ingest_corpus


def _lines(metric) -> list[str]:
    return metric.render()


def test_counter_render():
    c = Counter("pt_test_total", "help text", ("a",))
    c.inc("x")
    c.inc("x")
    c.inc("y", amount=3)
    out = _lines(c)
    assert "# TYPE pt_test_total counter" in out
    assert 'pt_test_total{a="x"} 2' in out
    assert 'pt_test_total{a="y"} 3' in out


def test_counter_label_validation():
    c = Counter("pt_x", "h", ("a", "b"))
    with pytest.raises(ValueError):
        c.inc("only-one")


def test_gauge_set_and_clear():
    g = Gauge("pt_g", "h", ("k",))
    g.set("a", value=5)
    assert 'pt_g{k="a"} 5' in _lines(g)
    g.clear()
    assert not any("pt_g{" in line for line in _lines(g))


def test_histogram_buckets_cumulative_and_sum():
    h = Histogram("pt_lat_ms", "h", ("p",), buckets=(10, 100, 1000))
    for v in (5, 50, 50, 5000):  # 1≤10, 2≤100, 3≤1000, 4≤+Inf
        h.observe("ollama", value=v)
    out = _lines(h)
    le10 = next(line for line in out if 'le="10"' in line)
    le100 = next(line for line in out if 'le="100"' in line)
    le1000 = next(line for line in out if 'le="1000"' in line)
    leinf = next(line for line in out if 'le="+Inf"' in line)
    assert le10.endswith(" 1")
    assert le100.endswith(" 3")  # cumulative: 1 + 2
    assert le1000.endswith(" 3")  # the 5000 falls outside
    assert leinf.endswith(" 4")  # +Inf is the total count
    assert any(line == "pt_lat_ms_count{p=\"ollama\"} 4" for line in out)
    assert any(line.startswith("pt_lat_ms_sum{p=\"ollama\"} ") for line in out)


def test_label_escaping():
    c = Counter("pt_esc", "h", ("name",))
    c.inc('a"b\\c')
    rendered = "\n".join(_lines(c))
    assert 'name="a\\"b\\\\c"' in rendered


def test_render_ends_with_newline_and_includes_extra():
    body = render(["# extra", "custom_metric 1"])
    assert body.endswith("\n")
    assert "custom_metric 1" in body


@pytest.fixture
async def client():
    app.state.twin = build_state(Settings(_env_file=None))
    st = app.state.twin
    await ingest_corpus(get_chunker("content_aware"), st.embedder, st.store,
                        records=st.records)
    st.bm25.build(await st.store.all_chunks())
    async with httpx.ASGITransport(app=app) as transport, httpx.AsyncClient(
        transport=transport, base_url="http://test") as c:
        yield c


async def test_metrics_endpoint_exposition(client):
    # generate some signal first
    await client.post("/ask", json={
        "persona_id": "ada-quill",
        "question": "What tomato variety are you growing this year?",
    })
    r = await client.get("/metrics")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain; version=0.0.4")
    body = r.text
    # pull-style gauges
    assert "persona_twin_build_info{" in body
    assert "persona_twin_chunks_indexed " in body
    assert "persona_twin_personas " in body
    # the mock LLM call was recorded as a latency histogram + request counter
    assert "persona_twin_llm_latency_ms_bucket{" in body
    assert 'provider="mock"' in body
    assert "persona_twin_requests_total{" in body
