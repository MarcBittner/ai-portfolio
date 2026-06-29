"""Tests for the self-eval and the /diagnostics endpoint."""

from fastapi.testclient import TestClient

from agent_factory import evals
from agent_factory.api import app

client = TestClient(app)


def test_self_eval_all_green_offline():
    result = evals.run_self_eval()
    assert result["passed"] == result["total"]  # deterministic, no model needed
    assert result["total"] >= 4


def test_diagnostics_reports_routing_and_self_eval():
    # Explicitly opt in to the self-eval (it is no longer run by default).
    r = client.get("/diagnostics?selftest=true")
    assert r.status_code == 200
    body = r.json()
    routing = body["routing"]
    assert routing["lead_provider"] in routing["resolved_order"] + ["mock"]
    assert routing["why"]
    assert "resolved_order" in routing and "available" in routing
    assert body["self_eval"]["passed"] == body["self_eval"]["total"]
    assert body["tools"]["count"] >= 1


def test_diagnostics_can_skip_self_eval():
    r = client.get("/diagnostics?selftest=false")
    assert r.status_code == 200 and "self_eval" not in r.json()
