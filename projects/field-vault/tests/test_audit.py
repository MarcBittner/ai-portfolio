from field_vault.audit import AuditLog


def _log(n):
    log = AuditLog()
    for i in range(n):
        log.append({"event": "access", "role": "analyst", "record_id": f"rec-{i}",
                    "field": "dx_code", "action": "read_deid", "allowed": True})
    return log


def test_chain_verifies_and_links():
    log = _log(4)
    assert log.verify()["ok"] is True
    e = log.entries()
    assert e[0]["prev_hash"] == "0" * 64 and e[1]["prev_hash"] == e[0]["hash"]


def test_tamper_detected():
    log = _log(4)
    assert log.demo_tamper(2) is True
    v = log.verify()
    assert v["ok"] is False and v["broken_at"] == 2


def test_audit_never_stores_a_value():
    # entries carry decision metadata, not field values
    log = _log(2)
    assert all("value" not in e for e in log.entries())
