"""SLIs / SLOs / error budget / **multi-window burn rate** — the canonical
Google-SRE error-budget alerting policy, as code.

Two SLOs over the current window:
  • availability — fraction of non-5xx requests; target 99.5%
  • latency      — fraction of requests under the latency target; target 95%

The error budget is the slack the availability SLO allows (1 − 0.995 = 0.5%).
*Burn rate* is how many times faster than sustainable the budget is being spent:
a burn rate of 1 spends the whole 30-day budget exactly over 30 days; 14.4×
spends it in ~2 days.

What makes this the real SRE policy (and distinct from a single burn number) is
**multi-window, multi-burn-rate** alerting (SRE Workbook ch. 5):

  • fast burn — 14.4× over a short window  → **page** (budget gone in ~2 days)
  • slow burn —  3× over a long window     → **ticket** (chronic erosion)

A page requires the burn to be high AND sustained (long+short window agree),
which is what kills the flapping pages a single threshold produces. The decision
is pure and deterministic so it tests and reproduces exactly.
"""

from __future__ import annotations

AVAILABILITY_SLO = 0.995
LATENCY_SLO = 0.95
ERROR_BUDGET = 1 - AVAILABILITY_SLO        # 0.005 — allowed error fraction

# Multi-burn-rate thresholds (SRE Workbook). Each tier pages/tickets only when the
# burn over BOTH a long and a short window clears the threshold — sustained, not a
# spike. The short window is 1/12 of the long, the standard ratio.
FAST_BURN = 14.4    # → page: at 14.4x the 30-day budget is gone in ~2 days
SLOW_BURN = 3.0     # → ticket: chronic erosion worth a tracked follow-up


def burn_rate(error_rate: float) -> float:
    """Instantaneous burn rate: error rate over the budget. 1.0 = sustainable."""
    return round(error_rate / ERROR_BUDGET, 2) if ERROR_BUDGET else 0.0


def alert_policy(long_error_rate: float, short_error_rate: float) -> dict:
    """The multiwindow, multi-burn-rate decision.

    ``long`` and ``short`` are the error rates over the long and short windows. We
    alert at a tier only when BOTH windows exceed that tier's threshold — the long
    window proves it is sustained, the short window proves it is still happening.

    Returns the chosen action (``page`` / ``ticket`` / ``none``) and per-tier
    detail so the dashboard and the runbook can show *why*.
    """
    long_burn = burn_rate(long_error_rate)
    short_burn = burn_rate(short_error_rate)
    fast = long_burn >= FAST_BURN and short_burn >= FAST_BURN
    slow = long_burn >= SLOW_BURN and short_burn >= SLOW_BURN
    action = "page" if fast else "ticket" if slow else "none"
    return {
        "action": action,
        "long_window_burn": long_burn,
        "short_window_burn": short_burn,
        "fast": {"threshold": FAST_BURN, "firing": fast},
        "slow": {"threshold": SLOW_BURN, "firing": slow},
    }


def compute(snap: dict, short_snap: dict | None = None) -> dict:
    """Turn a metrics snapshot into SLIs, error budget, and the burn-rate policy.

    ``snap`` is the long-window snapshot; ``short_snap`` is an optional short-window
    snapshot used for the multiwindow page decision. With no short window we treat
    the short burn as equal to the long one (single-window degrade) so the function
    is always usable.
    """
    total = snap["total"]
    error_rate = snap["error_rate"]
    consumed = (error_rate / ERROR_BUDGET) if ERROR_BUDGET else 0.0
    remaining = max(0.0, 1 - consumed)
    burn = burn_rate(error_rate)
    avail_sli = round(1 - error_rate, 6)

    if total == 0:
        avail_status = "no_data"
    elif avail_sli >= AVAILABILITY_SLO:
        avail_status = "healthy"
    elif remaining > 0:
        avail_status = "burning"
    else:
        avail_status = "exhausted"

    lat_sli = snap["fast_ratio"]
    lat_status = ("no_data" if total == 0
                  else "healthy" if lat_sli >= LATENCY_SLO else "violated")

    short_error_rate = (short_snap or snap)["error_rate"]
    policy = alert_policy(error_rate, short_error_rate)

    overall = ("healthy" if avail_status in ("healthy", "no_data")
               and lat_status in ("healthy", "no_data") else "at_risk")

    return {
        "window_requests": total,
        "availability": {
            "sli": avail_sli, "slo": AVAILABILITY_SLO,
            "error_budget": ERROR_BUDGET,
            "budget_consumed": round(min(1.0, consumed), 4),
            "budget_remaining": round(remaining, 4),
            "burn_rate": burn, "status": avail_status,
        },
        "latency": {
            "sli": round(lat_sli, 6), "slo": LATENCY_SLO,
            "target_ms": snap["latency_target_ms"], "p95_ms": snap["p95_ms"],
            "status": lat_status,
        },
        "burn_policy": policy,
        "overall_status": overall,
    }
