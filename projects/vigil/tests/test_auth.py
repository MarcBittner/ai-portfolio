"""Auth: password hashing, roles, sessions, the bootstrap admin, rate limiting."""

import os
import tempfile

os.environ["VIGIL_DB"] = os.path.join(tempfile.mkdtemp(), "vigil-auth.db")

from vigil import auth, config, store  # noqa: E402


def _fresh():
    store.config.DB_PATH.unlink(missing_ok=True)
    store.init_db()


def test_password_hash_roundtrip():
    h = auth.hash_password("correct horse battery staple")
    assert auth.verify_password("correct horse battery staple", h)
    assert not auth.verify_password("wrong", h)


def test_role_ladder():
    assert auth.role_at_least("admin", "elevated")
    assert auth.role_at_least("elevated", "registered")
    assert not auth.role_at_least("registered", "elevated")
    assert not auth.role_at_least("guest", "registered")


def test_bootstrap_admin_only():
    assert auth.initial_role(config.BOOTSTRAP_ADMIN_EMAIL) == "admin"
    assert auth.initial_role("someone@example.com") == "registered"


def test_register_admin_is_preverified():
    _fresh()
    user, info = auth.register(config.BOOTSTRAP_ADMIN_EMAIL, "password123")
    assert user["role"] == "admin"
    assert user["verified"] == 1
    assert info["channel"] == "bootstrap"


def test_register_normal_user_needs_verification():
    _fresh()
    user, info = auth.register("alice@example.com", "password123")
    assert user["role"] == "registered"
    assert user["verified"] == 0
    # No SMTP in tests → link is surfaced (NEEDS-CREDENTIAL path), not silently dropped
    assert info["link"] and "/auth/verify?token=" in info["link"]


def test_duplicate_email_rejected():
    _fresh()
    auth.register("alice@example.com", "password123")
    user, info = auth.register("alice@example.com", "password123")
    assert user is None and "error" in info


def test_session_roundtrip():
    _fresh()
    user, _ = auth.register("bob@example.com", "password123")
    token = auth.issue_session(user)
    back = auth.read_session(token)
    assert back and back["email"] == "bob@example.com"
    assert auth.read_session("garbage") is None


def test_signup_rate_limit_bucket():
    bucket = auth.TokenBucket(capacity=3, refill_seconds=1000)
    assert all(bucket.allow("1.2.3.4") for _ in range(3))
    assert not bucket.allow("1.2.3.4")  # 4th from same IP blocked
    assert bucket.allow("5.6.7.8")      # different IP unaffected


def test_admin_can_elevate():
    _fresh()
    auth.register("carol@example.com", "password123")
    updated = store.set_user_role("carol@example.com", "elevated")
    assert updated["role"] == "elevated"


def test_oauth_disabled_without_creds():
    # no GOOGLE_CLIENT_ID set in the test env
    assert not auth.oauth_enabled("google")
    assert auth.enabled_oauth_providers() == []
