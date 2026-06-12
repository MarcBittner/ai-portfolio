from slo_kit.metrics import LATENCY_TARGET_MS, Metrics


def test_records_rate_errors_duration():
    m = Metrics()
    for i in range(100):
        m.record("POST /v1/messages", 200 if i % 10 else 500, float(i + 1))
    snap = m.snapshot()
    assert snap["total"] == 100
    assert snap["errors"] == 10                 # i % 10 == 0 → 10 of them
    assert snap["error_rate"] == 0.1
    assert snap["p50_ms"] <= snap["p95_ms"] <= snap["p99_ms"]


def test_fast_ratio_tracks_latency_target():
    m = Metrics()
    m.record("e", 200, LATENCY_TARGET_MS - 1)   # fast
    m.record("e", 200, LATENCY_TARGET_MS + 100)  # slow
    assert m.snapshot()["fast_ratio"] == 0.5


def test_prometheus_exposition():
    m = Metrics()
    m.record("e", 200, 40.0)
    m.record("e", 500, 40.0)
    text = m.prometheus()
    assert 'slo_requests_total{status="200"} 1' in text
    assert "slo_request_errors_total 1" in text
    assert 'slo_request_duration_ms{quantile="0.95"}' in text


def test_reset_clears():
    m = Metrics()
    m.record("e", 200, 10.0)
    m.reset()
    assert m.snapshot()["total"] == 0
