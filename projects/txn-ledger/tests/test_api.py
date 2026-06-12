from fastapi.testclient import TestClient

from txn_ledger.api import app

client = TestClient(app)


def test_health_and_summary():
    b = client.get("/health").json()
    assert b["status"] == "ok" and b["rows"] > 0 and b["committees"] == 12
    assert client.get("/summary").json()["total_raised"] > 0


def test_schema_lists_index():
    s = client.get("/schema").json()
    assert any("idx_cycle_committee" in i for i in s["indexes"])


def test_plan_before_and_after():
    p = client.get("/plan").json()
    assert any("SCAN" in ln for ln in p["plan_before_index"])
    assert any("SEARCH" in ln for ln in p["plan_after_index"])


def test_aggregate():
    a = client.get("/aggregate?cycle=2026").json()
    assert a["rows"] and a["cycle"] == 2026
    assert a["rows"][0]["total_raised"] >= a["rows"][-1]["total_raised"]


def test_invalid_cycle_422():
    assert client.get("/aggregate?cycle=1999").status_code == 422


def test_cycles_and_committees():
    assert 2026 in client.get("/cycles").json()["cycles"]
    assert len(client.get("/committees").json()["committees"]) == 12


def test_loadtest():
    r = client.post("/loadtest", json={"n": 50}).json()
    assert r["queries"] == 50 and r["qps"] > 0
