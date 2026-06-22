"""Runtime configuration: paths, knobs, and the seed monitored-app registry.

Everything tunable lives here or in an env var, so adding a target or changing a
poll interval never touches code that *uses* the config. The seed registry below
is the ai-portfolio fleet (the live demos in the repo README) **plus vigil
itself** — vigil is a first-class entry in its own dashboard. Targets can also be
added at runtime via the admin API (``store.add_target``) or by dropping a
``targets.json`` file next to the database; both merge over this seed, so
extensibility is a config concern, never a code change.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

# --------------------------------------------------------------------------- #
# Paths & operational knobs                                                    #
# --------------------------------------------------------------------------- #

# On Render's free tier only /tmp is reliably writable across the image, so the
# DB defaults there; override with VIGIL_DB for a persistent disk.
DB_PATH = Path(os.environ.get("VIGIL_DB", "/tmp/vigil.db"))
TARGETS_FILE = Path(
    os.environ.get("VIGIL_TARGETS_FILE", str(DB_PATH.parent / "targets.json"))
)

POLL_INTERVAL_S = float(os.environ.get("VIGIL_POLL_INTERVAL", "60"))
PROBE_TIMEOUT_S = float(os.environ.get("VIGIL_PROBE_TIMEOUT", "8"))
# Rolling window (number of recent probes) used for availability + error rate.
ROLLING_WINDOW = int(os.environ.get("VIGIL_ROLLING_WINDOW", "50"))
# Retain at most this many probe rows per target (cheap self-pruning time series).
MAX_HISTORY_PER_TARGET = int(os.environ.get("VIGIL_MAX_HISTORY", "1000"))

# The single bootstrap admin. Hardcoded by design: this account is auto-elevated
# to `admin` on signup and can elevate other users. Everyone else signs up as
# `registered` and is promoted only by an admin.
BOOTSTRAP_ADMIN_EMAIL = os.environ.get(
    "VIGIL_ADMIN_EMAIL", "marc.bittner@gmail.com"
).lower()

# Optional admin password, seeded on startup so the bootstrap admin can log in
# without first signing up — and, crucially, so the admin survives the free-tier
# ephemeral filesystem (the SQLite DB at /tmp is wiped on every redeploy/cold
# start; this env var persists, so the admin is re-seeded fresh on each boot).
# NEEDS-CREDENTIAL: unset → no auto-seed (admin must sign up manually).
ADMIN_PASSWORD = os.environ.get("VIGIL_ADMIN_PASSWORD") or None

# Session signing secret. NEEDS-CREDENTIAL for production: set VIGIL_SECRET to a
# strong random value so sessions survive restarts and can't be forged. The dev
# default is fine for a local demo but is intentionally obvious.
SECRET_KEY = os.environ.get("VIGIL_SECRET", "dev-insecure-change-me")

# Public base URL of this vigil instance (used for self-monitoring + email links).
SELF_BASE_URL = os.environ.get("VIGIL_SELF_URL", "http://127.0.0.1:8020").rstrip("/")

# Signup rate limit: a per-IP token bucket (capacity / refill-per-second).
SIGNUP_RATE_CAPACITY = int(os.environ.get("VIGIL_SIGNUP_CAPACITY", "5"))
SIGNUP_RATE_REFILL_S = float(os.environ.get("VIGIL_SIGNUP_REFILL", "60"))


# --------------------------------------------------------------------------- #
# Target model + seed registry                                                 #
# --------------------------------------------------------------------------- #

@dataclass
class Target:
    """One monitored app. ``slug`` is the stable key; ``repo`` (optional) lets the
    security scanner reason about the source surface, ``self_monitor`` flags the
    vigil-watches-vigil entry."""

    slug: str
    name: str
    url: str
    health_path: str = "/health"
    repo: str | None = None
    self_monitor: bool = False
    tags: list[str] = field(default_factory=list)

    @property
    def health_url(self) -> str:
        return self.url.rstrip("/") + "/" + self.health_path.lstrip("/")

    def to_dict(self) -> dict:
        return {
            "slug": self.slug, "name": self.name, "url": self.url,
            "health_path": self.health_path, "repo": self.repo,
            "self_monitor": self.self_monitor, "tags": list(self.tags),
            "health_url": self.health_url,
        }


_REPO_BASE = "https://github.com/MarcBittner/ai-portfolio/tree/main/projects"

# The fleet, from README.md's live-demo table, as compact rows:
#   (slug, url, tags, health_path).  Health path defaults to /health for the
# FastAPI services; the Next.js app + the Rails demo expose other liveness routes.
# URLs are public; nothing here is a secret. ``name`` defaults to ``slug`` and the
# repo link is derived, so adding a target is a one-line row.
_SEED_ROWS: list[tuple] = [
    ("persona-twin", "https://persona-twin-usu4.onrender.com", ["rag", "llm"]),
    ("pii-redactor", "https://pii-redactor-lk6x.onrender.com", ["pii", "llm"]),
    ("evalkit", "https://evalkit-2ptv.onrender.com", ["eval", "llm"]),
    ("doc-extract", "https://doc-extract-oyuj.onrender.com", ["extract", "llm"]),
    ("agent-sandbox", "https://agent-sandbox-jp4b.onrender.com", ["agent", "llm"]),
    ("promptguard", "https://promptguard-oiqr.onrender.com", ["security", "llm"]),
    ("synth-data", "https://synth-data.onrender.com", ["data", "llm"]),
    ("forecast", "https://forecast-h6uf.onrender.com", ["ml"]),
    ("multimodal-ocr", "https://multimodal-ocr-x2g3.onrender.com", ["ocr", "llm"]),
    ("reconcile", "https://reconcile-gfuj.onrender.com", ["finance", "llm"]),
    ("llm-gateway", "https://llm-gateway-jwsq.onrender.com", ["gateway", "llm"]),
    ("slo-kit", "https://slo-kit-qx19.onrender.com", ["sre"]),
    ("field-vault", "https://field-vault-ae0k.onrender.com", ["security"]),
    ("rtc-guard", "https://rtc-guard.onrender.com", ["security", "webrtc"]),
    ("rate-atlas", "https://rate-atlas-6gd3.onrender.com", ["healthcare"]),
    ("attack-surface", "https://attack-surface.onrender.com", ["security"]),
    ("txn-ledger", "https://txn-ledger.onrender.com", ["data"]),
    ("agent-factory", "https://agent-factory-ov8r.onrender.com", ["agent", "llm"]),
    ("trueline", "https://trueline-moys.onrender.com", ["finance", "llm"], "/"),
    ("postureline", "https://postureline.onrender.com", ["security"]),
    ("relaytoken", "https://relaytoken.onrender.com", ["security", "go"]),
    ("cycleledger", "https://cycleledger.onrender.com", ["data", "rails"], "/up"),
    ("quorum", "https://quorum-9x75.onrender.com", ["agent", "llm"]),
    ("burnrate", "https://burnrate-grza.onrender.com", ["sre", "flask"]),
    ("baseplate", "https://baseplate-mlrj.onrender.com", ["platform"]),
    ("arbiter", "https://arbiter-splt.onrender.com", ["gateway", "llm"]),
    ("counsel", "https://counsel-7saj.onrender.com", ["finance", "llm"]),
]


def _seed_target(row: tuple) -> Target:
    slug, url, tags = row[0], row[1], row[2]
    health = row[3] if len(row) > 3 else "/health"
    return Target(slug=slug, name=slug, url=url, health_path=health,
                  repo=f"{_REPO_BASE}/{slug}", tags=list(tags))


SEED_TARGETS: list[Target] = [
    Target(slug="vigil", name="vigil (self)", url=SELF_BASE_URL,
           self_monitor=True, tags=["observability", "self"],
           repo=f"{_REPO_BASE}/vigil"),
    *[_seed_target(r) for r in _SEED_ROWS],
]


def load_file_targets() -> list[Target]:
    """Targets dropped into ``targets.json`` (admin-managed, merged over the seed).

    Shape: a JSON list of objects with at least ``slug``, ``name``, ``url``. This
    is the zero-code extensibility path: edit one file, restart (or hit the admin
    reload), and the target is monitored.
    """
    if not TARGETS_FILE.exists():
        return []
    try:
        raw = json.loads(TARGETS_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return []
    out: list[Target] = []
    for row in raw if isinstance(raw, list) else []:
        try:
            out.append(Target(
                slug=row["slug"], name=row["name"], url=row["url"],
                health_path=row.get("health_path", "/health"),
                repo=row.get("repo"), self_monitor=bool(row.get("self_monitor", False)),
                tags=list(row.get("tags", [])),
            ))
        except (KeyError, TypeError):
            continue
    return out
