"""Structured-ish logging on stdlib: key=value pairs, request-id context.

INFO level never logs payload contents — stage names, timings, counts,
and routing decisions only (see spec NFR-3).
"""

import logging
import uuid
from contextvars import ContextVar

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)


def new_request_id() -> str:
    rid = uuid.uuid4().hex[:12]
    _request_id.set(rid)
    return rid


class _RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = _request_id.get() or "-"
        return True


def configure(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler()
    handler.addFilter(_RequestIdFilter())
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s [%(request_id)s] %(name)s: %(message)s")
    )
    root = logging.getLogger("persona_twin")
    root.handlers[:] = [handler]
    root.setLevel(level)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"persona_twin.{name}")


def kv(**fields: object) -> str:
    """Render fields as a stable key=value suffix for log lines."""
    return " ".join(f"{k}={v}" for k, v in sorted(fields.items()))
