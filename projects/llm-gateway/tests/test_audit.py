from llm_gateway.audit import AuditLog


def _log_with(n):
    log = AuditLog()
    for i in range(n):
        log.append({"event": "complete", "input_verdict": "allow",
                    "output_verdict": "allow", "request": f"r{i}", "response": f"o{i}"})
    return log


def test_chain_verifies():
    log = _log_with(5)
    v = log.verify()
    assert v["ok"] is True and v["length"] == 5 and v["broken_at"] is None


def test_each_entry_links_to_previous():
    log = _log_with(3)
    e = log.entries()
    assert e[0]["prev_hash"] == "0" * 64
    assert e[1]["prev_hash"] == e[0]["hash"]
    assert e[2]["prev_hash"] == e[1]["hash"]


def test_tamper_is_detected():
    log = _log_with(4)
    assert log.demo_tamper(1) is True
    v = log.verify()
    assert v["ok"] is False
    assert v["broken_at"] == 1
    assert "hash" in v["reason"]


def test_empty_log_verifies():
    assert AuditLog().verify()["ok"] is True
