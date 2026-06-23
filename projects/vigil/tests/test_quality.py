"""Code-quality: grade derivation (vigil decides), ingest+viewer, role-gating."""

import os
import tempfile

os.environ["VIGIL_DB"] = os.path.join(tempfile.mkdtemp(), "vigil-quality.db")
os.environ["VIGIL_ADMIN_EMAIL"] = "marc.bittner@gmail.com"
os.environ["VIGIL_DISABLE_POLLER"] = "1"
os.environ.pop("VIGIL_INGEST_TOKEN", None)

from fastapi.testclient import TestClient  # noqa: E402

from vigil import auth, config, quality, store  # noqa: E402
from vigil.api import app  # noqa: E402


def _client():
    store.config.DB_PATH.unlink(missing_ok=True)
    auth.signup_limiter._buckets.clear()
    return TestClient(app)


def _register_verified(c, email):
    r = c.post("/auth/signup", json={"email": email, "password": "password1"})
    link = r.json()["verification"]["link"]
    c.get(f"/auth/verify?token={link.split('token=')[1]}", follow_redirects=False)


# --- grade derivation (deterministic; vigil decides, not the caller) --------- #

def test_clean_run_is_an_A():
    assert quality.derive_grade(lint_errors=0, tests_passed=50, tests_failed=0,
                                coverage_pct=95) == "A"


def test_failing_tests_dominate_the_grade():
    g = quality.derive_grade(lint_errors=0, tests_passed=10, tests_failed=5,
                             coverage_pct=100)
    assert g in ("D", "F")  # five failing tests sinks it regardless of coverage


def test_lint_errors_lower_the_grade_but_are_capped():
    # A pile of lint with passing tests is bad but not an automatic F (lint cap).
    g = quality.derive_grade(lint_errors=100, tests_passed=10, tests_failed=0)
    assert g in ("C", "D")


def test_low_coverage_nudges_down():
    hi = quality.derive_grade(lint_errors=0, tests_passed=10, tests_failed=0,
                              coverage_pct=95)
    lo = quality.derive_grade(lint_errors=0, tests_passed=10, tests_failed=0,
                              coverage_pct=30)
    assert quality.grade_score(lint_errors=0, tests_passed=10, tests_failed=0,
                               coverage_pct=95) >= \
        quality.grade_score(lint_errors=0, tests_passed=10, tests_failed=0,
                            coverage_pct=30)
    assert hi == "A" and lo in ("A", "B", "C")


def test_score_is_clamped_to_0_100():
    s = quality.grade_score(lint_errors=9999, tests_passed=0, tests_failed=9999)
    assert 0.0 <= s <= 100.0


# --- ingest endpoint: vigil derives the grade, ignores any caller-supplied ---- #

def test_quality_ingest_derives_grade_in_code():
    config.INGEST_TOKEN = None
    with _client() as c:
        r = c.post("/api/ingest/quality", json={
            "slug": "slo-kit", "commit_sha": "abc1234",
            "lint_errors": 0, "tests_passed": 20, "tests_failed": 0,
            "coverage_pct": 92})
        assert r.status_code == 200
        body = r.json()
        assert body["grade"] == "A"           # derived, not supplied
        assert body["quality"]["grade"] == "A"


def test_quality_ingest_unknown_target_404():
    config.INGEST_TOKEN = None
    with _client() as c:
        assert c.post("/api/ingest/quality", json={
            "slug": "nope", "lint_errors": 0, "tests_passed": 1,
            "tests_failed": 0}).status_code == 404


def test_quality_ingest_token_gated_when_configured():
    config.INGEST_TOKEN = "q-token"
    try:
        with _client() as c:
            assert c.post("/api/ingest/quality", json={
                "slug": "slo-kit", "lint_errors": 0, "tests_passed": 1,
                "tests_failed": 0}).status_code == 401
            ok = c.post("/api/ingest/quality",
                        headers={"X-Ingest-Token": "q-token"},
                        json={"slug": "slo-kit", "lint_errors": 0,
                              "tests_passed": 1, "tests_failed": 0})
            assert ok.status_code == 200
    finally:
        config.INGEST_TOKEN = None


# --- viewer: role-gated + returns latest + trend ----------------------------- #

def test_quality_viewer_role_gated_and_shows_trend():
    config.INGEST_TOKEN = None
    with _client() as c:
        for failed in (0, 3, 0):
            c.post("/api/ingest/quality", json={
                "slug": "slo-kit", "lint_errors": 0, "tests_passed": 10,
                "tests_failed": failed})
        # Guest blocked server-side.
        assert c.get("/api/targets/slo-kit/quality").status_code == 401
        _register_verified(c, "q@x.test")
        d = c.get("/api/targets/slo-kit/quality").json()
        assert d["has_quality"] and d["latest"] is not None
        assert len(d["trend"]) == 3


def test_quality_prunes(monkeypatch):
    store.config.DB_PATH.unlink(missing_ok=True)
    store.init_db()
    monkeypatch.setattr(config, "MAX_QUALITY_PER_TARGET", 4)
    for i in range(10):
        store.add_quality("slo-kit", commit_sha=f"c{i}", lint_errors=0,
                          tests_passed=1, tests_failed=0, coverage_pct=None,
                          complexity=None, grade="A", raw=None)
    assert len(store.list_quality("slo-kit", limit=100)) == 4
