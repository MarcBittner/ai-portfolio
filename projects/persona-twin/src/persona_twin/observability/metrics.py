"""A small, dependency-free Prometheus metrics layer.

In the spirit of the rest of this repo (BM25, the circuit breaker, the
redactor are all hand-rolled), this implements just enough of the
Prometheus data model — labeled counters, gauges, and histograms — to
render the text exposition format (0.0.4). No client library, no
background threads; collection is in-process and rendering is pull-based
at scrape time.

Metric instances are module-level singletons (used like loggers). The
``/metrics`` endpoint adds pull-style gauges (build info, index size,
cache, circuit cooldowns) at scrape time and calls :func:`render`.
"""

import math
from collections import defaultdict

# LLM call latencies span ms→seconds; buckets are milliseconds.
LATENCY_BUCKETS_MS: tuple[float, ...] = (
    5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
)

_Labels = tuple[str, ...]


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _label_str(names: tuple[str, ...], values: _Labels) -> str:
    if not names:
        return ""
    pairs = ",".join(
        f'{n}="{_escape(str(v))}"' for n, v in zip(names, values, strict=True)
    )
    return "{" + pairs + "}"


class _Metric:
    def __init__(self, name: str, help_text: str, labelnames: tuple[str, ...] = ()):
        self.name = name
        self.help = help_text
        self.labelnames = labelnames

    def _key(self, labelvalues: _Labels) -> _Labels:
        if len(labelvalues) != len(self.labelnames):
            raise ValueError(
                f"{self.name} expects labels {self.labelnames}, got {labelvalues}"
            )
        return labelvalues


class Counter(_Metric):
    def __init__(self, name, help_text, labelnames=()):
        super().__init__(name, help_text, labelnames)
        self._values: dict[_Labels, float] = defaultdict(float)

    def inc(self, *labelvalues: str, amount: float = 1.0) -> None:
        self._values[self._key(labelvalues)] += amount

    def render(self) -> list[str]:
        lines = [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} counter"]
        for labels, value in sorted(self._values.items()):
            lines.append(f"{self.name}{_label_str(self.labelnames, labels)} {value:g}")
        return lines


class Gauge(_Metric):
    """Pull-style gauge: cleared and re-populated each scrape by the endpoint."""

    def __init__(self, name, help_text, labelnames=()):
        super().__init__(name, help_text, labelnames)
        self._values: dict[_Labels, float] = {}

    def set(self, *labelvalues: str, value: float) -> None:
        self._values[self._key(labelvalues)] = value

    def clear(self) -> None:
        self._values.clear()

    def render(self) -> list[str]:
        lines = [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} gauge"]
        for labels, value in sorted(self._values.items()):
            lines.append(f"{self.name}{_label_str(self.labelnames, labels)} {value:g}")
        return lines


class Histogram(_Metric):
    def __init__(self, name, help_text, labelnames=(), buckets=LATENCY_BUCKETS_MS):
        super().__init__(name, help_text, labelnames)
        self.buckets = tuple(sorted(buckets))
        self._counts: dict[_Labels, list[int]] = defaultdict(
            lambda: [0] * len(self.buckets)
        )
        self._sum: dict[_Labels, float] = defaultdict(float)
        self._count: dict[_Labels, int] = defaultdict(int)

    def observe(self, *labelvalues: str, value: float) -> None:
        key = self._key(labelvalues)
        self._sum[key] += value
        self._count[key] += 1
        for i, bound in enumerate(self.buckets):
            if value <= bound:
                self._counts[key][i] += 1

    def render(self) -> list[str]:
        lines = [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} histogram"]
        for key in sorted(self._count):
            base = _label_str(self.labelnames, key)
            inner = base[1:-1] if base else ""  # strip braces to append le=
            # _counts already holds the cumulative count ≤ each bound
            for i, bound in enumerate(self.buckets):
                sep = "," if inner else ""
                lines.append(
                    f'{self.name}_bucket{{{inner}{sep}le="{bound:g}"}} '
                    f"{self._counts[key][i]}"
                )
            sep = "," if inner else ""
            lines.append(
                f'{self.name}_bucket{{{inner}{sep}le="+Inf"}} {self._count[key]}'
            )
            lines.append(f"{self.name}_sum{base} {self._sum[key]:g}")
            lines.append(f"{self.name}_count{base} {self._count[key]}")
        return lines


# --- module-level metric singletons (accumulated across requests) ----------

REQUESTS = Counter(
    "persona_twin_requests_total", "API requests handled", ("endpoint", "status")
)
LLM_REQUESTS = Counter(
    "persona_twin_llm_requests_total",
    "LLM completions by provider/model/task",
    ("provider", "model", "task"),
)
LLM_LATENCY_MS = Histogram(
    "persona_twin_llm_latency_ms",
    "LLM completion latency (ms)",
    ("provider", "model", "task"),
    LATENCY_BUCKETS_MS,
)
CIRCUIT_OPENS = Counter(
    "persona_twin_circuit_opens_total",
    "Circuit-breaker open events by target",
    ("target",),
)

_REGISTRY: list[_Metric] = [REQUESTS, LLM_REQUESTS, LLM_LATENCY_MS, CIRCUIT_OPENS]


def render(extra_lines: list[str] | None = None) -> str:
    """Render all registered metrics plus any scrape-time ``extra_lines``
    in Prometheus text exposition format (0.0.4)."""
    out: list[str] = []
    for metric in _REGISTRY:
        out.extend(metric.render())  # type: ignore[attr-defined]
    if extra_lines:
        out.extend(extra_lines)
    return "\n".join(out) + "\n"


def observe_llm(provider: str, model: str, task: str | None, latency_ms: float) -> None:
    """Record one successful LLM completion (count + latency)."""
    t = task or "none"
    if math.isfinite(latency_ms):
        LLM_LATENCY_MS.observe(provider, model, t, value=latency_ms)
    LLM_REQUESTS.inc(provider, model, t)
