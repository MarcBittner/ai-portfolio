"""SLO math + multiwindow burn-rate policy: burn and recover."""

from burnrate import service, slo


def _snap(total, error_rate, fast_ratio=1.0, p95=40.0):
    return {"total": total, "errors": round(total * error_rate),
            "error_rate": error_rate, "fast_ratio": fast_ratio, "p95_ms": p95,
            "by_status": {}, "latency_target_ms": 250.0}


def test_steady_is_healthy():
    s = slo.compute(_snap(1000, 0.0))
    assert s["availability"]["status"] == "healthy"
    assert s["availability"]["budget_remaining"] == 1.0
    assert s["burn_policy"]["action"] == "none"
    assert s["overall_status"] == "healthy"


def test_burn_rate_is_error_over_budget():
    # 0.5% error == exactly 1x (sustainable); 5% == 10x.
    assert slo.burn_rate(0.005) == 1.0
    assert slo.burn_rate(0.05) == 10.0
    assert slo.burn_rate(0.0) == 0.0


def test_fast_burn_pages_when_both_windows_clear():
    # 8% error in both windows: 16x >= 14.4 fast threshold -> page, exhausted.
    s = slo.compute(_snap(1000, 0.08), _snap(1000, 0.08))
    assert s["availability"]["status"] == "exhausted"
    assert s["availability"]["burn_rate"] == 16.0
    assert s["burn_policy"]["action"] == "page"
    assert s["burn_policy"]["fast"]["firing"] is True


def test_slow_burn_tickets_not_pages():
    # 2% error: 4x -> clears 3x slow but not 14.4x fast -> ticket.
    s = slo.compute(_snap(2000, 0.02), _snap(2000, 0.02))
    assert s["burn_policy"]["action"] == "ticket"
    assert s["burn_policy"]["fast"]["firing"] is False
    assert s["burn_policy"]["slow"]["firing"] is True


def test_multiwindow_requires_both_windows():
    # Long window quiet, short window spiking: not a page (not sustained yet).
    s = slo.compute(_snap(10000, 0.001), _snap(200, 0.08))
    assert s["burn_policy"]["action"] == "none"
    assert s["burn_policy"]["long_window_burn"] < slo.FAST_BURN


def test_latency_violation_independent_of_availability():
    s = slo.compute(_snap(1000, 0.0, fast_ratio=0.80, p95=600.0))
    assert s["latency"]["status"] == "violated"
    assert s["availability"]["status"] == "healthy"
    assert s["overall_status"] == "at_risk"


def test_no_data():
    s = slo.compute(_snap(0, 0.0))
    assert s["availability"]["status"] == "no_data"
    assert s["latency"]["status"] == "no_data"


def test_service_burn_then_recover():
    service.reset()
    steady = service.loadtest(500)
    assert steady["availability"]["status"] == "healthy"
    assert steady["burn_policy"]["action"] == "none"

    service.reset()
    service.set_fault(error_rate=0.08, latency_ms=450)
    burning = service.loadtest(500)
    assert burning["availability"]["status"] == "exhausted"
    assert burning["burn_policy"]["action"] == "page"
    assert burning["latency"]["status"] == "violated"

    service.reset()
    recovered = service.loadtest(500)
    assert recovered["availability"]["status"] == "healthy"
    assert recovered["burn_policy"]["action"] == "none"
    service.reset()
