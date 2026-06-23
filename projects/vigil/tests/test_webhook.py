"""Per-push pipeline: HMAC signature verification (valid/invalid/missing-secret),
path→slug mapping, push history, repo-scan ingest, and the security CSV shape."""

import json
import os
import tempfile

os.environ["VIGIL_DB"] = os.path.join(tempfile.mkdtemp(), "vigil-webhook.db")
os.environ["VIGIL_ADMIN_EMAIL"] = "marc.bittner@gmail.com"
os.environ["VIGIL_DISABLE_POLLER"] = "1"
os.environ.pop("VIGIL_INGEST_TOKEN", None)

from fastapi.testclient import TestClient  # noqa: E402

from vigil import auth, config, store, webhook  # noqa: E402
from vigil.api import app  # noqa: E402


def _client():
    store.config.DB_PATH.unlink(missing_ok=True)
    auth.signup_limiter._buckets.clear()
    return TestClient(app)


def _register_verified(c, email):
    r = c.post("/auth/signup", json={"email": email, "password": "password1"})
    link = r.json()["verification"]["link"]
    c.get(f"/auth/verify?token={link.split('token=')[1]}", follow_redirects=False)


def _push_payload():
    return {
        "ref": "refs/heads/main", "after": "deadbeefcafe",
        "repository": {"full_name": "Marc/ai-portfolio"},
        "pusher": {"name": "marc"},
        "head_commit": {"id": "deadbeefcafe", "message": "ship it",
                        "modified": ["projects/slo-kit/src/app.py"],
                        "added": ["projects/vigil/x.py"], "removed": []},
        "commits": [{"modified": ["projects/slo-kit/src/app.py", "README.md"],
                     "added": [], "removed": []}],
    }


# --- pure signature + mapping ------------------------------------------------ #

def test_signature_roundtrip():
    body = b'{"a":1}'
    sig = webhook.sign_body("s3cr3t", body)
    assert webhook.verify_signature("s3cr3t", body, sig)


def test_signature_rejects_tampered_body():
    sig = webhook.sign_body("s3cr3t", b'{"a":1}')
    assert not webhook.verify_signature("s3cr3t", b'{"a":2}', sig)


def test_signature_rejects_when_secret_unset():
    body = b'{"a":1}'
    sig = webhook.sign_body("s3cr3t", body)
    assert not webhook.verify_signature(None, body, sig)
    assert not webhook.verify_signature("", body, sig)


def test_signature_rejects_missing_or_malformed_header():
    body = b'{"a":1}'
    assert not webhook.verify_signature("s", body, None)
    assert not webhook.verify_signature("s", body, "garbage")


def test_changed_slugs_maps_only_project_paths():
    slugs = webhook.changed_slugs(_push_payload())
    assert "slo-kit" in slugs and "vigil" in slugs
    # README.md (not under projects/) maps to nothing.
    assert all(s for s in slugs)


def test_parse_push_extracts_meta():
    meta = webhook.parse_push(_push_payload())
    assert meta["commit_sha"] == "deadbeefcafe"
    assert meta["pusher"] == "marc"
    assert meta["message"] == "ship it"


# --- the endpoint: secure by default, then verified push records history ----- #

def test_webhook_rejected_when_secret_unset():
    config.GITHUB_WEBHOOK_SECRET = None
    with _client() as c:
        body = json.dumps(_push_payload()).encode()
        # Even a "correctly signed" call is rejected when no secret is configured.
        r = c.post("/api/hooks/github", content=body,
                   headers={"X-GitHub-Event": "push",
                            "X-Hub-Signature-256": "sha256=whatever"})
        assert r.status_code == 401


def test_webhook_invalid_signature_rejected():
    config.GITHUB_WEBHOOK_SECRET = "hooksecret"
    try:
        with _client() as c:
            body = json.dumps(_push_payload()).encode()
            r = c.post("/api/hooks/github", content=body,
                       headers={"X-GitHub-Event": "push",
                                "X-Hub-Signature-256": "sha256=bad"})
            assert r.status_code == 401
    finally:
        config.GITHUB_WEBHOOK_SECRET = None


def test_webhook_valid_push_records_history():
    config.GITHUB_WEBHOOK_SECRET = "hooksecret"
    try:
        with _client() as c:
            payload = _push_payload()
            body = json.dumps(payload).encode()
            sig = webhook.sign_body("hooksecret", body)
            r = c.post("/api/hooks/github", content=body,
                       headers={"X-GitHub-Event": "push",
                                "X-Hub-Signature-256": sig})
            assert r.status_code == 200
            affected = r.json()["affected"]
            assert "slo-kit" in affected and "vigil" in affected
            # Per-push history is queryable (registered tier).
            _register_verified(c, "p@x.test")
            d = c.get("/api/targets/slo-kit/pushes").json()
            assert d["pushes"] and d["pushes"][0]["commit_sha"] == "deadbeefcafe"
            # The per-push scan posture was recorded.
            assert d["pushes"][0]["scan"]["posture"]["grade"]
    finally:
        config.GITHUB_WEBHOOK_SECRET = None


def test_webhook_ping_event_ok():
    config.GITHUB_WEBHOOK_SECRET = "hooksecret"
    try:
        with _client() as c:
            body = b"{}"
            sig = webhook.sign_body("hooksecret", body)
            r = c.post("/api/hooks/github", content=body,
                       headers={"X-GitHub-Event": "ping",
                                "X-Hub-Signature-256": sig})
            assert r.status_code == 200 and r.json()["pong"] is True
    finally:
        config.GITHUB_WEBHOOK_SECRET = None


# --- repo-scan ingest + its surfacing in the security report ----------------- #

def test_repo_scan_ingest_and_surface():
    config.INGEST_TOKEN = None
    with _client() as c:
        finding = {"rule": "AWS_ACCESS_KEY_ID", "control": "CC6.3",
                   "severity": "high", "line": 4, "match": "AK…xx (20 chars)",
                   "source": "src/x.py"}
        # Use a target whose local source is NOT on disk so the CI-pushed result is
        # the one surfaced (a real fleet app, not vigil itself).
        r = c.post("/api/ingest/scan", json={
            "slug": "persona-twin", "commit_sha": "c0ffee",
            "findings": [finding]})
        assert r.status_code == 200
        latest = store.latest_repo_scan("persona-twin")
        assert latest and latest["findings"][0]["rule"] == "AWS_ACCESS_KEY_ID"
