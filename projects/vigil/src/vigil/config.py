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

# --- Storage backend selection --------------------------------------------- #
# vigil persists to SQLite by default (the dependency-free single-file backend the
# whole test suite runs on). Setting ``MONGODB_URI`` switches the entire store to a
# durable MongoDB backend (pymongo, imported lazily so SQLite never needs it). The
# Mongo DB name defaults to ``vigil`` — a DEDICATED database, isolated from any
# other app on the same cluster (e.g. persona-twin's ``persona_twin`` vector DB);
# vigil never reads or writes another app's database/collections.
# NEEDS-CREDENTIAL for durable storage: set MONGODB_URI to a connection string.
MONGODB_URI = os.environ.get("MONGODB_URI") or None
MONGODB_DB = os.environ.get("VIGIL_MONGODB_DB", "vigil")
# Time-based retention for the Mongo time-series collections (probes, check_results,
# logs, metric_samples). This replaces SQLite's count-based manual pruning with a
# self-managing TTL — idiomatic for Mongo time series. Default: 14 days.
MONGODB_TTL_SECONDS = int(os.environ.get("VIGIL_MONGODB_TTL_SECONDS", str(14 * 86400)))

POLL_INTERVAL_S = float(os.environ.get("VIGIL_POLL_INTERVAL", "60"))
PROBE_TIMEOUT_S = float(os.environ.get("VIGIL_PROBE_TIMEOUT", "8"))
# Free hosts (Render) spin down when idle; the first probe hits a cold start that
# can take 30-60s (or returns Render's transient warmup/502 page). A short probe
# would read every idle-but-healthy demo as "down". When a probe sees a cold-start
# signal, vigil re-probes once with this longer budget to let the service wake.
WARMUP_TIMEOUT_S = float(os.environ.get("VIGIL_WARMUP_TIMEOUT", "55"))
# Rolling window (number of recent probes) used for availability + error rate.
ROLLING_WINDOW = int(os.environ.get("VIGIL_ROLLING_WINDOW", "50"))
# Retain at most this many probe rows per target (cheap self-pruning time series).
MAX_HISTORY_PER_TARGET = int(os.environ.get("VIGIL_MAX_HISTORY", "1000"))

# --- Logs + metrics ingestion/scrape knobs --------------------------------- #
# Token for the push log-ingestion endpoint (POST /api/ingest/logs). If UNSET,
# the endpoint accepts only loopback callers (dev-friendly, safe by default); set
# this to require the X-Ingest-Token header from any source.
# NEEDS-CREDENTIAL for cross-host ingestion: unset → loopback-only.
INGEST_TOKEN = os.environ.get("VIGIL_INGEST_TOKEN") or None

# Retain at most this many log rows / metric-sample rows per target (self-pruning,
# mirrors MAX_HISTORY_PER_TARGET so the SQLite file stays bounded).
MAX_LOGS_PER_TARGET = int(os.environ.get("VIGIL_MAX_LOGS", "2000"))
MAX_METRICS_PER_TARGET = int(os.environ.get("VIGIL_MAX_METRICS", "5000"))

# Default path scraped for app metrics (Prometheus text); per-target overridable.
DEFAULT_METRICS_PATH = os.environ.get("VIGIL_METRICS_PATH", "/metrics")
# Cap the number of series stored per scrape so a chatty target can't blow up the
# table in a single cycle.
MAX_SERIES_PER_SCRAPE = int(os.environ.get("VIGIL_MAX_SERIES_PER_SCRAPE", "200"))

# Retain at most this many code-quality rows / push rows / repo-scan rows per slug
# (self-pruning, keeps the SQLite file bounded like every other time series).
MAX_QUALITY_PER_TARGET = int(os.environ.get("VIGIL_MAX_QUALITY", "200"))
MAX_PUSHES_PER_TARGET = int(os.environ.get("VIGIL_MAX_PUSHES", "200"))
MAX_REPO_SCANS_PER_TARGET = int(os.environ.get("VIGIL_MAX_REPO_SCANS", "50"))

