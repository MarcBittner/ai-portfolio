"""Real repo secret scan wiring (local source + CI push) and the CSV export shape."""

import csv
import io
import os
import tempfile

os.environ["VIGIL_DB"] = os.path.join(tempfile.mkdtemp(), "vigil-seccsv.db")
os.environ["VIGIL_ADMIN_EMAIL"] = "marc.bittner@gmail.com"
os.environ["VIGIL_DISABLE_POLLER"] = "1"
os.environ.pop("VIGIL_INGEST_TOKEN", None)

from fastapi.testclient import TestClient  # noqa: E402

from vigil import auth, config, security, store  # noqa: E402
from vigil.api import app  # noqa: E402
from vigil.config import Target  # noqa: E402


def _client():
    store.config.DB_PATH.unlink(missing_ok=True)
    auth.signup_limiter._buckets.clear()
    return TestClient(app)


def _admin(c):
    c.post("/auth/signup",
           json={"email": config.BOOTSTRAP_ADMIN_EMAIL, "password": "password1"})


# --- repo scan: local source path vs CI-push path vs not_run ----------------- #

def test_scan_repo_uses_local_source_for_vigil():
    """vigil's own tree is on disk in-repo, so its repo scan runs (status scanned)
    and is clean (its scanner must not flag itself)."""
    store.config.DB_PATH.unlink(missing_ok=True)
    store.init_db()
    t = store.get_target("vigil")
    rep = security.scan_repo(t)
    assert rep["status"] == "scanned" and rep["source"] == "local"
    assert rep["finding_count"] == 0


def test_scan_repo_not_run_without_source_or_push():
    rep = security.scan_repo(Target(slug="ghost", name="g", url="https://g.test"))
    assert rep["status"] == "not_run"
    assert rep["ruleset"]  # the ruleset it *would* apply is still exposed


def test_pushed_scan_surfaces_for_fleet_target():
    """The CI-push path is what the public fleet uses (no local checkout). Use a
    slug with NO sibling project dir so local source can't pre-empt the pushed
    result (every seed slug has a dir in this monorepo)."""
    store.config.DB_PATH.unlink(missing_ok=True)
    store.init_db()
    store.add_target(Target(slug="ci-only-demo", name="CI Only",
                            url="https://ci-only-demo.test"))
    assert security.local_source_root("ci-only-demo") is None
    store.record_repo_scan("ci-only-demo", "c0ffee", [
        {"rule": "OPENAI_API_KEY", "control": "CC6.3", "severity": "high",
         "line": 7, "match": "sk…xx (24 chars)", "source": "app.py"}])
    rep = security.scan_repo(store.get_target("ci-only-demo"))
    assert rep["status"] == "scanned" and rep["source"] == "ci"
    # And it folds into the posture findings mapped to CC6.3.
    report = security.scan_target("ci-only-demo", include_repo=True)
    secret_findings = [f for f in report["findings"] if f["surface"] == "repo"]
    assert secret_findings and "CC6.3" in secret_findings[0]["control_ids"]


# --- CSV export shape + gating ----------------------------------------------- #

_EXPECTED_COLS = ["slug", "finding", "severity", "control_id", "framework",
                  "framework_control", "status"]


def _register_verified(c, email):
    r = c.post("/auth/signup", json={"email": email, "password": "password1"})
    link = r.json()["verification"]["link"]
    c.get(f"/auth/verify?token={link.split('token=')[1]}", follow_redirects=False)


def test_csv_export_requires_elevated():
    with _client() as c:
        # guest → 401
        assert c.get("/api/security/export.csv").status_code == 401
        # registered (not elevated) → 403
        _register_verified(c, "r@x.test")
        assert c.get("/api/security/export.csv").status_code == 403
        assert c.get("/api/security/persona-twin/export.csv").status_code == 403


def test_csv_export_shape_and_headers():
    with _client() as c:
        _admin(c)
        # Seed a known finding via a CI-pushed secret on a CI-only fleet target
        # (no local dir, so the pushed scan is the one surfaced).
        store.add_target(Target(slug="ci-only-csv", name="CI CSV",
                                url="https://ci-only-csv.test"))
        store.record_repo_scan("ci-only-csv", "abc", [
            {"rule": "AWS_ACCESS_KEY_ID", "control": "CC6.3", "severity": "high",
             "line": 1, "match": "AK…xx", "source": "x.py"}])
        r = c.get("/api/security/ci-only-csv/export.csv")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/csv")
        assert "attachment" in r.headers["content-disposition"]
        rows = list(csv.DictReader(io.StringIO(r.text)))
        assert rows, "CSV should have at least one finding row"
        assert list(rows[0].keys()) == _EXPECTED_COLS
        # Every row is a failing control, mapped to a framework.
        for row in rows:
            assert row["status"] == "fail"
            assert row["framework"] and row["control_id"]


def test_fleet_csv_export_runs():
    with _client() as c:
        _admin(c)
        r = c.get("/api/security/export.csv")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/csv")
        # Header row at minimum.
        assert r.text.splitlines()[0] == ",".join(_EXPECTED_COLS)
