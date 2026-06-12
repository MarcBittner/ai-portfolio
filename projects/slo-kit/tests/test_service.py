from slo_kit import service
from slo_kit.metrics import registry


def test_healthy_load_has_no_errors():
    service.reset()
    snap = service.loadtest(200)
    assert snap["window_requests"] == 200
    assert snap["overall_status"] == "healthy"
    assert registry.snapshot()["errors"] == 0


def test_fault_injects_deterministic_error_rate():
    service.reset()
    service.set_fault(error_rate=0.5)
    service.loadtest(100)
    # every 2nd request errors → exactly 50
    assert registry.snapshot()["errors"] == 50


def test_fault_latency_raises_p95():
    service.reset()
    service.loadtest(100)
    base_p95 = registry.snapshot()["p95_ms"]
    service.reset()
    service.set_fault(latency_ms=500)
    service.loadtest(100)
    assert registry.snapshot()["p95_ms"] >= base_p95 + 500


def test_send_message_outbox_and_failure():
    service.reset()
    status, msg = service.send_message("email", "a@example.com", "hi")
    assert status == 200 and service.outbox()[0]["id"] == msg["id"]
    service.set_fault(error_rate=1.0)
    status2, payload = service.send_message("email", "a@example.com", "hi")
    assert status2 == 500 and "error" in payload


def test_reset_clears_everything():
    service.set_fault(error_rate=0.5)
    service.loadtest(10)
    service.reset()
    assert registry.snapshot()["total"] == 0
    assert service.fault.error_rate == 0.0