# GitHub webhook (POST /api/hooks/github) HMAC-SHA256 shared secret. SECURE BY
# DEFAULT: when this is UNSET, the webhook REJECTS every remote call (a missing
# secret can't be verified, so we refuse rather than trust). NEEDS-CREDENTIAL:
# set this to the same value configured on the GitHub webhook to enable it.
GITHUB_WEBHOOK_SECRET = os.environ.get("VIGIL_GITHUB_WEBHOOK_SECRET") or None

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
# Self-monitor target. Probe the loopback on the SAME port the app actually binds
# (the host injects PORT at runtime — Render's is not the Dockerfile default), so
# self-monitoring works without hand-setting a URL. Override with VIGIL_SELF_URL.
SELF_BASE_URL = (
    os.environ.get("VIGIL_SELF_URL")
    or f"http://127.0.0.1:{os.environ.get('PORT', '8020')}"
).rstrip("/")

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
    # Optional override for the metrics scrape path (Prometheus text). None falls
    # back to DEFAULT_METRICS_PATH; a target that 404s there is simply skipped.
    metrics_path: str | None = None

    @property
    def health_url(self) -> str:
        return self.url.rstrip("/") + "/" + self.health_path.lstrip("/")

    @property
    def metrics_url(self) -> str:
        path = self.metrics_path or DEFAULT_METRICS_PATH
        return self.url.rstrip("/") + "/" + path.lstrip("/")

    def to_dict(self) -> dict:
        return {
            "slug": self.slug, "name": self.name, "url": self.url,
            "health_path": self.health_path, "repo": self.repo,
            "self_monitor": self.self_monitor, "tags": list(self.tags),
            "metrics_path": self.metrics_path,
            "health_url": self.health_url, "metrics_url": self.metrics_url,
        }


_REPO_BASE = "https://github.com/MarcBittner/ai-portfolio/tree/main/projects"

# The fleet, from README.md's live-demo table, as compact rows:
#   (slug, url, tags, health_path).  Health path defaults to /health for the
# FastAPI services; the Next.js app + the Rails demo expose other liveness routes.
# URLs are public; nothing here is a secret. ``name`` defaults to ``slug`` and the
# repo link is derived, so adding a target is a one-line row.
_SEED_ROWS: list[tuple] = [
    ("persona-twin", "https://persona-twin-s4nj.onrender.com", ["rag", "llm"]),
    ("pii-redactor", "https://pii-redactor-t3aw.onrender.com", ["pii", "llm"]),
    ("evalkit", "https://evalkit-b3fz.onrender.com", ["eval", "llm"]),
    ("doc-extract", "https://doc-extract-h68a.onrender.com", ["extract", "llm"]),
    ("agent-sandbox", "https://agent-sandbox-2unn.onrender.com", ["agent", "llm"]),
    ("promptguard", "https://promptguard-p9y0.onrender.com", ["security", "llm"]),
    ("synth-data", "https://synth-data-4amp.onrender.com", ["data", "llm"]),
    ("forecast", "https://forecast-b8zt.onrender.com", ["ml"]),
    ("multimodal-ocr", "https://multimodal-ocr-ty8t.onrender.com", ["ocr", "llm"]),
    ("reconcile", "https://reconcile-vx21.onrender.com", ["finance", "llm"]),
    ("llm-gateway", "https://llm-gateway-7woj.onrender.com", ["gateway", "llm"]),
    ("slo-kit", "https://slo-kit-nom9.onrender.com", ["sre"]),
    ("field-vault", "https://field-vault-cvat.onrender.com", ["security"]),
    ("rtc-guard", "https://rtc-guard-wpbe.onrender.com", ["security", "webrtc"]),
    ("rate-atlas", "https://rate-atlas-q6q6.onrender.com", ["healthcare"]),
    ("attack-surface", "https://attack-surface-wg5r.onrender.com", ["security"]),
    ("txn-ledger", "https://txn-ledger-iyfi.onrender.com", ["data"]),
    ("agent-factory", "https://agent-factory-ohkl.onrender.com", ["agent", "llm"]),
    ("trueline", "https://trueline-dcqc.onrender.com", ["finance", "llm"], "/"),
    ("postureline", "https://postureline-3a8z.onrender.com", ["security"]),
    ("relaytoken", "https://relaytoken-9p78.onrender.com", ["security", "go"], "/healthz"),
    ("cycleledger", "https://cycleledger-8xg3.onrender.com", ["data", "rails"], "/up"),
    ("quorum", "https://quorum-71pl.onrender.com", ["agent", "llm"]),
    ("burnrate", "https://burnrate-v8sp.onrender.com", ["sre", "flask"], "/healthz"),
    ("baseplate", "https://baseplate-b0ag.onrender.com", ["platform"]),
    ("arbiter", "https://arbiter-kfaz.onrender.com", ["gateway", "llm"]),
    ("counsel", "https://counsel-nqcp.onrender.com", ["finance", "llm"]),
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
                metrics_path=row.get("metrics_path"),
            ))
        except (KeyError, TypeError):
            continue
    return out
