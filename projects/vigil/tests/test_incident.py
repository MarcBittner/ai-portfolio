"""Incident summarizer — code decides severity/priority; offline drafter narrates."""

import os
import tempfile

os.environ["VIGIL_DB"] = os.path.join(tempfile.mkdtemp(), "vigil-incident.db")

from vigil import incident, store  # noqa: E402


def _fresh():
    store.config.DB_PATH.unlink(missing_ok=True)
    store.init_db()


def test_classifier_eval_is_exact_offline():
    e = incident.evaluate()
    assert e["situation_accuracy"] == 1.0
    assert e["severity_accuracy"] == 1.0
    assert e["actions_present"] == 1.0


def test_healthy_fleet_is_severity_none():
    _fresh()
    for t in store.list_targets():
        store.record_probe(t.slug, True, 200, 30.0, None)
    out = incident.summarize(mode="offline")
    assert out["severity"] == "none"
    assert out["situation"] == "healthy"
    assert out["provider"] == "offline"
    assert out["summary"].strip()


def test_outage_escalates_and_prioritizes():
    _fresh()
    for t in store.list_targets():
        store.record_probe(t.slug, True, 200, 30.0, None)
    store.record_probe("burnrate", False, None, None, "timeout")
    out = incident.summarize(mode="offline")
    assert out["severity"] in ("sev2", "sev1")
    assert "burnrate" in out["impacted"]
    assert len(out["suggested_actions"]) >= 1


def test_client_summary_used_but_severity_is_code_decided():
    _fresh()
    for t in store.list_targets():
        store.record_probe(t.slug, True, 200, 30.0, None)
    store.record_probe("burnrate", False, None, None, "timeout")
    out = incident.summarize(client_summary='{"summary":"hi","severity":"none"}')
    assert out["provider"] == "client-ollama"
    assert out["summary"] == "hi"
    # client claimed "none" but code computed the real severity from the fleet
    assert out["severity"] != "none"
