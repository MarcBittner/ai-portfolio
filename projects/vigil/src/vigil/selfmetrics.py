"""vigil's own metrics — so vigil is scrapeable like any target it monitors.

Process-lifetime counters/gauges, incremented from the poll cycle and alerting,
rendered as Prometheus text at ``GET /metrics``. The counters are monotonic
in-process integers (reset on restart, like any unregistered Prometheus process
metric); the gauges are recomputed live from the store at render time so the
exposition always reflects the latest fleet state.

This is the self-metrics half of #28: vigil exposes the same ``/metrics`` surface
it scrapes from every other target, and its own scrape (the ``vigil`` self target
whose metrics_url points back here) flows through the identical parse+store path.
"""

from __future__ import annotations

import threading
import time

_lock = threading.Lock()
_start = time.time()

# Monotonic counters (process lifetime).
_counters: dict[str, float] = {
    "vigil_probes_total": 0.0,
    "vigil_poll_cycles_total": 0.0,
    "vigil_checks_passed_total": 0.0,
    "vigil_checks_failed_total": 0.0,
    "vigil_alerts_fired_total": 0.0,
    "vigil_logs_ingested_total": 0.0,
    "vigil_metrics_scraped_total": 0.0,
}
# Most-recent observed gauges (set per cycle).
_gauges: dict[str, float] = {
    "vigil_last_poll_duration_seconds": 0.0,
}


def inc(name: str, amount: float = 1.0) -> None:
    with _lock:
        if name in _counters:
            _counters[name] += amount


def set_gauge(name: str, value: float) -> None:
    with _lock:
        _gauges[name] = float(value)


def snapshot() -> dict[str, float]:
    """A flat name→value view of the in-process counters/gauges (for tests)."""
    with _lock:
        return {**_counters, **_gauges}


def _fleet_gauges() -> list[tuple[str, dict, float]]:
    """Live fleet gauges computed from the store at render time."""
    try:
        from vigil import metrics
        rollup = metrics.fleet_rollup()
    except Exception:  # noqa: BLE001 — /metrics must never 500
        return []
    out = [
        ("vigil_targets_total", {}, float(rollup.get("targets_total", 0))),
        ("vigil_targets_up", {}, float(rollup.get("up", 0))),
        ("vigil_targets_down", {}, float(len(rollup.get("down", [])))),
        ("vigil_targets_degraded", {}, float(len(rollup.get("degraded", [])))),
    ]
    avail = rollup.get("fleet_availability")
    if avail is not None:
        out.append(("vigil_fleet_availability", {}, float(avail)))
    return out


# Per-metric HELP/TYPE so the exposition is self-describing and parser-friendly.
_META = {
    "vigil_probes_total": ("counter", "Total target probes run."),
    "vigil_poll_cycles_total": ("counter", "Total poll cycles completed."),
    "vigil_checks_passed_total": ("counter", "Total synthetic checks that passed."),
    "vigil_checks_failed_total": ("counter", "Total synthetic checks that failed."),
    "vigil_alerts_fired_total": ("counter", "Total alert events fired."),
    "vigil_logs_ingested_total": ("counter", "Total log entries ingested."),
    "vigil_metrics_scraped_total": ("counter", "Total metric samples scraped + stored."),
    "vigil_last_poll_duration_seconds": ("gauge", "Duration of the last poll cycle."),
    "vigil_uptime_seconds": ("gauge", "Seconds since this vigil process started."),
    "vigil_targets_total": ("gauge", "Targets in the registry."),
    "vigil_targets_up": ("gauge", "Targets currently up."),
    "vigil_targets_down": ("gauge", "Targets currently down."),
    "vigil_targets_degraded": ("gauge", "Targets currently degraded."),
    "vigil_fleet_availability": ("gauge", "Mean rolling availability across the fleet."),
}


def render() -> str:
    """Render all metrics as Prometheus text exposition format."""
    with _lock:
        counters = dict(_counters)
        gauges = dict(_gauges)
    gauges["vigil_uptime_seconds"] = round(time.time() - _start, 1)

    samples: list[tuple[str, dict, float]] = []
    for name, val in counters.items():
        samples.append((name, {}, val))
    for name, val in gauges.items():
        samples.append((name, {}, val))
    samples.extend(_fleet_gauges())

    lines: list[str] = []
    emitted_meta: set[str] = set()
    for name, labels, value in samples:
        if name not in emitted_meta:
            mtype, mhelp = _META.get(name, ("untyped", ""))
            if mhelp:
                lines.append(f"# HELP {name} {mhelp}")
            lines.append(f"# TYPE {name} {mtype}")
            emitted_meta.add(name)
        label_str = ""
        if labels:
            inner = ",".join(f'{k}="{v}"' for k, v in sorted(labels.items()))
            label_str = "{" + inner + "}"
        # Integers render without a trailing .0 for tidy counters.
        rendered = str(int(value)) if float(value).is_integer() else repr(value)
        lines.append(f"{name}{label_str} {rendered}")
    return "\n".join(lines) + "\n"
