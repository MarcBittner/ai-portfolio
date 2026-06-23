"""The background prober: hit every target's /health, record up/down/latency.

A single asyncio loop (no APScheduler dependency — the portfolio favours stdlib +
the few deps it already ships) probes all registered targets every
``POLL_INTERVAL_S`` seconds. Each probe is one HTTP GET against the target's
health URL with a tight timeout; the result (up/down, HTTP status, response time,
error) lands in the ``probes`` time series. After persisting, it re-derives the
rolling summary and hands it to the alerting engine, so a freshly-crossed
threshold fires immediately rather than waiting for a dashboard load.

vigil probes its *own* health URL like any other target (the seed registry's
``self_monitor`` entry), so self-monitoring is the same code path, not a special
case — the response times and up/down you see for vigil are real probe results.
"""

from __future__ import annotations

import asyncio
import contextlib
import time

import httpx

from vigil import (
    alerts,
    checks,
    config,
    metrics,
    promparse,
    selflog,
    selfmetrics,
    store,
)


def _legacy_health_probe(target) -> dict:
    """Fallback for a target with no checks: the original single /health GET
    (status 200–399 = up). Synchronous; run in a thread by the async caller."""
    t0 = time.monotonic()
    up = False
    http_status: int | None = None
    error: str | None = None
    response_ms: float | None = None
    try:
        with httpx.Client(timeout=config.PROBE_TIMEOUT_S) as client:
            resp = client.get(target.health_url, follow_redirects=True)
        response_ms = round((time.monotonic() - t0) * 1000, 1)
        http_status = resp.status_code
        up = 200 <= resp.status_code < 400
        if not up:
            error = f"HTTP {resp.status_code}"
    except httpx.TimeoutException:
        response_ms = round((time.monotonic() - t0) * 1000, 1)
        error = "timeout"
    except Exception as exc:  # noqa: BLE001 — any transport error is a 'down' sample
        error = type(exc).__name__
    return {"up": up, "http_status": http_status,
            "response_ms": response_ms, "error": error}


def _probe_target_sync(target) -> dict:
    """Run a target's enabled checks, record one ``check_results`` row per check,
    and roll them up into the target's status. Never raises — a failure (transport
    or assertion) is a 'down' sample, which is exactly what a monitor records.

    ``up`` = **all REQUIRED checks passed**. A target with no checks falls back to
    the legacy single /health GET so behavior is preserved end-to-end.
    """
    selfmetrics.inc("vigil_probes_total")
    enabled = store.list_checks(target.slug, enabled_only=True)
    if not enabled:
        res = _legacy_health_probe(target)
        store.record_probe(target.slug, res["up"], res["http_status"],
                           res["response_ms"], res["error"])
        return {"slug": target.slug, "checks": 0, **res}

    required_total = 0
    required_passed = 0
    last_status: int | None = None
    last_ms: float | None = None
    errors: list[str] = []
    for chk in enabled:
        r = checks.run_check(chk, target.url)
        store.record_check_result(
            chk["id"], target.slug, r["passed"], r["http_status"],
            r["response_ms"], r["error"], r["detail"],
        )
        selfmetrics.inc(
            "vigil_checks_passed_total" if r["passed"] else "vigil_checks_failed_total"
        )
        # Roll up the last observed status/latency for the probe time series.
        if r["http_status"] is not None:
            last_status = r["http_status"]
        if r["response_ms"] is not None:
            last_ms = r["response_ms"]
        if chk["required"]:
            required_total += 1
            if r["passed"]:
                required_passed += 1
            else:
                detail = r["error"] or _first_failed_detail(r)
                errors.append(f"{chk['name']}: {detail}")

    up = required_total == 0 or required_passed == required_total
    error = None if up else "; ".join(errors) or "required check failed"
    store.record_probe(target.slug, up, last_status, last_ms, error)
    return {"slug": target.slug, "up": up, "http_status": last_status,
            "response_ms": last_ms, "error": error, "checks": len(enabled),
            "required_passed": required_passed, "required_total": required_total}


