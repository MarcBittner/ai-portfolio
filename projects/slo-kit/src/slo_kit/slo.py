"""SLI / SLO / error-budget computation from a metrics snapshot.

Two SLOs over the current window:
  • availability — fraction of non-5xx requests; target 99.5%
  • latency      — fraction of requests under the latency target; target 95%

The error budget is the slack the availability SLO allows (1 − 0.995 = 0.5%).
Burn rate is how many times faster than sustainable the budget is being spent;
> 1× means the budget will be exhausted before the window resets.
"""

AVAILABILITY_SLO = 0.995
LATENCY_SLO = 0.95


def compute(snap: dict) -> dict:
    total = snap["total"]
    error_rate = snap["error_rate"]
    budget = 1 - AVAILABILITY_SLO                      # allowed error fraction
    consumed = (error_rate / budget) if budget else 0.0
    remaining = max(0.0, 1 - consumed)
    burn = round(error_rate / budget, 2) if budget else 0.0
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

    overall = ("healthy" if avail_status in ("healthy", "no_data")
               and lat_status in ("healthy", "no_data") else "at_risk")

    return {
        "window_requests": total,
        "availability": {
            "sli": avail_sli, "slo": AVAILABILITY_SLO,
            "error_budget": budget,
            "budget_consumed": round(min(1.0, consumed), 4),
            "budget_remaining": round(remaining, 4),
            "burn_rate": burn, "status": avail_status,
        },
        "latency": {
            "sli": round(lat_sli, 6), "slo": LATENCY_SLO,
            "target_ms": snap["latency_target_ms"], "p95_ms": snap["p95_ms"],
            "status": lat_status,
        },
        "overall_status": overall,
    }
