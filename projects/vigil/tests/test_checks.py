"""Synthetic-checks feature: the assertion engine, default-check seeding, the
"up = all required pass" rollup, and the API CRUD + run + up-definition surface.

Hermetic: the engine tests are pure (no network); the API tests drive an
in-process TestClient with the poller disabled and probe checks explicitly via a
patched HTTP runner so nothing reaches the network.
"""

import os
import tempfile

os.environ["VIGIL_DB"] = os.path.join(tempfile.mkdtemp(), "vigil-checks.db")
os.environ["VIGIL_ADMIN_EMAIL"] = "marc.bittner@gmail.com"
os.environ["VIGIL_DISABLE_POLLER"] = "1"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from vigil import auth, checks, config, probe, store  # noqa: E402
from vigil.api import app  # noqa: E402

# --------------------------------------------------------------------------- #
# Assertion engine — pure unit tests across every type                          #
# --------------------------------------------------------------------------- #

def _ev(assertions, **resp):
    resp.setdefault("status", 200)
    resp.setdefault("response_ms", 10.0)
    resp.setdefault("headers", {})
    resp.setdefault("body_text", "")
    return checks.evaluate(assertions, **resp)


def _ok(assertions, **resp):
    return _ev(assertions, **resp)["passed"]


def test_status_assertions_pass_and_fail():
    assert _ok([{"type": "status", "op": "in", "value": [200, 399]}], status=204)
    assert not _ok([{"type": "status", "op": "in", "value": [200, 399]}], status=500)
    assert _ok([{"type": "status", "op": "in", "value": [200, 201]}], status=201)
    assert not _ok([{"type": "status", "op": "in", "value": [200, 201]}], status=204)
    assert _ok([{"type": "status", "op": "eq", "value": 200}], status=200)
    assert not _ok([{"type": "status", "op": "eq", "value": 200}], status=404)
    assert _ok([{"type": "status", "op": "lt", "value": 400}], status=200)
    assert _ok([{"type": "status", "op": "gt", "value": 199}], status=200)


def test_latency_assertions():
    assert _ok([{"type": "latency_ms", "op": "lt", "value": 500}], response_ms=120.0)
    assert not _ok([{"type": "latency_ms", "op": "lt", "value": 100}], response_ms=120.0)
    assert _ok([{"type": "latency_ms", "op": "gt", "value": 100}], response_ms=120.0)


def test_body_contains_and_negate():
    body = '{"status":"ok"}'
    assert _ev([{"type": "body_contains", "value": "ok"}], body_text=body)["passed"]
    assert not _ev([{"type": "body_contains", "value": "nope"}], body_text=body)["passed"]
    assert _ev([{"type": "body_contains", "value": "down", "negate": True}],
               body_text=body)["passed"]
    assert not _ev([{"type": "body_contains", "value": "ok", "negate": True}],
                   body_text=body)["passed"]


def test_body_regex():
    assert _ev([{"type": "body_regex", "value": r"\d{3}-\d{4}"}],
               body_text="call 555-1234")["passed"]
    assert not _ev([{"type": "body_regex", "value": r"^ERROR"}],
                   body_text="all good")["passed"]


def test_json_path_ops():
    body = '{"a": {"b": [10, 20]}, "name": "vigil", "ok": true}'
    assert _ev([{"type": "json_path", "path": "name", "op": "eq", "value": "vigil"}],
               body_text=body)["passed"]
    assert _ev([{"type": "json_path", "path": "a.b.1", "op": "eq", "value": 20}],
               body_text=body)["passed"]
    assert _ev([{"type": "json_path", "path": "a.b", "op": "exists"}],
               body_text=body)["passed"]
    assert not _ev([{"type": "json_path", "path": "missing", "op": "exists"}],
                   body_text=body)["passed"]
    assert _ev([{"type": "json_path", "path": "a.b.0", "op": "lt", "value": 50}],
               body_text=body)["passed"]
    assert _ev([{"type": "json_path", "path": "a.b.0", "op": "gt", "value": 5}],
               body_text=body)["passed"]


def test_header_ops():
    h = {"Content-Type": "application/json; charset=utf-8"}
    assert _ev([{"type": "header", "name": "content-type", "op": "exists"}],
               headers=h)["passed"]
    assert _ev([{"type": "header", "name": "Content-Type", "op": "contains",
                 "value": "json"}], headers=h)["passed"]
    assert not _ev([{"type": "header", "name": "X-Nope", "op": "exists"}],
                   headers=h)["passed"]


