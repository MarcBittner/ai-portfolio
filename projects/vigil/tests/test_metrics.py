"""Rolling metrics math — the deterministic reducer over the probe time series."""

import os
import tempfile

os.environ["VIGIL_DB"] = os.path.join(tempfile.mkdtemp(), "vigil-metrics.db")

from vigil import metrics, store  # noqa: E402


def _fresh():
    store.config.DB_PATH.unlink(missing_ok=True)
    store.init_db()


def test_summary_unknown_with_no_probes():
    _fresh()
    s = metrics.summarize("slo-kit")
    assert s["status"] == "unknown"
    assert s["availability"] is None


def test_availability_and_error_rate():
    _fresh()
    for up in [True, True, True, False]:  # 3/4 up
        store.record_probe("slo-kit", up, 200 if up else 503,
                           40.0 if up else None, None if up else "HTTP 503")
    s = metrics.summarize("slo-kit")
    assert s["availability"] == 0.75
    assert s["error_rate"] == 0.25
    assert s["samples"] == 4


def test_status_down_when_latest_down():
    _fresh()
    store.record_probe("slo-kit", True, 200, 30.0, None)
    store.record_probe("slo-kit", False, None, None, "timeout")
    assert metrics.summarize("slo-kit")["status"] == "down"


def test_status_degraded_below_threshold_but_up():
    _fresh()
    # 18 up then 2 down then 1 up — latest up, availability 0.857 < 0.95 → degraded
    for _ in range(18):
        store.record_probe("x", True, 200, 30.0, None)
    store.record_probe("x", False, None, None, "timeout")
    store.record_probe("x", False, None, None, "timeout")
    store.record_probe("x", True, 200, 30.0, None)
    s = metrics.summarize("x")
    assert s["status"] == "degraded"
    assert s["availability"] < 0.95


def test_guest_view_projects_minimal_shape():
    _fresh()
    store.record_probe("slo-kit", True, 200, 30.0, None)
    rows = metrics.guest_view()
    assert rows
    for r in rows:
        # the guest tier must never leak history/latency/logs
        assert set(r) == {"slug", "name", "status", "error_rate", "self_monitor"}


def test_fleet_rollup_counts():
    _fresh()
    store.record_probe("slo-kit", True, 200, 30.0, None)
    store.record_probe("burnrate", False, None, None, "timeout")
    roll = metrics.fleet_rollup()
    assert "burnrate" in roll["down"]
    assert roll["targets_total"] >= 2
