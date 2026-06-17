"""Live smoke/regression suite — runs against a real HTTP endpoint (a local
uvicorn or a remote deployment). Gated by env so the normal `pytest` run skips it.

    ./run.sh smoke                      # local server, auto start/stop
    ./run.sh smoke --url https://...    # a deployment
"""

import json
import os
import urllib.request

import pytest

LIVE = os.environ.get("ARBITER_LIVE") == "1"
BASE = os.environ.get("ARBITER_BASE_URL", "http://127.0.0.1:8030").rstrip("/")

pytestmark = pytest.mark.skipif(not LIVE, reason="set ARBITER_LIVE=1 to run")


def _get(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=30) as r:
        return json.loads(r.read().decode())


def _post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{BASE}{path}", data=data, method="POST")
    req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def test_health():
    assert _get("/health")["ok"] is True


def test_console_served():
    with urllib.request.urlopen(f"{BASE}/", timeout=30) as r:
        assert r.status == 200
        assert b"arbiter" in r.read().lower()


def test_models_listed():
    assert _get("/models")["models"]


def test_openai_completion_shape():
    body = _post("/v1/chat/completions", {
        "model": "claude-opus-4-8",
        "messages": [{"role": "user", "content": "ping"}]})
    assert body["object"] == "chat.completion"
    assert "arbiter" in body


def test_simulate_and_report():
    _post("/reset", {})
    assert _post("/simulate", {"n": 30, "seed": 1})["ran"] >= 30
    rep = _get("/report")
    assert rep["summary"]["requests"] >= 30
    ops = _get("/opportunities")["opportunities"]
    assert any(o["kind"] in ("response-cache", "prompt-cache") for o in ops)