def test_all_required_pass_means_passed():
    out = _ev([
        {"type": "status", "op": "in", "value": [200, 299]},
        {"type": "latency_ms", "op": "lt", "value": 1000},
    ], status=200, response_ms=50.0)
    assert out["passed"] is True
    assert all(r["ok"] for r in out["results"])


def test_one_failing_assertion_fails_the_set():
    out = _ev([
        {"type": "status", "op": "in", "value": [200, 299]},
        {"type": "body_contains", "value": "READY"},
    ], status=200, body_text="not ready")
    assert out["passed"] is False
    assert [r["ok"] for r in out["results"]] == [True, False]


def test_malformed_input_never_raises():
    # bad JSON body for a json_path, missing path, unknown type, junk values
    cases = [
        [{"type": "json_path", "path": "a", "op": "eq", "value": 1}],  # body not JSON
        [{"type": "json_path"}],                                       # no path
        [{"type": "bogus"}],                                           # unknown type
        [{"type": "status", "op": "eq", "value": "not-a-number"}],
        [{"type": "latency_ms", "op": "lt", "value": "x"}],
        [{"type": "header"}],                                          # no name
        ["totally-not-a-dict"],
        "not-even-a-list",
    ]
    for c in cases:
        out = checks.evaluate(c, status=200, response_ms=5.0, headers={},
                              body_text="<<<not json>>>")
        assert out["passed"] in (True, False)  # returned a verdict, did not raise


def test_empty_assertion_set_passes():
    assert _ev([])["passed"] is True


def test_validate_assertions_rejects_bad_shapes():
    va = checks.validate_assertions
    assert va([{"type": "status", "op": "in", "value": [200, 299]}]) is None
    assert va([{"type": "bogus"}]) is not None
    assert va([{"type": "body_regex", "value": "([unclosed"}]) is not None
    assert va("nope") is not None
    assert va([{"type": "json_path"}]) is not None


def test_describe_assertion_is_human_readable():
    d = checks.describe_assertion({"type": "status", "op": "in", "value": [200, 399]})
    assert "200" in d and "399" in d
    assert "latency" in checks.describe_assertion(
        {"type": "latency_ms", "op": "lt", "value": 500})


# --------------------------------------------------------------------------- #
# Store: default-check seeding + rollup via the prober                           #
# --------------------------------------------------------------------------- #

def _fresh_db():
    config.DB_PATH.unlink(missing_ok=True)
    store.init_db()


def test_default_health_check_seeded_for_every_target():
    _fresh_db()
    targets = store.list_targets()
    assert targets
    for t in targets:
        cks = store.list_checks(t.slug)
        assert cks, f"{t.slug} has no seeded check"
        health = [c for c in cks if c["name"] == "health"]
        assert health and health[0]["required"]
        # the seeded assertion preserves the old 200-399 behavior
        assert health[0]["assertions"] == [
            {"type": "status", "op": "in", "value": [200, 399]}]


def test_seeded_check_keeps_legacy_up_on_2xx(monkeypatch):
    _fresh_db()
    t = store.list_targets()[0]

    def fake_run(check, base_url, **kw):
        return {"passed": True, "http_status": 200, "response_ms": 12.3,
                "error": None, "detail": {"results": [
                    {"type": "status", "ok": True, "detail": "status 200 in 200–399"}],
                    "snippet": "ok", "url": base_url}}

    monkeypatch.setattr(checks, "run_check", fake_run)
    res = probe._probe_target_sync(t)
    assert res["up"] is True
    assert store.last_probe(t.slug)["up"] == 1


def test_required_check_failing_brings_target_down(monkeypatch):
    _fresh_db()
    t = store.list_targets()[0]
    # add a second REQUIRED check that will fail, plus a non-required failing one
    store.add_check(t.slug, "strict", "/health", required=True,
                    assertions=[{"type": "status", "op": "eq", "value": 999}])
    store.add_check(t.slug, "soft", "/health", required=False,
                    assertions=[{"type": "status", "op": "eq", "value": 999}])

    def fake_run(check, base_url, **kw):
        # 'health' (200-399) passes; 'strict' wants 999 → fails
        passed = check["name"] == "health"
        results = [{"type": "status", "ok": passed,
                    "detail": "status 200" + ("" if passed else " != 999")}]
        return {"passed": passed, "http_status": 200, "response_ms": 9.0,
                "error": None,
                "detail": {"results": results, "snippet": "", "url": base_url}}

    monkeypatch.setattr(checks, "run_check", fake_run)
    res = probe._probe_target_sync(t)
    assert res["up"] is False  # the required 'strict' check failed
    assert "strict" in (res["error"] or "")


