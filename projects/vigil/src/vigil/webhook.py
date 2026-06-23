"""GitHub webhook handling: signature verification + push → per-target mapping.

The receiver (``POST /api/hooks/github`` in ``api.py``) delegates the security- and
parsing-sensitive logic here so it's pure and unit-testable:

- ``verify_signature(secret, body, header)`` — constant-time HMAC-SHA256 check of
  the ``X-Hub-Signature-256`` header against the raw request body. **Secure by
  default**: with no configured secret the receiver rejects the call entirely
  (a missing secret can't authenticate a payload), so this only ever returns True
  for a genuinely-signed request.
- ``changed_slugs(payload)`` — extract every changed file path across the push's
  commits and map any under ``projects/<slug>/`` to that target slug.
- ``parse_push(payload)`` — pull the repo, head commit sha, pusher, and message.

Nothing here touches the network or the DB; the endpoint wires the results into
``store.record_push`` + the live security scan.
"""

from __future__ import annotations

import hashlib
import hmac

# Changed paths under this prefix map to a monitored target by their next segment.
_PROJECT_PREFIX = "projects/"


def sign_body(secret: str, body: bytes) -> str:
    """Compute the ``sha256=…`` signature GitHub sends for ``body`` under ``secret``.
    Exposed so tests (and a local sender) can produce a valid header."""
    mac = hmac.new(secret.encode(), body, hashlib.sha256)
    return "sha256=" + mac.hexdigest()


def verify_signature(secret: str | None, body: bytes, header: str | None) -> bool:
    """Constant-time verify of ``X-Hub-Signature-256``. Returns False when the
    secret is unset (secure default — reject unverifiable calls), when the header is
    missing/malformed, or when the digest doesn't match."""
    if not secret:
        return False
    if not header or not header.startswith("sha256="):
        return False
    expected = sign_body(secret, body)
    return hmac.compare_digest(expected, header)


def changed_slugs(payload: dict) -> list[str]:
    """Every target slug whose ``projects/<slug>/…`` source changed in this push.

    Aggregates added/modified/removed paths across all commits in the payload (and
    the head_commit if present), de-duplicated, order-stable."""
    paths: set[str] = set()
    commits = list(payload.get("commits") or [])
    head = payload.get("head_commit")
    if isinstance(head, dict):
        commits.append(head)
    for commit in commits:
        if not isinstance(commit, dict):
            continue
        for key in ("added", "modified", "removed"):
            for p in commit.get(key) or []:
                if isinstance(p, str):
                    paths.add(p)
    slugs: list[str] = []
    seen: set[str] = set()
    for p in sorted(paths):
        slug = _path_to_slug(p)
        if slug and slug not in seen:
            seen.add(slug)
            slugs.append(slug)
    return slugs


def _path_to_slug(path: str) -> str | None:
    """``projects/foo/src/x.py`` → ``foo``; anything outside projects/ → None."""
    if not path.startswith(_PROJECT_PREFIX):
        return None
    rest = path[len(_PROJECT_PREFIX):]
    seg = rest.split("/", 1)[0]
    return seg or None


def parse_push(payload: dict) -> dict:
    """Pull the fields the push pipeline records: repo, commit sha, pusher, message."""
    head = payload.get("head_commit") or {}
    repo = (payload.get("repository") or {}).get("full_name")
    pusher = (payload.get("pusher") or {}).get("name") \
        or (payload.get("sender") or {}).get("login")
    sha = payload.get("after") or (head.get("id") if isinstance(head, dict) else None)
    message = head.get("message") if isinstance(head, dict) else None
    return {"repo": repo, "commit_sha": sha, "pusher": pusher, "message": message,
            "ref": payload.get("ref")}
