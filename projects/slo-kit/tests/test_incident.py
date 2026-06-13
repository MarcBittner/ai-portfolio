"""The incident-summary feature: deterministic severity + runbook steps from a
snapshot, offline path is terminal, and the eval invariants hold."""

from slo_kit import incident, service, slo
from slo_kit.metrics import registry


def _state(total, error_rate, fast_ratio=1.0, p95=40.0):
    snap = {"total": total, "errors": round(total * error_rate),
            "error_rate": error_rate, "fast_ratio": fast_ratio, "p95_ms": p95,
            "p99_ms": p95, "by_status": {}, "latency_target_ms": 250.0}
    return {"slo": slo.compute(snap),
            "metrics": {"total": total, "errors": snap["errors"],
                        "error_rate": error_rate, "p95_ms": p95, "p99_ms": p95,
                        "by_status": {}, "latency_target_ms": 250.0},
            "recent_error_spans": [], "error_span_count": 0,
            "fault": {"error_rate": error_rate, "latency_ms": 0.0}}


def test_healthy_snapshot_is_no_incident():
    out = incident.summarize(_state(1000, 0.0))
    assert out["severity"] == "none"
    assert out["situation"] == "healthy"
    assert out["provider"] == "offline"
    assert out["summary"].strip()


def test_burning_snapshot_picks_top_severity_and_steps():
    # 5% errors against a 0.5% budget → exhausted, fast burn → sev1
    out = incident.summarize(_state(1000, 0.05))
    assert out["severity"] == "sev1"
    assert out["situation"] == "availability"
    # suggested steps must be actionable during a real incident
    assert len(out["suggested_steps"]) >= 3
    assert all(s.strip() for s in out["suggested_steps"])


def test_latency_only_violation_is_an_incident():
    out = incident.summarize(_state(1000, 0.0, fast_ratio=0.80, p95=600.0))
    assert out["situation"] == "latency"
    assert out["severity"] != "none"
    assert len(out["suggested_steps"]) >= 3


def test_severity_is_deterministic_not_from_llm():
    # severity comes from classify(), never the model — offline path proves it
    c = incident.classify(_state(1000, 0.05))
    assert c["severity"] == "sev1"
    assert c["situation"] == "availability"
    assert c["burn_rate"] == 10.0


def test_summarize_on_live_state_returns_shape():
    service.reset()
    service.loadtest(200)
    out = incident.summarize()  # pulls collect_state() from the live registry
    assert {"summary", "severity", "suggested_steps", "situation",
            "provider", "fallbacks"} <= set(out)
    assert out["severity"] == "none"  # steady traffic is healthy
    service.reset()


def test_eval_scores_perfect_offline():
    ev = incident.evaluate()
    assert ev["severity_accuracy"] == 1.0
    assert ev["situation_accuracy"] == 1.0
    assert ev["steps_actionable"] == 1.0
    assert ev["providers_used"] == ["offline"]


def test_collect_state_matches_registry_snapshot():
    service.reset()
    service.set_fault(error_rate=0.5, latency_ms=500)
    service.loadtest(100)
    st = incident.collect_state()
    assert st["metrics"]["total"] == registry.snapshot()["total"]
    assert st["error_span_count"] > 0  # the injected fault produced error spans
    assert st["slo"]["overall_status"] == "at_risk"
    service.reset()
