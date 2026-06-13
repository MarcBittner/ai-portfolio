"""Governance primitives: redaction, tamper-evident audit, rollup."""

from dataclasses import dataclass

from quorum import governance


def test_redaction_masks_each_pii_type():
    text = ("Reach me at jane.doe@example.com or 415-555-0142, "
            "SSN 123-45-6789, account 4929114450021188.")
    out, counts = governance.redact(text)
    for needle in ("jane.doe@example.com", "415-555-0142", "123-45-6789",
                   "4929114450021188"):
        assert needle not in out
    assert counts["EMAIL"] == 1
    assert counts["SSN"] == 1
    assert "[EMAIL]" in out and "[SSN]" in out
    assert governance.contains_pii(text) is True
    assert governance.contains_pii(out) is False


def test_audit_chain_appends_and_verifies():
    log = governance.AuditLog()
    log.append({"step": "a", "event": "agent_step"})
    log.append({"step": "b", "event": "agent_step"})
    v = log.verify()
    assert v["ok"] is True
    assert v["length"] == 2
    assert len(log) == 2


def test_audit_chain_is_tamper_evident():
    log = governance.AuditLog()
    log.append({"step": "a", "output_summary": "ok", "event": "agent_step"})
    log.append({"step": "b", "output_summary": "ok", "event": "agent_step"})
    assert log.verify()["ok"] is True
    assert log.demo_tamper(0) is True
    v = log.verify()
    assert v["ok"] is False
    assert v["broken_at"] == 0  # the first edited entry is reported


def test_pii_never_reaches_the_audit_in_value_light_entry():
    # Simulate the orchestrator's pattern: redact before writing the entry.
    log = governance.AuditLog()
    raw = "Member jane.doe@example.com acct 4929114450021188"
    clean, counts = governance.redact(raw)
    log.append({"step": "x", "prompt_summary": clean, "pii_redacted": counts,
                "event": "agent_step"})
    import json
    blob = json.dumps(log.entries())
    assert "jane.doe@example.com" not in blob
    assert "4929114450021188" not in blob
    assert counts["EMAIL"] == 1


@dataclass
class _Fake:
    provider: str
    model: str
    latency_ms: float
    cost_usd: float


def test_rollup_aggregates_telemetry():
    steps = [_Fake("offline", "deterministic", 1.0, 0.0),
             _Fake("offline", "deterministic", 2.0, 0.0),
             _Fake("openai", "gpt-4o-mini", 50.0, 0.0001)]
    r = governance.rollup(steps)
    assert r["steps"] == 3
    assert r["total_latency_ms"] == 53.0
    assert r["by_provider"] == {"offline": 2, "openai": 1}
    assert "deterministic" in r["models"]
