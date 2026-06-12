"""The instrumented "outreach-API" — the workload an SRE actually runs.

Sending a message is simulated (no real email/SMS); each call is **instrumented**
the same way a production handler would be: it records a metric and a trace span.
A deterministic fault switch lets you inject an error rate and added latency to
*burn the error budget on demand* and then watch it recover — the core of the
incident demo. Deterministic (no randomness) so tests and demos are reproducible.
"""

from dataclasses import dataclass

from slo_kit import slo
from slo_kit.metrics import registry
from slo_kit.tracing import tracer

BASE_LATENCY_MS = 35.0
SEND = "POST /v1/messages"


@dataclass
class Fault:
    error_rate: float = 0.0     # 0..1 — fraction of requests forced to 5xx
    latency_ms: float = 0.0     # extra latency added to every request


fault = Fault()
_outbox: list[dict] = []
_n = 0


def set_fault(error_rate: float = 0.0, latency_ms: float = 0.0) -> Fault:
    global fault
    fault = Fault(error_rate=max(0.0, min(1.0, error_rate)),
                  latency_ms=max(0.0, latency_ms))
    return fault


def reset() -> None:
    global fault, _n
    fault = Fault()
    _n = 0
    _outbox.clear()
    registry.reset()
    tracer.reset()


def _simulate(endpoint: str) -> tuple[int, float]:
    """Decide status + duration for one request under the current fault, and
    instrument it (metric + trace). Errors are injected deterministically."""
    global _n
    _n += 1
    err = False
    if fault.error_rate > 0:
        step = max(1, round(1 / fault.error_rate))
        err = (_n % step == 0)
    status = 500 if err else 200
    # deterministic latency: nominal + small jitter + injected fault latency
    duration = BASE_LATENCY_MS + (_n % 5) * 4.0 + fault.latency_ms
    registry.record(endpoint, status, duration)
    tracer.record(endpoint, duration, "error" if err else "ok",
                  {"http.status_code": status})
    return status, duration


def send_message(channel: str, to: str, body: str) -> tuple[int, dict]:
    status, duration = _simulate(SEND)
    if status >= 500:
        return status, {"error": "upstream send failed",
                        "duration_ms": round(duration, 1)}
    msg = {"id": _n, "channel": channel, "to": to, "chars": len(body),
           "duration_ms": round(duration, 1)}
    _outbox.append(msg)
    if len(_outbox) > 500:
        _outbox.pop(0)
    return status, msg


def outbox(limit: int = 25) -> list[dict]:
    return _outbox[-limit:][::-1]


def loadtest(n: int) -> dict:
    """Fire ``n`` synthetic sends under the current fault; return the SLO snapshot."""
    n = max(1, min(5000, n))
    for _ in range(n):
        _simulate(SEND)
    return slo.compute(registry.snapshot())
