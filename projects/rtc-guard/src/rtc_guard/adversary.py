"""Adversarial suite — try to break the tokens, prove each attack is blocked.

Each check constructs a concrete attack against the token service and asserts the
defense holds. This is the "breaker" half of the role: not "we issue tokens" but
"here is everything I tried to forge/replay/escalate, and why it failed."
"""

import json

from rtc_guard import token as tk

_T0 = 1_000_000.0  # fixed clock for reproducible checks


def _tamper_escalate(jwt: str) -> str:
    """Attacker flips a grant in the payload but keeps the original signature."""
    h, b, s = jwt.split(".")
    payload = json.loads(tk._b64url_decode(b))
    payload["video"]["canPublish"] = True          # privilege escalation attempt
    nb = tk._b64url(json.dumps(payload, separators=(",", ":")).encode())
    return f"{h}.{nb}.{s}"


def _alg_none(jwt: str) -> str:
    """Attacker swaps the header to alg=none and drops the signature."""
    _, b, _ = jwt.split(".")
    h = tk._b64url(json.dumps({"alg": "none", "typ": "JWT"}).encode())
    return f"{h}.{b}."


def _checks() -> list[dict]:
    out: list[dict] = []

    def add(attack, blocked, detail):
        out.append({"attack": attack, "blocked": blocked, "detail": detail})

    # 1. expired token
    expired = tk.mint("eve", "room-a", "viewer", ttl=300, now=_T0)
    v = tk.verify(expired, now=_T0 + 600)
    add("expired token reused", not v["valid"], v["reason"])

    # 2. not-yet-valid (nbf in the future)
    future = tk.mint("eve", "room-a", "viewer", ttl=300, now=_T0 + 5000)
    v = tk.verify(future, now=_T0)
    add("token used before nbf", not v["valid"], v["reason"])

    # 3. tampered payload (privilege escalation, original signature)
    good = tk.mint("eve", "room-a", "viewer", ttl=300, now=_T0)
    v = tk.verify(_tamper_escalate(good), now=_T0 + 1)
    add("payload tampered to escalate", not v["valid"], v["reason"])

    # 4. forged signature (signed with the attacker's key)
    payload = tk.decode(good)
    forged = tk.encode(payload, key="attacker-controlled-key")
    v = tk.verify(forged, now=_T0 + 1)
    add("forged signature (wrong key)", not v["valid"], v["reason"])

    # 5. alg=none downgrade
    v = tk.verify(_alg_none(good), now=_T0 + 1)
    add("alg=none signature strip", not v["valid"], v["reason"])

    # 6. wrong-room (token for room-a presented to room-b)
    v = tk.verify(good, expected_room="room-b", now=_T0 + 1)
    add("token replayed into another room", not v["valid"], v["reason"])

    # 7. single-use replay
    seen: set = set()
    once = tk.mint("eve", "room-a", "viewer", ttl=300, now=_T0)
    first = tk.verify(once, now=_T0 + 1, jti_store=seen)
    second = tk.verify(once, now=_T0 + 2, jti_store=seen)
    add("single-use token replayed", first["valid"] and not second["valid"],
        second["reason"])

    # 8. capability confinement (a viewer cannot publish)
    claims = tk.decode(tk.mint("eve", "room-a", "viewer", now=_T0))
    add("viewer attempts to publish", not tk.can(claims, "canPublish"),
        "viewer grant has canPublish=false")

    return out


def run() -> dict:
    checks = _checks()
    blocked = sum(1 for c in checks if c["blocked"])
    return {
        "checks": checks,
        "total": len(checks),
        "blocked": blocked,
        "block_rate": round(blocked / len(checks), 4) if checks else 0.0,
    }
