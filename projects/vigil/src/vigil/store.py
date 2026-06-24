"""Persistence facade — a thin selector over two interchangeable backends.

vigil's whole codebase calls module-level functions on ``store`` (``list_targets``,
``record_probe``, ``add_check``, …). That public surface is defined once and
implemented twice:

- ``_store_sqlite`` — the **default**: a single dependency-free SQLite file. Used
  for every local run and the entire test suite (no external service, no extra
  deps). Selected whenever ``config.MONGODB_URI`` is unset.
- ``_store_mongo`` — a durable MongoDB backend (pymongo) with an idiomatic document
  model (embedded checks, native time-series collections + TTL retention, indexed
  standard collections). Selected **only** when ``config.MONGODB_URI`` is set, and
  ``pymongo`` is imported lazily there so the SQLite path never needs it installed.

Both backends expose the **identical** function names, signatures, and return
shapes — including **opaque string ids** (SQLite ``str(rowid)`` / Mongo
``str(ObjectId)``) so api.py and the SPA are backend-agnostic. Every other vigil
module keeps importing ``from vigil import store`` unchanged; flipping backends is
purely an env-var (``MONGODB_URI``) decision made here at import time.
"""

from __future__ import annotations

from vigil import config

# ``config`` is intentionally re-exported (the test suite + a few callers reach
# ``store.config.DB_PATH``); keep it available regardless of the active backend.
__all__ = ["config"]

if config.MONGODB_URI:
    from vigil._store_mongo import *  # noqa: F401,F403 — backend selection
    from vigil._store_mongo import LOG_LEVELS, init_db  # noqa: F401 — explicit re-export
    _BACKEND = "mongo"
else:
    from vigil._store_sqlite import *  # noqa: F401,F403 — default backend
    from vigil._store_sqlite import LOG_LEVELS, init_db  # noqa: F401 — explicit re-export
    _BACKEND = "sqlite"


def backend() -> str:
    """Name of the active storage backend ('sqlite' | 'mongo'). For health/debug."""
    return _BACKEND
