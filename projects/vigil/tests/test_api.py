"""API tier enforcement + auth flow, in-process via FastAPI TestClient."""

import os
import tempfile

os.environ["VIGIL_DB"] = os.path.join(tempfile.mkdtemp(), "vigil-api.db")
os.environ["VIGIL_ADMIN_EMAIL"] = "marc.bittner@gmail.com"
# In-process tests drive probes explicitly; skip the background poller so repeated
# TestClient lifespans don't bind a probe task to a torn-down event loop.
os.environ["VIGIL_DISABLE_POLLER"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

from vigil import auth, config, store  # noqa: E402
from vigil.api import app  # noqa: E402

# The poller starts on the lifespan event; TestClient(app) triggers startup so the
# DB is initialized + seeded. We use a context manager to get the lifecycle.


def _client():
    store.config.DB_PATH.unlink(missing_ok=True)
    # TestClient shares one synthetic IP, so the per-IP signup bucket is a
    # cross-test singleton — reset it per client so unrelated tests don't 429.
    auth.signup_limiter._buckets.clear()
    return TestClient(app)


def test_health_public_and_secret_free():
    with _client() as c:
        b = c.get("/health").json()
        assert b["status"] == "ok" and b["targets"] > 0
        blob = str(b).lower()
        for tok in ("password", "secret", "api_key", "sk-"):
            assert tok not in blob


def test_guest_status_is_minimal():
    with _client() as c:
        rows = c.get("/api/status").json()["apps"]
        assert rows
        for r in rows:
            assert set(r) == {"slug", "name", "status", "error_rate", "self_monitor"}


def test_registered_endpoints_require_auth():
    with _client() as c:
        assert c.get("/api/dashboard").status_code == 401
        assert c.get("/api/security").status_code == 401
        assert c.post("/api/admin/probe-now").status_code == 401


def test_signup_login_and_tier_gating():
    with _client() as c:
        # a normal user: signs up (unverified), can't log in until verified
        r = c.post("/auth/signup", json={"email": "u@x.test", "password": "password1"})
        assert r.status_code == 200
        info = r.json()
        assert info["verified"] is False
        link = info["verification"]["link"]
        assert link  # NEEDS-CREDENTIAL path surfaces the link
        # login blocked pre-verification
        assert c.post("/auth/login",
                      json={"email": "u@x.test", "password": "password1"}
                      ).status_code == 403
        # verify via the emitted token, then registered tier opens
        token = link.split("token=")[1]
        c.get(f"/auth/verify?token={token}", follow_redirects=False)
        assert c.get("/api/dashboard").status_code == 200
        # but elevated tier (security) is still forbidden for a registered user
        assert c.get("/api/security").status_code == 403


def test_bootstrap_admin_can_elevate_and_add_target():
    with _client() as c:
        r = c.post("/auth/signup",
                   json={"email": config.BOOTSTRAP_ADMIN_EMAIL, "password": "password1"})
        assert r.json()["role"] == "admin"
        # admin reaches elevated + admin surfaces
        assert c.get("/api/security").status_code == 200
        # add a brand-new target via the admin API (extensibility requirement)
        add = c.post("/api/admin/targets",
                     json={"slug": "demo-new", "name": "Demo New",
                           "url": "https://demo-new.test"})
        assert add.status_code == 200
        assert any(t["slug"] == "demo-new"
                   for t in c.get("/api/targets").json()["targets"])
        # elevate another user
        c.post("/auth/signup", json={"email": "e@x.test", "password": "password1"})
        up = c.post("/api/admin/role", json={"email": "e@x.test", "role": "elevated"})
        assert up.json()["role"] == "elevated"


def test_signup_rate_limited():
    with _client() as c:
        # capacity defaults to 5 per IP; the 6th should 429
        codes = []
        for i in range(config.SIGNUP_RATE_CAPACITY + 2):
            codes.append(c.post("/auth/signup",
                                json={"email": f"r{i}@x.test", "password": "password1"}
                                ).status_code)
        assert 429 in codes


def test_incident_summary_requires_auth_then_works():
    with _client() as c:
        assert c.post("/api/incident/summary").status_code == 401
        c.post("/auth/signup",
               json={"email": config.BOOTSTRAP_ADMIN_EMAIL, "password": "password1"})
        out = c.post("/api/incident/summary", json={"mode": "offline"}).json()
        assert "severity" in out and out["provider"] == "offline"
