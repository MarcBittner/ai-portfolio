"""The instrumented "outreach-send" workload — the thing an SRE actually operates.

Sending a message is simulated (no real email/SMS); each call is **instrumented**
exactly the way a production Flask handler would be: it records one RED metric
(Prometheus counter + histogram) per request. A deterministic fault switch injects
an error rate and added latency so you can **burn the error budget on demand** and
then watch it recover — the core of the incident demo. No randomness: every number
is byte-reproducible across runs, tests, and the eval.

The service also keeps a small **short-window** view of the last requests so
``slo.py`` can make the multiwindow (long+short) burn-rate page decision; the long
window is the full registry snapshot.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

from burnrate import slo
from burnrate.metrics import registry

BASE_LATENCY_MS = 35.0
SEND = "POST /v1/outreach"
SHORT_WINDOW = 200          # requests counted for the short-window burn rate


@dataclass
class Fault:
    error_rate: float = 0.0     # 0..1 — fraction of requests forced to 5xx
    latency_ms: float = 0.0     # extra latency added to every request


fault = Fault()
_outbox: list[dict] = []
_short: deque[bool] = deque(maxlen=SHORT_WINDOW)   # True = error, for short window
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
    _short.clear()
    registry.reset()
    _publish()


def _short_snapshot() -> dict:
    """A snapshot-shaped dict over the last SHORT_WINDOW requests — only the fields
    slo.compute needs for the short-window burn decision."""
    n = len(_short)
    errs = sum(_short)
    return {"total": n, "error_rate": round(errs / n, 6) if n else 0.0,
            "fast_ratio": 1.0, "p95_ms": 0.0, "latency_target_ms": 0.0}


def _publish() -> None:
    """Recompute the SLO and reflect budget + burn into the Prometheus gauges."""
    s = slo.compute(registry.snapshot(), _short_snapshot())
    registry.publish_slo(
        s["availability"]["budget_remaining"],
        {"long": s["burn_policy"]["long_window_burn"],
         "short": s["burn_policy"]["short_window_burn"]},
    )


def _simulate(endpoint: str) -> tuple[int, float]:
    """Decide status + duration for one request under the current fault and
    instrument it. Errors are injected deterministically (every Nth request)."""
    global _n
    _n += 1
    err = False
    if fault.error_rate > 0:
        step = max(1, round(1 / fault.error_rate))
        err = (_n % step == 0)
    status = 500 if err else 200
    duration = BASE_LATENCY_MS + (_n % 5) * 4.0 + fault.latency_ms
    registry.record(endpoint, status, duration)
    _short.append(err)
    return status, duration


def send_outreach(channel: str, to: str, body: str) -> tuple[int, dict]:
    status, duration = _simulate(SEND)
    _publish()
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
    """Fire ``n`` synthetic sends under the current fault; return the SLO snapshot
    (long+short windows), with the Prometheus gauges refreshed."""
    n = max(1, min(5000, n))
    for _ in range(n):
        _simulate(SEND)
    _publish()
    return slo.compute(registry.snapshot(), _short_snapshot())


def snapshot() -> dict:
    """Current SLO snapshot over both windows (used by /slo and incident.py)."""
    return slo.compute(registry.snapshot(), _short_snapshot())
