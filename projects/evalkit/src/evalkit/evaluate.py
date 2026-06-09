"""Evaluation, regression gating, and run comparison over metric scores.

Pure functions over ``(prediction, reference)`` pairs so they're trivially
testable; the API layer wraps them. A *gate* turns aggregate scores into a
pass/fail against per-metric thresholds (the basis for CI regression
checks); *compare* diffs two aggregate runs (e.g. model A vs model B).
"""

from statistics import fmean

from evalkit.metrics import METRIC_NAMES, score

_EPS = 1e-9


def evaluate(
    items: list[tuple[str, str]], metrics: list[str] | None = None
) -> tuple[list[dict[str, float]], dict[str, float]]:
    """Score each ``(prediction, reference)`` pair across ``metrics``.

    Returns ``(per_item, aggregate)`` where per_item[i] maps metric→score and
    aggregate maps metric→mean. Unknown metric names raise ``ValueError``."""
    metrics = list(metrics) if metrics else list(METRIC_NAMES)
    unknown = [m for m in metrics if m not in METRIC_NAMES]
    if unknown:
        raise ValueError(f"unknown metrics: {unknown}; valid: {METRIC_NAMES}")
    per_item = [{m: score(m, pred, ref) for m in metrics} for pred, ref in items]
    if per_item:
        aggregate = {m: round(fmean(r[m] for r in per_item), 4) for m in metrics}
    else:
        aggregate = {m: 0.0 for m in metrics}
    return per_item, aggregate


def gate(
    aggregate: dict[str, float], thresholds: dict[str, float]
) -> tuple[bool, dict[str, dict[str, float]]]:
    """Pass/fail: every threshold metric must meet its minimum. Returns
    ``(passed, failures)`` where failures maps metric→{score, min}."""
    failures = {
        m: {"score": aggregate.get(m, 0.0), "min": minimum}
        for m, minimum in thresholds.items()
        if aggregate.get(m, 0.0) + _EPS < minimum
    }
    return (not failures), failures


def compare(
    baseline: dict[str, float], candidate: dict[str, float]
) -> dict[str, dict[str, float | None]]:
    """Per-metric ``{baseline, candidate, delta}`` for two aggregate runs."""
    metrics = sorted(set(baseline) | set(candidate))
    return {
        m: {
            "baseline": baseline.get(m),
            "candidate": candidate.get(m),
            "delta": round(candidate.get(m, 0.0) - baseline.get(m, 0.0), 4),
        }
        for m in metrics
    }
