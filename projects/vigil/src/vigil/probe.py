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

from vigil import alerts, config, metrics, store


async def probe_one(client: httpx.AsyncClient, target) -> dict:
    """Probe a single target's health URL. Never raises — a failure is a 'down'
    data point, which is exactly what a monitor must record."""
    t0 = time.monotonic()
    up = False
    http_status: int | None = None
    error: str | None = None
    response_ms: float | None = None
    try:
        resp = await client.get(target.health_url, timeout=config.PROBE_TIMEOUT_S,
                                follow_redirects=True)
        response_ms = round((time.monotonic() - t0) * 1000, 1)
        http_status = resp.status_code
        # Any 2xx/3xx liveness response counts as up; 4xx/5xx is down.
        up = 200 <= resp.status_code < 400
        if not up:
            error = f"HTTP {resp.status_code}"
    except httpx.TimeoutException:
        response_ms = round((time.monotonic() - t0) * 1000, 1)
        error = "timeout"
    except Exception as exc:  # noqa: BLE001 — any transport error is a 'down' sample
        error = type(exc).__name__
    store.record_probe(target.slug, up, http_status, response_ms, error)
    return {"slug": target.slug, "up": up, "http_status": http_status,
            "response_ms": response_ms, "error": error}


async def probe_all() -> list[dict]:
    """Probe every registered target once (concurrently) and evaluate alerts."""
    targets = store.list_targets()
    results: list[dict] = []
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*(probe_one(client, t) for t in targets))
    # Alerts run off the freshly-updated rolling summary so a just-crossed
    # threshold fires this cycle.
    for t in targets:
        alerts.evaluate(t.slug, metrics.summarize(t.slug))
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
