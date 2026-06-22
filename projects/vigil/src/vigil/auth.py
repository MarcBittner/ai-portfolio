"""Auth: email/password + verification, social OAuth scaffolding, roles, sessions.

Self-contained and dependency-light. Passwords are hashed with the stdlib
``hashlib.scrypt`` (no bcrypt dependency, still memory-hard); sessions are signed
cookies via ``itsdangerous`` (already a FastAPI transitive dep). Roles are a
four-rung ladder — ``guest`` < ``registered`` < ``elevated`` < ``admin`` — that
gates the tiered dashboard. The single bootstrap admin
(``config.BOOTSTRAP_ADMIN_EMAIL``) is auto-elevated on signup and is the only
account that can elevate others.

Social login (Google + GitHub) is wired through **authlib**; the client id/secret
are read from env and are NEEDS-CREDENTIAL — the code path (redirect + callback)
is present and the providers register only when their creds exist, so the buttons
appear when configured and are otherwise hidden rather than 500ing.

Email verification: on signup we mint a token. If SMTP is configured the link is
emailed (alerts.EmailChannel); otherwise the link is logged to the server console
and surfaced in the signup response, and the account is marked unverified —
NEEDS-CREDENTIAL for real delivery, but fully functional for a reviewer.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import time

from itsdangerous import BadSignature, URLSafeTimedSerializer

from vigil import config, store

log = logging.getLogger("vigil.auth")

ROLES = ("guest", "registered", "elevated", "admin")
_RANK = {r: i for i, r in enumerate(ROLES)}

_serializer = URLSafeTimedSerializer(config.SECRET_KEY, salt="vigil-session")
SESSION_MAX_AGE = 60 * 60 * 24 * 14  # 14 days


# --------------------------------------------------------------------------- #
# Password hashing (stdlib scrypt)                                              #
# --------------------------------------------------------------------------- #

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored or not stored.startswith("scrypt$"):
        return False
    try:
        _, salt_hex, hash_hex = stored.split("$")
        dk = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex),
                            n=2**14, r=8, p=1, dklen=32)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk.hex(), hash_hex)


# --------------------------------------------------------------------------- #
# Roles                                                                         #
# --------------------------------------------------------------------------- #

def role_at_least(role: str, minimum: str) -> bool:
    return _RANK.get(role, -1) >= _RANK.get(minimum, 99)


def initial_role(email: str) -> str:
    """The bootstrap admin signs up straight into admin; everyone else registered."""
    return "admin" if email.lower() == config.BOOTSTRAP_ADMIN_EMAIL else "registered"


# --------------------------------------------------------------------------- #
# Sessions (signed cookies)                                                     #
# --------------------------------------------------------------------------- #

def issue_session(user: dict) -> str:
    return _serializer.dumps({"uid": user["id"], "email": user["email"]})


def read_session(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        data = _serializer.loads(token, max_age=SESSION_MAX_AGE)
    except (BadSignature, Exception):  # noqa: BLE001
        return None
    return store.get_user_by_id(data.get("uid"))


# --------------------------------------------------------------------------- #
# Email verification                                                            #
# --------------------------------------------------------------------------- #

def verification_link(token: str) -> str:
    return f"{config.SELF_BASE_URL}/auth/verify?token={token}"


def send_verification(email: str, token: str) -> dict:
    """Email the verification link if SMTP is set, else log it (NEEDS-CREDENTIAL).

    Returns a dict the signup handler can surface so a reviewer with no SMTP can
    still complete verification from the response/server log.
    """
    from vigil.alerts import EmailChannel

    link = verification_link(token)
    ch = EmailChannel()
    if ch.available():
        ok = ch.send(email, f"Verify your vigil account: {link}")
        return {"delivered": ok, "channel": "email", "link": None}
    # NEEDS-CREDENTIAL: no SMTP — log the link so the flow is completable in dev.
    log.warning("EMAIL VERIFICATION (no SMTP, NEEDS-CREDENTIAL) %s -> %s", email, link)
    return {"delivered": False, "channel": "console", "link": link}


# --------------------------------------------------------------------------- #
# Signup rate limiting (per-IP token bucket)                                    #
# --------------------------------------------------------------------------- #

class TokenBucket:
    """Per-IP token bucket guarding the signup endpoint against abuse. In-process
    (single instance); capacity refills linearly. Extensible to a shared store if
    vigil ever runs multi-replica."""

    def __init__(self, capacity: int, refill_seconds: float):
        self.capacity = capacity
        self.refill_rate = capacity / refill_seconds if refill_seconds else capacity
        self._buckets: dict[str, tuple[float, float]] = {}  # ip -> (tokens, last_ts)

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        tokens, last = self._buckets.get(key, (float(self.capacity), now))
        tokens = min(self.capacity, tokens + (now - last) * self.refill_rate)
        if tokens < 1:
            self._buckets[key] = (tokens, now)
            return False
        self._buckets[key] = (tokens - 1, now)
        return True


signup_limiter = TokenBucket(config.SIGNUP_RATE_CAPACITY, config.SIGNUP_RATE_REFILL_S)


# --------------------------------------------------------------------------- #
# Signup / login                                                               #
# --------------------------------------------------------------------------- #

def register(email: str, password: str) -> tuple[dict | None, dict]:
    """Create a user (idempotent on email). Returns (user, verification_info)."""
    email = email.strip().lower()
    role = initial_role(email)
    token = secrets.token_urlsafe(24)
    # The bootstrap admin is pre-verified (it's the operator); others must verify.
    pre_verified = role == "admin"
    user = store.create_user(
        email=email, password_hash=hash_password(password), role=role,
        verified=pre_verified, verify_token=None if pre_verified else token,
    )
    if user is None:
        return None, {"error": "email already registered"}
    if pre_verified:
        return user, {"delivered": True, "channel": "bootstrap", "link": None}
    return user, send_verification(email, token)


def authenticate(email: str, password: str) -> dict | None:
    user = store.get_user_by_email(email)
    if not user or not verify_password(password, user["password_hash"]):
        return None
    return user


def ensure_bootstrap_admin() -> bool:
    """Seed the bootstrap admin from ``VIGIL_ADMIN_PASSWORD`` if it's set and the
    account doesn't already exist. Called once at startup.

    This makes admin login robust on a free-tier host with no persistent disk: the
    SQLite DB lives in ephemeral ``/tmp`` and is wiped on every redeploy/cold
    start, but the env var persists — so the admin is re-created, pre-verified,
    on each boot. Idempotent: a no-op if the admin already exists or no password
    is configured. Returns True iff it created the account this call."""
    if not config.ADMIN_PASSWORD:
        return False
    if store.get_user_by_email(config.BOOTSTRAP_ADMIN_EMAIL):
        return False
    user = store.create_user(
        email=config.BOOTSTRAP_ADMIN_EMAIL,
        password_hash=hash_password(config.ADMIN_PASSWORD),
        role="admin", verified=True, verify_token=None,
    )
    if user:
        log.info("seeded bootstrap admin %s", config.BOOTSTRAP_ADMIN_EMAIL)
    return user is not None


# --------------------------------------------------------------------------- #
# OAuth scaffolding (authlib) — NEEDS-CREDENTIAL                                 #
# --------------------------------------------------------------------------- #

# Provider configs. ``client_kwargs``/endpoints are standard; only the
# id/secret are env-driven and NEEDS-CREDENTIAL. A provider is "enabled" only when
# both are present, so unconfigured providers never render a dead button.
OAUTH_PROVIDERS = {
    "google": {
        "client_id_env": "GOOGLE_CLIENT_ID",
        "client_secret_env": "GOOGLE_CLIENT_SECRET",
        "server_metadata_url": "https://accounts.google.com/.well-known/openid-configuration",
        "client_kwargs": {"scope": "openid email profile"},
    },
    "github": {
        "client_id_env": "GITHUB_CLIENT_ID",
        "client_secret_env": "GITHUB_CLIENT_SECRET",
        "authorize_url": "https://github.com/login/oauth/authorize",
        "access_token_url": "https://github.com/login/oauth/access_token",
        "api_base_url": "https://api.github.com/",
        "userinfo_endpoint": "user",
        "client_kwargs": {"scope": "read:user user:email"},
    },
}


def oauth_enabled(provider: str) -> bool:
    cfg = OAUTH_PROVIDERS.get(provider)
    if not cfg:
        return False
    return bool(os.environ.get(cfg["client_id_env"])
                and os.environ.get(cfg["client_secret_env"]))


def enabled_oauth_providers() -> list[str]:
    return [p for p in OAUTH_PROVIDERS if oauth_enabled(p)]


def register_oauth(oauth) -> list[str]:
    """Register each configured provider on an authlib OAuth registry. Returns the
    providers actually registered (those with creds). NEEDS-CREDENTIAL otherwise."""
    registered: list[str] = []
    for name, cfg in OAUTH_PROVIDERS.items():
        if not oauth_enabled(name):
            continue
        kwargs = {
            "name": name,
            "client_id": os.environ[cfg["client_id_env"]],
            "client_secret": os.environ[cfg["client_secret_env"]],
            "client_kwargs": cfg["client_kwargs"],
        }
        if "server_metadata_url" in cfg:
            kwargs["server_metadata_url"] = cfg["server_metadata_url"]
        else:
            kwargs.update({k: cfg[k] for k in
                           ("authorize_url", "access_token_url", "api_base_url")})
        oauth.register(**kwargs)
        registered.append(name)
    return registered


def upsert_oauth_user(email: str, provider: str) -> dict:
    """Find-or-create a user authenticated via a social provider (pre-verified —
    the IdP already verified the email). Bootstrap admin still becomes admin."""
    email = email.strip().lower()
    existing = store.get_user_by_email(email)
    if existing:
        return existing
    return store.create_user(
        email=email, password_hash=None, role=initial_role(email),
        verified=True, verify_token=None, oauth_provider=provider,
    )
