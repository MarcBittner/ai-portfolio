"""Prometheus text parser (well-formed + malformed), metric storage + series
retrieval, vigil's own /metrics exposition, the scrape path, and role-gating of
the metrics viewer."""

import os
import tempfile

os.environ["VIGIL_DB"] = os.path.join(tempfile.mkdtemp(), "vigil-metricscrape.db")
os.environ["VIGIL_ADMIN_EMAIL"] = "marc.bittner@gmail.com"
os.environ["VIGIL_DISABLE_POLLER"] = "1"

import math  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

from vigil import auth, config, promparse, selfmetrics, store  # noqa: E402
from vigil.api import app  # noqa: E402

# --------------------------------------------------------------------------- #
# Prometheus text parser                                                        #
# --------------------------------------------------------------------------- #

def test_parse_well_formed():
    text = """# HELP http_requests_total The total number of HTTP requests.
# TYPE http_requests_total counter
http_requests_total{method="post",code="200"} 1027
http_requests_total{method="post",code="400"} 3
# a plain metric
process_cpu_seconds 4.2
go_gc_duration_seconds{quantile="0.5"} 0.0001 1395066363000
"""
    out = promparse.parse(text)
    # labelled line parsed with both labels + value
    assert any(n == "http_requests_total"
               and lbl == {"method": "post", "code": "200"} and v == 1027.0
               for n, lbl, v in out)
    # plain line
    assert ("process_cpu_seconds", {}, 4.2) in out
    # value with a trailing timestamp: timestamp ignored, value kept
    assert any(n == "go_gc_duration_seconds" and v == 0.0001 for n, _, v in out)


def test_parse_special_floats():
    out = dict((n, v) for n, _, v in promparse.parse(
        "a +Inf\nb -Inf\nc NaN\n"))
    assert out["a"] == math.inf and out["b"] == -math.inf
    assert math.isnan(out["c"])


def test_parse_escaped_labels():
    out = promparse.parse('msg{text="line\\nbreak",path="a\\"b"} 1\n')
    assert len(out) == 1
    _, labels, value = out[0]
    assert value == 1.0
    assert labels["text"] == "line\nbreak"
    assert labels["path"] == 'a"b'


def test_parse_malformed_never_raises():
    bad_inputs = [
        "this is not metrics at all",
        "<html><body>404 not found</body></html>",
        "name{unterminated 5",
        'name{label="unterminated 5',
        "name_without_value",
        "name {} notanumber",
        "= 5",
        "",
        "\n\n\n",
        "# just a comment",
        None,            # non-string
        123,             # non-string
        "weird{a=1} 5",  # unquoted label value
    ]
    for inp in bad_inputs:
        # Must never raise; returns a list.
        result = promparse.parse(inp)
        assert isinstance(result, list)


def test_parse_partial_recovers_good_lines():
    text = "good_metric 1\nthis is junk\nanother_good 2\n"
    names = {n for n, _, _ in promparse.parse(text)}
    assert "good_metric" in names and "another_good" in names


# --------------------------------------------------------------------------- #
# Storage + series                                                              #
# --------------------------------------------------------------------------- #

def _fresh():
    store.config.DB_PATH.unlink(missing_ok=True)
    store.init_db()


def test_record_and_series():
    _fresh()
    store.record_metrics("slo-kit", 100.0, [("reqs", {}, 1.0), ("reqs", {}, 2.0)])
    store.record_metrics("slo-kit", 200.0, [("reqs", {}, 3.0)])
    series = store.metric_series("slo-kit", "reqs", limit=10)
    assert len(series) == 3
    # newest-first
    assert series[0]["value"] == 3.0


def test_record_skips_non_finite():
    _fresh()
    n = store.record_metrics("slo-kit", 1.0, [
        ("ok", {}, 1.0), ("inf", {}, math.inf), ("nan", {}, math.nan)])
    assert n == 1
    assert store.distinct_metric_names("slo-kit") == ["ok"]


def test_record_caps_series_per_scrape(monkeypatch):
    _fresh()
    monkeypatch.setattr(config, "MAX_SERIES_PER_SCRAPE", 3)
    samples = [(f"m{i}", {}, float(i)) for i in range(20)]
    assert store.record_metrics("slo-kit", 1.0, samples) == 3


def test_latest_metrics_one_per_series():
    _fresh()
    store.record_metrics("slo-kit", 100.0, [("g", {"k": "v"}, 1.0)])
    store.record_metrics("slo-kit", 200.0, [("g", {"k": "v"}, 9.0)])
    latest = store.latest_metrics("slo-kit")
    g = [r for r in latest if r["name"] == "g"]
    assert len(g) == 1 and g[0]["value"] == 9.0  # latest sample wins


