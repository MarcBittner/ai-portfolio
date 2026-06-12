from fastapi.testclient import TestClient

from field_vault.api import app

client = TestClient(app)


def _reset():
    client.post("/admin/reset")


def test_health_and_roles():
    _reset()
    b = client.get("/health").json()
    assert b["status"] == "ok" and b["records"] > 0 and b["roles"] == 3
    assert {r["role"] for r in client.get("/roles").json()} == {
        "analyst", "care_coordinator", "auditor"}


def test_records_are_deidentified():
    _reset()
    recs = client.get("/records").json()["records"]
    assert recs and all(r["member_name"].startswith("tok_") for r in recs)


def test_record_404():
    assert client.get("/records/rec-9999").status_code == 404


def test_access_allow_and_deny():
    _reset()
    ok = client.post("/access", json={"role": "analyst", "record_id": "rec-0001",
                                      "field": "dx_code"}).json()
    assert ok["allowed"] is True and ok["value"] == "E11.9"
    deny = client.post("/access", json={
        "role": "analyst", "record_id": "rec-0001",
        "field": "member_name", "reidentify": True}).json()
    assert deny["allowed"] is False


def test_reidentify_with_purpose():
    _reset()
    r = client.post("/access", json={"role": "care_coordinator", "record_id": "rec-0001",
                                     "field": "member_name", "purpose": "treatment",
                                     "reidentify": True}).json()
    assert r["allowed"] is True and not r["value"].startswith("tok_")


def test_scores_ranked_and_phi_free():
    _reset()
    ps = client.get("/scores").json()["providers"]
    assert ps[0]["rank"] == 1
    # scores expose only provider/aggregate fields — no member identifiers
    assert all("member_name" not in p and "member_id" not in p for p in ps)


def test_audit_verify():
    _reset()
    client.post("/access", json={"role": "analyst", "record_id": "rec-0001",
                                  "field": "dx_code"})
    assert client.get("/audit").json()["length"] >= 1
    assert client.get("/audit/verify").json()["ok"] is True
