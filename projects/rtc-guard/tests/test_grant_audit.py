"""The least-privilege grant auditor (offline deterministic path).

The auditor only *reviews* a proposed grant — it must catch over-permissioning,
never weaken a real token. These tests pin the offline rule auditor's behavior so
the demo and the eval reproduce with zero keys.
"""

from rtc_guard import grant_audit as ga

CLEAN_VIEWER = {"identity": "alice", "room": "room-a", "role": "viewer",
                "ttl": 300, "roomJoin": True, "canSubscribe": True}


def _issues(out):
    return " ".join(f["issue"].lower() for f in out["findings"])


def test_clean_viewer_is_least_privilege():
    out = ga.audit(CLEAN_VIEWER)
    assert out["least_privilege"] is True
    assert out["finding_count"] == 0
    assert out["by_severity"]["high"] == 0
    assert out["provider"] == "offline"


def test_over_permissioned_viewer_is_flagged():
    # a viewer asking for publish + data + no room + day-long TTL
    out = ga.audit({"identity": "eve", "room": "", "role": "viewer", "ttl": 86_400,
                    "roomJoin": True, "canSubscribe": True, "canPublish": True,
                    "canPublishData": True})
    assert out["least_privilege"] is False
    assert out["by_severity"]["high"] >= 1
    issues = _issues(out)
    assert "canpublish" in issues       # capability over-grant
    assert "room" in issues             # missing room scope
    assert "ttl" in issues              # over-long TTL


def test_clean_grant_has_no_high_severity_findings():
    out = ga.audit(CLEAN_VIEWER)
    assert all(f["severity"] != "high" for f in out["findings"])


def test_consumer_data_channel_flagged_high():
    # a pure consumer (no role) with an inbound data channel = injection vector
    out = ga.audit({"identity": "x", "room": "room-a", "role": "", "ttl": 300,
                    "roomJoin": True, "canSubscribe": True, "canPublishData": True})
    assert out["by_severity"]["high"] >= 1
    assert "data-channel" in _issues(out)


def test_explanation_describes_capabilities():
    out = ga.audit(CLEAN_VIEWER)
    expl = out["explanation"].lower()
    assert "room-a" in expl and "subscribe" in expl


def test_output_shape_matches_llm_contract():
    out = ga.audit(CLEAN_VIEWER)
    assert set(out) >= {"explanation", "findings", "finding_count", "by_severity",
                        "least_privilege", "provider", "mode"}
    for f in out["findings"]:
        assert set(f) == {"severity", "issue", "recommendation"}
        assert f["severity"] in ga.SEVERITIES


def test_evaluate_recall_is_sane():
    r = ga.evaluate()
    # offline auditor must miss nothing on the labeled set (recall is the metric)
    assert r["recall"] == 1.0
    assert r["false_negatives"] == 0
    assert r["grants"] == len(ga.LABELED)
    assert r["providers_used"] == ["offline"]
