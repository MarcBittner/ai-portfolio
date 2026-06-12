from slo_kit.slo import AVAILABILITY_SLO, compute


def _snap(total, error_rate, fast_ratio=1.0, p95=40.0):
    return {"total": total, "error_rate": error_rate, "fast_ratio": fast_ratio,
            "p95_ms": p95, "latency_target_ms": 250.0}


def test_healthy_full_budget():
    s = compute(_snap(1000, 0.0))
    assert s["overall_status"] == "healthy"
    assert s["availability"]["sli"] == 1.0
    assert s["availability"]["budget_remaining"] == 1.0
    assert s["availability"]["burn_rate"] == 0.0


def test_budget_exhausted_and_burning_fast():
    # 5% errors against a 0.5% budget → 10x over, budget gone
    s = compute(_snap(1000, 0.05))
    assert s["availability"]["status"] == "exhausted"
    assert s["availability"]["budget_remaining"] == 0.0
    assert s["availability"]["burn_rate"] == 10.0
    assert s["overall_status"] == "at_risk"


def test_partial_burn_within_budget():
    # error rate below the 0.5% budget → burning but budget remains
    s = compute(_snap(10000, 0.002))
    assert s["availability"]["status"] in ("burning", "healthy")
    assert 0 < s["availability"]["budget_remaining"] < 1.0


def test_latency_violation():
    s = compute(_snap(1000, 0.0, fast_ratio=0.80))
    assert s["latency"]["status"] == "violated"
    assert s["overall_status"] == "at_risk"


def test_no_data():
    s = compute(_snap(0, 0.0))
    assert s["availability"]["status"] == "no_data"
    assert s["overall_status"] == "healthy"
    assert AVAILABILITY_SLO == 0.995