def test_non_required_failure_does_not_bring_target_down(monkeypatch):
    _fresh_db()
    t = store.list_targets()[0]
    store.add_check(t.slug, "soft", "/health", required=False,
                    assertions=[{"type": "status", "op": "eq", "value": 999}])

    def fake_run(check, base_url, **kw):
        passed = check["required"]  # only the required 'health' passes
        return {"passed": passed, "http_status": 200, "response_ms": 9.0,
                "error": None,
                "detail": {"results": [{"type": "status", "ok": passed,
                                        "detail": ""}], "snippet": "", "url": base_url}}

    monkeypatch.setattr(checks, "run_check", fake_run)
    res = probe._probe_target_sync(t)
    assert res["up"] is True  # the only required check (health) passed


def test_run_check_transport_error_is_a_failed_check():
    # a definitely-unroutable URL; run_check must return passed=False with an error
    chk = {"method": "GET", "path": "/health",
           "assertions": [{"type": "status", "op": "in", "value": [200, 399]}]}
    r = checks.run_check(chk, "http://127.0.0.1:9")  # nothing listening
    assert r["passed"] is False and r["error"]


# --------------------------------------------------------------------------- #
# API: CRUD + run + up-definition                                               #
# --------------------------------------------------------------------------- #

@pytest.fixture()
def admin_client():
    config.DB_PATH.unlink(missing_ok=True)
    auth.signup_limiter._buckets.clear()
    with TestClient(app) as c:
        c.post("/auth/signup", json={"email": config.BOOTSTRAP_ADMIN_EMAIL,
                                     "password": "password1"})
        yield c


def _a_slug(c):
    return c.get("/api/targets").json()["targets"][0]["slug"]


def test_checks_crud_run_and_up_definition(admin_client, monkeypatch):
    c = admin_client
    slug = _a_slug(c)

    # the seeded health check is visible
    listed = c.get(f"/api/targets/{slug}/checks").json()["checks"]
    assert any(ck["name"] == "health" for ck in listed)

    # create a check
    r = c.post("/api/admin/checks", json={
        "slug": slug, "name": "json-ready", "method": "GET", "path": "/health",
        "assertions": [{"type": "json_path", "path": "status", "op": "eq",
                        "value": "ok"}],
        "required": True})
    assert r.status_code == 200
    cid = r.json()["check"]["id"]
    assert r.json()["check"]["assertions_human"]  # plain-English form present

    # malformed assertion → 422
    bad = c.post("/api/admin/checks", json={
        "slug": slug, "name": "bad", "assertions": [{"type": "nope"}]})
    assert bad.status_code == 422

    # bad method → 422
    badm = c.post("/api/admin/checks", json={
        "slug": slug, "name": "bad2", "method": "TELEPORT"})
    assert badm.status_code == 422

    # patch it (disable)
    p = c.patch(f"/api/admin/checks/{cid}", json={"enabled": False})
    assert p.status_code == 200 and p.json()["check"]["enabled"] is False

    # run it now (patched runner so no network)
    def fake_run(check, base_url, **kw):
        return {"passed": True, "http_status": 200, "response_ms": 7.0,
                "error": None, "detail": {"results": [
                    {"type": "json_path", "ok": True, "detail": "status==ok"}],
                    "snippet": '{"status":"ok"}', "url": base_url}}

    monkeypatch.setattr(checks, "run_check", fake_run)
    run = c.post(f"/api/admin/checks/{cid}/run")
    assert run.status_code == 200 and run.json()["result"]["passed"] is True

    # up-definition surfaces required checks + the supported assertion vocabulary
    ud = c.get(f"/api/targets/{slug}/up-definition").json()
    assert "required" in ud["summary"]
    assert ud["required_count"] >= 1
    assert "status" in ud["supported_assertion_types"]
    assert all("assertions_human" in chk for chk in ud["checks"])

    # delete
    d = c.delete(f"/api/admin/checks/{cid}")
    assert d.status_code == 200 and d.json()["removed"] is True


def test_check_endpoints_require_roles(admin_client):
    c = admin_client
    slug = _a_slug(c)
    c.post("/auth/logout")
    # registered-tier reads need auth
    assert c.get(f"/api/targets/{slug}/checks").status_code == 401
    assert c.get(f"/api/targets/{slug}/up-definition").status_code == 401
    # admin CRUD needs auth
    assert c.post("/api/admin/checks",
                  json={"slug": slug, "name": "x"}).status_code == 401


def test_up_definition_unknown_target_404(admin_client):
    assert admin_client.get("/api/targets/no-such/up-definition").status_code == 404
