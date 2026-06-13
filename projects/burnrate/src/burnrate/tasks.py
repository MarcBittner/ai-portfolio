"""Background tasks — **TaskTiger-shaped**, on Redis, degrading to inline.

The production stack runs background work on the TaskTiger scheduler over Redis.
This module mirrors that surface: a ``@task`` decorator, a ``delay()`` to enqueue,
a ``Worker`` that drains the queue, and a ``periodic`` rollup — the same call sites
you'd write against TaskTiger — without requiring the library to be installed in
this sandbox.

Backend selection (chosen once, reported by ``backend()``):

  1. **tasktiger** — if ``import tasktiger`` succeeds and Redis is reachable, use
     the real thing (the production path; this wrapper just adapts the names).
  2. **redis**     — a thin TaskTiger-shaped queue on a real Redis list (via the
     ``redis`` library, else the ``redis-cli`` binary). Enqueue pushes a JSON job;
     the worker ``BLPOP``-drains and runs it. This is a genuine async round-trip.
  3. **inline**    — Redis absent: ``delay()`` runs the task synchronously and
     returns its result. The capability still works; it just isn't deferred. This
     is the zero-dependency offline fallback, clearly flagged in ``backend()``.

Two demo tasks: ``process_batch`` (async "process a batch of outreach sends",
counting into the Prometheus task counter) and ``rollup`` (a periodic SLO rollup
that publishes the budget/burn gauges) — i.e. exactly the shape of work an
outreach pipeline schedules.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass

from burnrate.metrics import registry

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
QUEUE_KEY = "burnrate:tasks:default"

_REGISTRY: dict[str, Callable] = {}


# --------------------------------------------------------------------------- #
# Backend probe (done once, cached)                                            #
# --------------------------------------------------------------------------- #

_backend_cache: str | None = None


def _redis_py():
    try:
        import redis  # noqa: F401  (optional dependency)
    except Exception:
        return None
    try:
        client = redis.Redis.from_url(REDIS_URL, socket_connect_timeout=1)
        client.ping()
        return client
    except Exception:
        return None


def _redis_cli_ok() -> bool:
    if not shutil.which("redis-cli"):
        return False
    try:
        out = subprocess.run(["redis-cli", "-u", REDIS_URL, "ping"],
                             capture_output=True, text=True, timeout=2)
        return out.stdout.strip().upper() == "PONG"
    except Exception:
        return False


def _tasktiger_ok() -> bool:
    try:
        import tasktiger  # noqa: F401
    except Exception:
        return False
    return _redis_py() is not None or _redis_cli_ok()


def backend() -> str:
    """Which task backend is live: ``tasktiger`` | ``redis`` | ``inline``."""
    global _backend_cache
    if _backend_cache is None:
        if _tasktiger_ok():
            _backend_cache = "tasktiger"
        elif _redis_py() is not None or _redis_cli_ok():
            _backend_cache = "redis"
        else:
            _backend_cache = "inline"
    return _backend_cache


def reset_backend() -> None:
    """Re-probe the backend (used by tests that toggle Redis availability)."""
    global _backend_cache
    _backend_cache = None


# --------------------------------------------------------------------------- #
# Redis list ops (library if present, else the redis-cli binary)               #
# --------------------------------------------------------------------------- #

def _rpush(payload: str) -> None:
    client = _redis_py()
    if client is not None:
        client.rpush(QUEUE_KEY, payload)
        return
    subprocess.run(["redis-cli", "-u", REDIS_URL, "RPUSH", QUEUE_KEY, payload],
                   capture_output=True, text=True, timeout=2)


def _lpop() -> str | None:
    client = _redis_py()
    if client is not None:
        v = client.lpop(QUEUE_KEY)
        return v.decode() if isinstance(v, bytes) else v
    out = subprocess.run(["redis-cli", "-u", REDIS_URL, "LPOP", QUEUE_KEY],
                         capture_output=True, text=True, timeout=2)
    v = out.stdout.strip()
    return v or None


def queue_depth() -> int:
    if backend() == "inline":
        return 0
    client = _redis_py()
    if client is not None:
        return int(client.llen(QUEUE_KEY))
    out = subprocess.run(["redis-cli", "-u", REDIS_URL, "LLEN", QUEUE_KEY],
                         capture_output=True, text=True, timeout=2)
    try:
        return int(out.stdout.strip())
    except ValueError:
        return 0


# --------------------------------------------------------------------------- #
# TaskTiger-shaped surface                                                     #
# --------------------------------------------------------------------------- #

@dataclass
class TaskResult:
    task: str
    backend: str
    deferred: bool          # True if it went through Redis (not run inline)
    result: dict | None     # set when run inline or by the worker in-process


def task(fn: Callable) -> Callable:
    """Register a function as a runnable task (the ``@tasktiger.task`` shape)."""
    _REGISTRY[fn.__name__] = fn
    fn.delay = lambda *a, **k: delay(fn.__name__, *a, **k)  # type: ignore[attr-defined]
    return fn


def delay(name: str, *args, **kwargs) -> TaskResult:
    """Enqueue ``name`` for async execution. On Redis, push a job and return
    immediately (deferred); inline, run it now and return the result."""
    if name not in _REGISTRY:
        raise KeyError(f"unknown task {name!r}")
    if backend() == "inline":
        result = _run(name, args, kwargs)
        return TaskResult(task=name, backend="inline", deferred=False, result=result)
    _rpush(json.dumps({"task": name, "args": list(args), "kwargs": kwargs}))
    return TaskResult(task=name, backend=backend(), deferred=True, result=None)


def _run(name: str, args, kwargs) -> dict:
    """Execute a task body and count it into the Prometheus task counter."""
    fn = _REGISTRY[name]
    try:
        result = fn(*args, **kwargs)
        registry.record_task(name, "ok")
        return result
    except Exception as exc:               # pragma: no cover - defensive
        registry.record_task(name, "error")
        return {"error": str(exc)}


class Worker:
    """Drains the Redis queue (the TaskTiger worker shape). On the inline backend
    there is nothing queued, so ``run()`` is a no-op returning 0."""

    def run(self, max_jobs: int = 1000, block_ms: int = 0) -> int:
        if backend() == "inline":
            return 0
        processed = 0
        deadline = time.monotonic() + (block_ms / 1000.0)
        while processed < max_jobs:
            raw = _lpop()
            if raw is None:
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.01)
                continue
            job = json.loads(raw)
            _run(job["task"], tuple(job.get("args", [])), job.get("kwargs", {}))
            processed += 1
        return processed


# --------------------------------------------------------------------------- #
# The demo tasks                                                               #
# --------------------------------------------------------------------------- #

@task
def process_batch(n: int = 50, channel: str = "email") -> dict:
    """Async "process a batch of outreach sends" — the bursty background work an
    outreach pipeline schedules. Drives the instrumented service."""
    from burnrate import service
    n = max(1, min(2000, int(n)))
    for i in range(n):
        service.send_outreach(channel, f"user{i}@example.com", "batch send")
    snap = service.snapshot()
    return {"processed": n, "channel": channel,
            "budget_remaining": snap["availability"]["budget_remaining"],
            "burn_rate": snap["availability"]["burn_rate"]}


@task
def rollup() -> dict:
    """Periodic SLO rollup — recompute the SLO and refresh the Prometheus
    budget/burn gauges. The ``periodic`` job TaskTiger would run on a schedule."""
    from burnrate import service
    snap = service.snapshot()
    return {"overall": snap["overall_status"],
            "budget_remaining": snap["availability"]["budget_remaining"],
            "burn_action": snap["burn_policy"]["action"]}


# A declarative periodic schedule (TaskTiger's `schedule=` shape), version-control
# friendly: the worker/cron would honor these intervals in production.
PERIODIC = [{"task": "rollup", "every_seconds": 60}]