def _scrape_metrics_sync(target) -> int:
    """Best-effort scrape of a target's metrics path (Prometheus text). Returns the
    number of samples stored (0 if the target exposes none / 404s / errors). Never
    raises — a metrics failure must not affect the health poll.

    A non-2xx response, a non-text body, or an unparseable payload all yield 0 and
    are silently skipped: not every app exposes ``/metrics``, and that's fine."""
    url = target.metrics_url
    try:
        with httpx.Client(timeout=config.PROBE_TIMEOUT_S) as client:
            resp = client.get(url, follow_redirects=True)
        if resp.status_code != 200:
            return 0
        ctype = resp.headers.get("content-type", "")
        # Prometheus serves text/plain; reject obvious HTML error pages early.
        if "html" in ctype.lower():
            return 0
        samples = promparse.parse(resp.text)
        if not samples:
            return 0
        stored = store.record_metrics(target.slug, time.time(), samples)
        if stored:
            selfmetrics.inc("vigil_metrics_scraped_total", stored)
        return stored
    except Exception:  # noqa: BLE001 — any scrape failure is just "no metrics"
        return 0


async def scrape_metrics(target) -> int:
    """Async wrapper running the synchronous scrape in a worker thread."""
    return await asyncio.to_thread(_scrape_metrics_sync, target)


def _first_failed_detail(result: dict) -> str:
    """Pull the first failing assertion's detail from a run_check result."""
    for r in (result.get("detail") or {}).get("results", []):
        if not r.get("ok"):
            return r.get("detail") or "assertion failed"
    return "check failed"


async def probe_one(client: httpx.AsyncClient, target) -> dict:
    """Async wrapper: run a target's checks in a worker thread (the check runner is
    synchronous httpx) so the poll cycle stays concurrent. ``client`` is unused but
    kept for signature compatibility with the existing call sites."""
    return await asyncio.to_thread(_probe_target_sync, target)


async def probe_all() -> list[dict]:
    """Probe every registered target once (concurrently), scrape any exposed app
    metrics, and evaluate alerts. Records vigil's own cycle metrics + self-logs so
    self-monitoring covers logs/metrics, not just uptime."""
    t0 = time.monotonic()
    targets = store.list_targets()
    results: list[dict] = []
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*(probe_one(client, t) for t in targets))
    # Scrape app metrics concurrently (best-effort; a 404/HTML/parse-miss is 0).
    scraped = await asyncio.gather(*(scrape_metrics(t) for t in targets))
    # Alerts run off the freshly-updated rolling summary so a just-crossed
    # threshold fires this cycle.
    fired = 0
    for t in targets:
        events = alerts.evaluate(t.slug, metrics.summarize(t.slug))
        fired += len(events)
        for ev in events:
            selflog.slog("warn", f"alert fired for {t.slug}: {ev['message']}",
                         source="vigil.alerts", slug=t.slug, channel=ev["channel"])
    selfmetrics.inc("vigil_alerts_fired_total", fired)
    selfmetrics.inc("vigil_poll_cycles_total")
    duration = round(time.monotonic() - t0, 3)
    selfmetrics.set_gauge("vigil_last_poll_duration_seconds", duration)
    down = [r["slug"] for r in results if not r.get("up")]
    selflog.slog(
        "info" if not down else "warn",
        f"poll cycle complete: {len(targets)} targets, "
        f"{sum(scraped)} metric samples scraped, {fired} alert(s) fired"
        + (f", down: {', '.join(down)}" if down else ""),
        source="vigil.probe",
        targets=len(targets), down=len(down), scraped=int(sum(scraped)),
        duration_s=duration,
    )
    return list(results)


async def poller_loop(stop: asyncio.Event) -> None:
    """The forever loop. One immediate probe on startup so the dashboard is never
    blank, then every POLL_INTERVAL_S until asked to stop."""
    while not stop.is_set():
        with contextlib.suppress(Exception):  # the loop must outlive any one cycle
            await probe_all()
        # Sleep until the interval elapses or we're asked to stop, whichever first.
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=config.POLL_INTERVAL_S)
