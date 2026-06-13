"""RED metrics on the real ``prometheus_client`` — the registry Grafana scrapes.

Unlike a hand-rolled text registry, this uses ``prometheus_client``'s Counter /
Histogram / Gauge so ``/metrics`` is the genuine Prometheus exposition format
(``generate_latest``) a Grafana/Prometheus stack scrapes unmodified. Every send
records into the same instruments the SLO math then reads back from.

Three RED instruments plus the SLO-derived gauges:
  • ``burnrate_requests_total{endpoint,status}``        — Rate + Errors (counter)
  • ``burnrate_request_duration_seconds{endpoint}``     — Duration (histogram)
  • ``burnrate_error_budget_remaining_ratio``           — budget left (gauge)
  • ``burnrate_burn_rate{window}``                      — multi-window burn (gauge)
  • ``burnrate_tasks_total{task,status}``               — background task counter

A dedicated ``CollectorRegistry`` (not the process-global default) keeps the demo
resettable — ``/admin/reset`` rebuilds it so the burn/recover story starts clean.
The latency-SLI bucket boundary is pinned to the target so the "fast enough"
fraction reads straight off the histogram bucket the scraper already has.
"""

from __future__ import annotations

import threading

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

LATENCY_TARGET_MS = 250.0          # "fast enough" threshold for the latency SLI
LATENCY_TARGET_S = LATENCY_TARGET_MS / 1000.0

# Histogram buckets in seconds; the target boundary is included so the cumulative
# count at LATENCY_TARGET_S is exactly the "under target" count the SLI needs.
_BUCKETS = (0.01, 0.025, 0.05, 0.1, LATENCY_TARGET_S, 0.5, 1.0, 2.5, 5.0)


class Metrics:
    """A resettable wrapper around a private Prometheus ``CollectorRegistry``.

    Holds the RED instruments and the SLO-derived gauges, plus a small shadow of
    plain counters (lock-guarded) so ``snapshot()`` can hand ``slo.py`` a cheap
    dict without scraping the registry on every read.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._build()

    def _build(self) -> None:
        self.registry = CollectorRegistry()
        self.requests = Counter(
            "burnrate_requests_total", "Total requests by endpoint and status.",
            ["endpoint", "status"], registry=self.registry,
        )
        self.duration = Histogram(
            "burnrate_request_duration_seconds", "Request duration (seconds).",
            ["endpoint"], buckets=_BUCKETS, registry=self.registry,
        )
        self.budget_gauge = Gauge(
            "burnrate_error_budget_remaining_ratio",
            "Fraction of the availability error budget still unspent.",
            registry=self.registry,
        )
        self.burn_gauge = Gauge(
            "burnrate_burn_rate", "Error-budget burn rate by alerting window.",
            ["window"], registry=self.registry,
        )
        self.tasks = Counter(
            "burnrate_tasks_total", "Background tasks processed by task and status.",
            ["task", "status"], registry=self.registry,
        )
        # shadow counters for a cheap snapshot()
        self.total = 0
        self.errors = 0
        self.under_target = 0
        self.dur_sum_ms = 0.0
        self.by_status: dict[str, int] = {}
        self.by_endpoint: dict[str, int] = {}
        self._durations: list[float] = []   # ms, bounded window for percentiles

    def reset(self) -> None:
        with self._lock:
            self._build()

    def record(self, endpoint: str, status: int, duration_ms: float) -> None:
        with self._lock:
            self.requests.labels(endpoint=endpoint, status=str(status)).inc()
            self.duration.labels(endpoint=endpoint).observe(duration_ms / 1000.0)
            self.total += 1
            self.by_status[str(status)] = self.by_status.get(str(status), 0) + 1
            self.by_endpoint[endpoint] = self.by_endpoint.get(endpoint, 0) + 1
            self.dur_sum_ms += duration_ms
            if status >= 500:
                self.errors += 1
            if duration_ms <= LATENCY_TARGET_MS:
                self.under_target += 1
            self._durations.append(duration_ms)
            if len(self._durations) > 5000:
                self._durations.pop(0)

    def record_task(self, task: str, status: str) -> None:
        with self._lock:
            self.tasks.labels(task=task, status=status).inc()

    def publish_slo(self, budget_remaining: float, burns: dict[str, float]) -> None:
        """Reflect the computed SLO state back into Prometheus gauges so a scraper
        sees the same budget/burn numbers the dashboard does."""
        with self._lock:
            self.budget_gauge.set(budget_remaining)
            for window, value in burns.items():
                self.burn_gauge.labels(window=window).set(value)

    def snapshot(self) -> dict:
        with self._lock:
            s = sorted(self._durations)
            total = self.total
            return {
                "total": total,
                "errors": self.errors,
                "error_rate": round(self.errors / total, 6) if total else 0.0,
                "under_target": self.under_target,
                "fast_ratio": round(self.under_target / total, 6) if total else 1.0,
                "avg_ms": round(self.dur_sum_ms / total, 1) if total else 0.0,
                "p50_ms": _pct(s, 0.50),
                "p95_ms": _pct(s, 0.95),
                "p99_ms": _pct(s, 0.99),
                "by_status": dict(self.by_status),
                "by_endpoint": dict(self.by_endpoint),
                "latency_target_ms": LATENCY_TARGET_MS,
            }

    def prometheus(self) -> bytes:
        """The real Prometheus exposition Grafana scrapes (``generate_latest``)."""
        return generate_latest(self.registry)


def _pct(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    i = min(len(sorted_vals) - 1, int(q * len(sorted_vals)))
    return round(sorted_vals[i], 1)


CONTENT_TYPE = CONTENT_TYPE_LATEST
registry = Metrics()
