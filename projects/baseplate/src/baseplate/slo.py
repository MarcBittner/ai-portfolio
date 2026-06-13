"""SLO view for the example ingest+serve workload.

A compact, Datadog-style SLO set with computed error budgets and a burn-rate
table. The data-quality pass rate from ``ingest.py`` feeds the data-quality SLO
so the API can show a live SLI -> SLO -> error-budget chain. Full narrative
(why these, multi-window burn-rate alerting) lives in docs/observability.md.
"""

from __future__ import annotations

from baseplate import ingest

WINDOW_DAYS = 30
WINDOW_MINUTES = WINDOW_DAYS * 24 * 60


def _budget(objective: float) -> dict:
    """Error budget for an objective over the 30d window."""
    allowed_fraction = round(1 - objective / 100, 6)
    return {
        "objective_pct": objective,
        "error_budget_pct": round(allowed_fraction * 100, 4),
        "error_budget_minutes_30d": round(allowed_fraction * WINDOW_MINUTES, 1),
    }


def view() -> dict:
    """The SLO dashboard payload, with the data-quality SLI plugged in live."""
    dq = ingest.score()
    dq_attainment = round(dq["data_quality_pass_rate"] * 100, 2)
    slos = [
        {
            "name": "availability",
            "sli": "ratio of non-5xx responses",
            **_budget(99.5),
        },
        {
            "name": "ingest-freshness",
            "sli": "ratio of feeds ingested within the freshness window",
            **_budget(99.0),
        },
        {
            "name": "api-latency-p99",
            "sli": "p99 request latency < 300ms",
            **_budget(99.0),
        },
        {
            "name": "data-quality",
            "sli": "ratio of ingested rows passing schema validation",
            **_budget(98.0),
            "current_sli_pct": dq_attainment,
            "meeting_objective": dq_attainment >= 98.0,
        },
    ]
    return {
        "service": "rate-ingest",
        "window_days": WINDOW_DAYS,
        "slos": slos,
        "burn_rate_alerts": [
            {"window": "1h", "threshold": 14.4, "action": "page (fast burn)"},
            {"window": "6h", "threshold": 6.0, "action": "ticket (slow burn)"},
        ],
    }
