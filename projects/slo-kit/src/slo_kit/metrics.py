"""RED metrics (Rate, Errors, Duration) — a tiny in-process registry with a
Prometheus text exposition, no external client dependency.

Tracks request counts by endpoint+status, a bounded window of latencies for
percentiles, and the counts an SLO needs (errors, requests under the latency
target). Thread-safety is a lock around record/read — good enough for a single
uvicorn worker; a real deployment would scrape a proper client library.
"""

import threading
from collections import defaultdict

LATENCY_TARGET_MS = 250.0   # the "fast enough" threshold for the latency SLI
_WINDOW = 5000              # bounded latency samples kept for percentiles


def _pct(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    i = min(len(sorted_vals) - 1, int(q * len(sorted_vals)))
    return round(sorted_vals[i], 1)


class Metrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        with self._lock:
            self._init_state()

    def _init_state(self) -> None:
        self.total = 0
        self.errors = 0
        self.under_target = 0
        self.by_status: dict[str, int] = defaultdict(int)
        self.by_endpoint: dict[str, int] = defaultdict(int)
        self.dur_sum = 0.0
        self._durations: list[float] = []

    def reset(self) -> None:
        with self._lock:
            self._init_state()

    def record(self, endpoint: str, status: int, duration_ms: float) -> None:
        with self._lock:
            self.total += 1
            self.by_status[str(status)] += 1
            self.by_endpoint[endpoint] += 1
            self.dur_sum += duration_ms
            if status >= 500:
                self.errors += 1
            if duration_ms <= LATENCY_TARGET_MS:
                self.under_target += 1
            self._durations.append(duration_ms)
            if len(self._durations) > _WINDOW:
                self._durations.pop(0)

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
                "avg_ms": round(self.dur_sum / total, 1) if total else 0.0,
                "p50_ms": _pct(s, 0.50),
                "p95_ms": _pct(s, 0.95),
                "p99_ms": _pct(s, 0.99),
                "by_status": dict(self.by_status),
                "by_endpoint": dict(self.by_endpoint),
                "latency_target_ms": LATENCY_TARGET_MS,
            }

    def prometheus(self) -> str:
        snap = self.snapshot()
        lines = [
            "# HELP slo_requests_total Total requests by status.",
            "# TYPE slo_requests_total counter",
        ]
        for status, n in sorted(snap["by_status"].items()):
            lines.append(f'slo_requests_total{{status="{status}"}} {n}')
        lines += [
            "# HELP slo_request_errors_total Requests with a 5xx status.",
            "# TYPE slo_request_errors_total counter",
            f"slo_request_errors_total {snap['errors']}",
            "# HELP slo_request_duration_ms_avg Mean request duration (ms).",
            "# TYPE slo_request_duration_ms_avg gauge",
            f"slo_request_duration_ms_avg {snap['avg_ms']}",
            "# HELP slo_request_duration_ms Request duration quantiles (ms).",
            "# TYPE slo_request_duration_ms summary",
            f'slo_request_duration_ms{{quantile="0.5"}} {snap["p50_ms"]}',
            f'slo_request_duration_ms{{quantile="0.95"}} {snap["p95_ms"]}',
            f'slo_request_duration_ms{{quantile="0.99"}} {snap["p99_ms"]}',
        ]
        return "\n".join(lines) + "\n"


registry = Metrics()
