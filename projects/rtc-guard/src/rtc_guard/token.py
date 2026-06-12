"""Scoped real-time access tokens — hand-rolled HS256 JWTs that mirror LiveKit's
access-token model (a signed ``video`` grant: room, join, publish/subscribe, data,
plus short TTL and a jti nonce). Stdlib only.

Minting is least-privilege by template; verification checks signature, validity
window, room scope, and (optionally) single-use replay. The adversarial suite in
``adversary.py`` proves the negative cases.
"""

import base64
import hashlib
import hmac
import json
import os
import time

SIGNING_KEY = os.environ.get("RTC_GUARD_SIGNING_KEY", "rtc-guard-demo-signing-key-v1")
DEFAULT_TTL = 300  # seconds — short-lived by default

# Least-privilege grant templates (each a subset of the video-grant capabilities).
GRANT_TEMPLATES: dict[str, dict] = {
    "viewer":     {"roomJoin": True, "canSubscribe": True, "canPublish": False,
                   "canPublishData": False},
    "publisher":  {"roomJoin": True, "canSubscribe": True, "canPublish": True,
                   "canPublishData": True},
    "agent":      {"roomJoin": True, "canSubscribe": True, "canPublish": True,
                   "canPublishData": True},
    "data_only":  {"roomJoin": True, "canSubscribe": True, "canPublish": False,
                   "canPublishData": True},
}


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign(signing_input: bytes, key: str) -> str:
    return _b64url(hmac.new(key.encode(), signing_input, hashlib.sha256).digest())


def encode(payload: dict, key: str = SIGNING_KEY) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header}.{body}".encode()
    return f"{header}.{body}.{_sign(signing_input, key)}"


def decode(token: str, key: str = SIGNING_KEY) -> dict:
    """Verify signature + structure; return claims. Raises ValueError otherwise."""
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("malformed token")
    header_b64, body_b64, sig = parts
    expected = _sign(f"{header_b64}.{body_b64}".encode(), key)
    if not hmac.compare_digest(expected, sig):
        raise ValueError("bad signature")
    return json.loads(_b64url_decode(body_b64))


def _now(now: float | None) -> float:
    return time.time() if now is None else now


_seq = 0


def mint(identity: str, room: str, template: str = "viewer", ttl: int = DEFAULT_TTL,
         key: str = SIGNING_KEY, now: float | None = None) -> str:
    if template not in GRANT_TEMPLATES:
        raise ValueError(f"unknown template; valid: {list(GRANT_TEMPLATES)}")
    global _seq
    _seq += 1
    t = _now(now)
    grant = {"room": room, **GRANT_TEMPLATES[template]}
    return encode({
        "iss": "rtc-guard", "sub": identity, "iat": int(t), "nbf": int(t),
        "exp": int(t + ttl), "jti": f"{int(t)}-{_seq:06d}", "video": grant,
    }, key)


def verify(token: str, key: str = SIGNING_KEY, expected_room: str | None = None,
           now: float | None = None, jti_store: set | None = None) -> dict:
    """Return ``{valid, reason, claims}``. Checks signature, validity window, room
    scope, and (if a jti_store is given) single-use replay."""
    try:
        claims = decode(token, key)
    except ValueError as exc:
        return {"valid": False, "reason": str(exc), "claims": None}
    t = _now(now)
    if t < claims.get("nbf", 0):
        return {"valid": False, "reason": "token not yet valid (nbf)", "claims": claims}
    if t >= claims.get("exp", 0):
        return {"valid": False, "reason": "token expired", "claims": claims}
    video = claims.get("video") or {}
    if not video.get("roomJoin"):
        return {"valid": False, "reason": "no roomJoin grant", "claims": claims}
    if expected_room is not None and video.get("room") != expected_room:
        return {"valid": False, "reason": "room scope mismatch", "claims": claims}
    if jti_store is not None:
        jti = claims.get("jti")
        if jti in jti_store:
            return {"valid": False, "reason": "token replay (jti seen)", "claims": claims}
        jti_store.add(jti)
    return {"valid": True, "reason": "ok", "claims": claims}


def can(claims: dict, capability: str) -> bool:
    """Capability check, e.g. can(claims, 'canPublish')."""
    return bool((claims.get("video") or {}).get(capability, False))
