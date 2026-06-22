"""Rolling availability / error-rate / latency math over the probe time series.

The probes table is the source of truth; this module is the *deterministic*
reducer that turns raw rows into the numbers the dashboard and alerting consume.
Keeping the math here (not in the LLM, not in the UI) is the portfolio invariant:
**code decides** the status; the model only narrates it later.

- ``availability`` — fraction of the last N probes that were up.
- ``error_rate``   — its complement (fraction down), the guest-tier headline.
- ``response_ms``  — avg / p95 over the up probes in the window.
- ``status``       — up / degraded / down, derived from the latest probe + window.
"""

from __future__ import annotations

from vigil import config, store

# A target is "degraded" (not fully down) when it is currently up but the rolling
# availability has dipped below this — a soft signal the dashboard surfaces amber.
_DEGRADED_AVAILABILITY = 0.95


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    k = max(0, min(len(s) - 1, round((pct / 100) * (len(s) - 1))))
    return round(s[k], 1)


def summarize(slug: str, window: int | None = None) -> dict:
    """Rolling RED-style summary for one target over its last ``window`` probes."""
    window = window or config.ROLLING_WINDOW
    rows = store.recent_probes(slug, window)
    total = len(rows)
    if total == 0:
        return {
            "slug": slug, "status": "unknown", "samples": 0,
            "availability": None, "error_rate": None,
            "avg_response_ms": None, "p95_response_ms": None,
            "last_http_status": None, "last_probe_ts": None,
            "last_error": None,
        }
    up = sum(1 for r in rows if r["up"])
    availability = round(up / total, 4)
    error_rate = round(1 - availability, 4)
    up_latencies = [r["response_ms"] for r in rows
                    if r["up"] and r["response_ms"] is not None]
    avg_ms = round(sum(up_latencies) / len(up_latencies), 1) if up_latencies else None
    latest = rows[0]  # recent_probes returns newest-first

    if not latest["up"]:
        status = "down"
    elif availability < _DEGRADED_AVAILABILITY:
        status = "degraded"
    else:
        status = "up"

    return {
        "slug": slug,
        "status": status,
        "samples": total,
        "availability": availability,
        "error_rate": error_rate,
        "avg_response_ms": avg_ms,
        "p95_response_ms": _percentile(up_latencies, 95),
        "last_http_status": latest["http_status"],
        "last_response_ms": latest["response_ms"],
        "last_probe_ts": latest["ts"],
        "last_error": latest["error"],
    }


def fleet_summary() -> list[dict]:
    """One rolling summary per registered target — the dashboard's spine."""
    out = []
    for t in store.list_targets():
        s = summarize(t.slug)
        s["name"] = t.name
        s["url"] = t.url
        s["tags"] = t.tags
        s["self_monitor"] = t.self_monitor
        out.append(s)
    return out


def guest_view(rows: list[dict] | None = None) -> list[dict]:
    """The unauthenticated tier sees ONLY status + error rate per app — no history,
    no latency series, no logs. Enforced here by projecting the summary down to the
    minimal public shape so a guest endpoint can never leak more."""
    rows = rows if rows is not None else fleet_summary()
    return [
        {"slug": r["slug"], "name": r["name"], "status": r["status"],
         "error_rate": r["error_rate"], "self_monitor": r["self_monitor"]}
        for r in rows
    ]


def fleet_rollup(rows: list[dict] | None = None) -> dict:
    """Fleet-wide headline numbers for the incident summarizer + dashboard banner."""
    rows = rows if rows is not None else fleet_summary()
    known = [r for r in rows if r["status"] != "unknown"]
    down = [r["slug"] for r in rows if r["status"] == "down"]
    degraded = [r["slug"] for r in rows if r["status"] == "degraded"]
    avails = [r["availability"] for r in known if r["availability"] is not None]
    return {
        "targets_total": len(rows),
        "targets_reporting": len(known),
        "down": down,
        "degraded": degraded,
        "up": len([r for r in rows if r["status"] == "up"]),
        "fleet_availability": round(sum(avails) / len(avails), 4) if avails else None,
    }
