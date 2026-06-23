"""vigil's own structured operational log — self-monitoring includes logs, not
just uptime.

Two entry points write into the ``logs`` table under slug ``vigil``:

- ``slog(level, message, source, **meta)`` — the explicit hook the app calls at
  meaningful moments (poll cycle start/finish, an alert firing, a caught error).
- ``DBLogHandler`` — a ``logging.Handler`` attached to the ``vigil`` logger tree so
  ordinary ``log.info(...)``/``log.warning(...)`` calls are *also* captured, giving
  the self-logs real coverage without threading ``slog`` through every call site.

Both are best-effort and never raise: a logging path that can crash the prober (or
worse, recurse through the handler) is unacceptable. Writes are guarded and the
handler suppresses re-entrancy and any storage error.
"""

from __future__ import annotations

import logging
import threading

SELF_SLUG = "vigil"

# Map Python logging levels onto vigil's four-level vocabulary.
_LEVEL_MAP = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",
    logging.ERROR: "error",
    logging.CRITICAL: "error",
}

# Re-entrancy guard: store.add_logs may itself log (sqlite/transport), which would
# loop back through the handler. A thread-local flag breaks the cycle.
_in_emit = threading.local()


def _python_level_to_vigil(levelno: int) -> str:
    return _LEVEL_MAP.get(levelno, "info")


def slog(level: str, message: str, source: str = "vigil", **meta) -> None:
    """Write one structured operational log line for vigil itself. Best-effort:
    any failure is swallowed so logging can never break the thing being logged."""
    try:
        from vigil import store

        store.add_logs(SELF_SLUG, [{
            "level": level, "source": source, "message": message,
            "meta": meta or None,
        }])
    except Exception:  # noqa: BLE001 — self-logging must never raise
        pass


class DBLogHandler(logging.Handler):
    """A logging handler that mirrors ``vigil``-logger records into the logs table.

    Attached once (``install()``), it captures the app's ordinary log output so the
    self-log viewer reflects what the server actually did. The explicit ``slog``
    hook adds richer structured events on top of this baseline."""

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(_in_emit, "active", False):
            return
        _in_emit.active = True
        try:
            from vigil import store

            store.add_logs(SELF_SLUG, [{
                "level": _python_level_to_vigil(record.levelno),
                "source": record.name,
                "message": record.getMessage(),
                "meta": None,
            }])
        except Exception:  # noqa: BLE001 — never let logging crash the app
            pass
        finally:
            _in_emit.active = False


_installed = False


def install() -> None:
    """Attach the DB handler to the ``vigil`` logger tree (idempotent)."""
    global _installed
    if _installed:
        return
    handler = DBLogHandler(level=logging.INFO)
    logging.getLogger("vigil").addHandler(handler)
    _installed = True