def test_metrics_prunes(monkeypatch):
    _fresh()
    monkeypatch.setattr(config, "MAX_METRICS_PER_TARGET", 4)
    for i in range(10):
        store.record_metrics("slo-kit", float(i), [("x", {}, float(i))])
    assert len(store.metric_series("slo-kit", "x", limit=100)) == 4


# --------------------------------------------------------------------------- #
# vigil's own /metrics                                                          #
# --------------------------------------------------------------------------- #

def _client():
    store.config.DB_PATH.unlink(missing_ok=True)
    auth.signup_limiter._buckets.clear()
    return TestClient(app)


def test_vigil_own_metrics_is_parseable_prometheus():
    with _client() as c:
        selfmetrics.inc("vigil_probes_total", 5)
        r = c.get("/metrics")
        assert r.status_code == 200
        assert "text/plain" in r.headers["content-type"]
        parsed = promparse.parse(r.text)
        names = {n for n, _, _ in parsed}
        # Real counters/gauges are present and parse cleanly.
        assert "vigil_probes_total" in names
        assert "vigil_targets_total" in names
        assert "vigil_uptime_seconds" in names
        # The counter we bumped is reflected.
        probes = next(v for n, _, v in parsed if n == "vigil_probes_total")
        assert probes >= 5


# --------------------------------------------------------------------------- #
# Scrape path + viewer role gate                                                #
# --------------------------------------------------------------------------- #

def test_scrape_metrics_stores_self(monkeypatch):
    """A real scrape against vigil's own /metrics (via probe_one's sibling) stores
    samples for the vigil slug. We call the sync scraper directly with a stub
    target pointing at an in-memory exposition to keep it hermetic."""
    from vigil import probe

    _fresh()

    class _Resp:
        status_code = 200
        headers = {"content-type": "text/plain"}
        text = "demo_metric 7\nother{a=\"b\"} 2\n"

    class _Client:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, follow_redirects=True): return _Resp()

    monkeypatch.setattr(probe.httpx, "Client", lambda *a, **k: _Client())
    t = store.get_target("slo-kit")
    stored = probe._scrape_metrics_sync(t)
    assert stored == 2
    assert "demo_metric" in store.distinct_metric_names("slo-kit")


def test_scrape_skips_html_and_non_200(monkeypatch):
    from vigil import probe
    _fresh()

    class _Resp:
        def __init__(self, code, ctype, text):
            self.status_code = code
            self.headers = {"content-type": ctype}
            self.text = text

    class _Client:
        def __init__(self, resp): self.resp = resp
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, follow_redirects=True): return self.resp

    t = store.get_target("slo-kit")
    # HTML 200 → skipped
    monkeypatch.setattr(probe.httpx, "Client",
                        lambda *a, **k: _Client(_Resp(200, "text/html", "<html>x")))
    assert probe._scrape_metrics_sync(t) == 0
    # 404 → skipped
    monkeypatch.setattr(probe.httpx, "Client",
                        lambda *a, **k: _Client(_Resp(404, "text/plain", "nope")))
    assert probe._scrape_metrics_sync(t) == 0


def _register_verified(c, email):
    r = c.post("/auth/signup", json={"email": email, "password": "password1"})
    token = r.json()["verification"]["link"].split("token=")[1]
    c.get(f"/auth/verify?token={token}", follow_redirects=False)


def test_metrics_viewer_role_gated_and_empty_state():
    with _client() as c:
        # Guest blocked.
        assert c.get("/api/targets/slo-kit/metrics").status_code == 401
        _register_verified(c, "m@x.test")
        r = c.get("/api/targets/slo-kit/metrics")
        assert r.status_code == 200
        body = r.json()
        # No scrape yet → clean empty state.
        assert body["has_metrics"] is False
        assert body["latest"] == []
        assert "metrics_url" in body


def test_metrics_viewer_returns_series_after_store():
    with _client() as c:
        store.record_metrics("slo-kit", 100.0, [("reqs", {}, 1.0)])
        store.record_metrics("slo-kit", 200.0, [("reqs", {}, 2.0)])
        _register_verified(c, "m2@x.test")
        body = c.get("/api/targets/slo-kit/metrics").json()
        assert body["has_metrics"] is True
        reqs = next(s for s in body["series"] if s["name"] == "reqs")
        # oldest → newest for charting
        assert [p["value"] for p in reqs["points"]] == [1.0, 2.0]
