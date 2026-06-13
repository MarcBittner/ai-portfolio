"""Incident summary: deterministic severity from the multiwindow burn policy +
offline drafter + end-to-end eval accuracy."""

from burnrate import incident


def test_classify_page_is_sev1():
    state = incident._state_from(1000, 0.08)   # fast burn, both windows
    c = incident.classify(state)
    assert c["action"] == "page"
    assert c["severity"] == "sev1"
    assert c["situation"] == "availability"


def test_classify_ticket_is_sev2():
    state = incident._state_from(2000, 0.02)   # slow burn, both windows
    c = incident.classify(state)
    assert c["action"] == "ticket"
    assert c["severity"] == "sev2"


def test_classify_latency_only_is_sev3():
    state = incident._state_from(1000, 0.0, fast_ratio=0.80, p95=600.0)
    c = incident.classify(state)
    assert c["severity"] == "sev3"
    assert c["situation"] == "latency"


def test_classify_healthy_is_none():
    c = incident.classify(incident._state_from(1000, 0.0))
    assert c["severity"] == "none"
    assert c["situation"] == "healthy"


def test_offline_summary_is_deterministic_and_shaped():
    state = incident._state_from(1000, 0.08, fast_ratio=0.80, p95=600.0)
    out = incident.summarize(state, mode="offline")
    assert out["provider"] == "offline"
    assert out["severity"] == "sev1"
    assert out["situation"] == "both"
    assert out["summary"].startswith("[SEV1]")
    assert len(out["suggested_steps"]) >= 3
    # reproducible
    again = incident.summarize(state, mode="offline")
    assert again["summary"] == out["summary"]


def test_eval_is_perfect_offline():
    r = incident.evaluate(mode="offline")
    assert r["severity_accuracy"] == 1.0
    assert r["situation_accuracy"] == 1.0
    assert r["summary_nonempty"] == 1.0
    assert r["steps_actionable"] == 1.0
    assert r["providers_used"] == ["offline"]
