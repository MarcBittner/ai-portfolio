"""Opt-in live smoke / regression suite — runs against a real HTTP endpoint.

Gated by env so the offline unit suite never touches the network:
  BURNRATE_LIVE=1 BURNRATE_BASE_URL=http://127.0.0.1:8023 \
      python -m pytest tests/test_live_smoke.py
or via:  ./run.sh smoke            (local server)
         ./run.sh smoke --url URL  (remote deployment)

It exercises the same burn→recover contract the CD pipeline's post-deploy gate
runs, so a green smoke here is the signal a rollout is safe.
"""

import json
import os
import urllib.request

import pytest

LIVE = os.environ.get("BURNRATE_LIVE") == "1"
BASE = os.environ.get("BURNRATE_BASE_URL", "http://127.0.0.1:8023").rstrip("/")

pytestmark = pytest.mark.skipif(
    not LIVE, reason="set BURNRATE_LIVE=1 and BURNRATE_BASE_URL to run live smoke"
)


def _req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=10) as r:
        ct = r.headers.get("content-type", "")
        raw = r.read().decode()
        return r.status, (json.loads(raw) if "json" in ct else raw)


def test_healthz_live():
    status, body = _req("GET", "/healthz")
    assert status == 200 and body["status"] == "ok"


def test_metrics_live():
    status, body = _req("GET", "/metrics")
    assert status == 200 and "burnrate_requests_total" in body


def test_burn_recover_contract_live():
    _req("POST", "/admin/reset")
    _, burning = _req("POST", "/admin/inject", {"error_rate": 0.08, "latency_ms": 450})
    _, burning = _req("POST", "/admin/loadtest", {"n": 300})
    assert burning["burn_policy"]["action"] == "page"

    _req("POST", "/admin/reset")
    _req("POST", "/admin/loadtest", {"n": 300})
    _, slo = _req("GET", "/slo")
    assert slo["overall_status"] == "healthy"
    assert slo["burn_policy"]["action"] == "none"


def test_incident_summary_live():
    _req("POST", "/admin/reset")
    _req("POST", "/admin/inject", {"error_rate": 0.08})
    _req("POST", "/admin/loadtest", {"n": 300})
    status, body = _req("POST", "/incident/summary", {"mode": "offline"})
    assert status == 200 and body["severity"] == "sev1"
    _req("POST", "/admin/reset")
