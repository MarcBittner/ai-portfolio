"""TaskTiger-shaped background tasks: the job runs, with an inline fallback when
Redis is absent."""

from burnrate import service, tasks


def test_backend_is_one_of_known():
    assert tasks.backend() in ("tasktiger", "redis", "inline")


def test_process_batch_runs_and_drives_service():
    service.reset()
    res = tasks.process_batch.delay(n=120)
    if res.deferred:
        # Redis-backed: the job is queued; a worker must drain it.
        drained = tasks.Worker().run(max_jobs=10, block_ms=1000)
        assert drained == 1
    else:
        # inline: ran synchronously, result available immediately.
        assert res.backend == "inline"
        assert res.result["processed"] == 120
    snap = service.snapshot()
    assert snap["window_requests"] == 120
    service.reset()


def test_rollup_periodic_task():
    service.reset()
    service.loadtest(50)
    res = tasks.rollup.delay()
    if res.deferred:
        tasks.Worker().run(max_jobs=10, block_ms=1000)
    else:
        assert res.result["overall"] == "healthy"
    assert any(p["task"] == "rollup" for p in tasks.PERIODIC)
    service.reset()


def test_inline_fallback_when_redis_unreachable(monkeypatch):
    """Force the no-Redis path and assert delay() runs the task synchronously."""
    monkeypatch.setattr(tasks, "_redis_py", lambda: None)
    monkeypatch.setattr(tasks, "_redis_cli_ok", lambda: False)
    monkeypatch.setattr(tasks, "_tasktiger_ok", lambda: False)
    tasks.reset_backend()
    try:
        assert tasks.backend() == "inline"
        service.reset()
        res = tasks.process_batch.delay(n=30)
        assert res.deferred is False
        assert res.backend == "inline"
        assert res.result["processed"] == 30
        # the worker is a no-op when there is no queue
        assert tasks.Worker().run() == 0
    finally:
        tasks.reset_backend()
        service.reset()


def test_unknown_task_raises():
    import pytest
    with pytest.raises(KeyError):
        tasks.delay("nope")
