"""Benchmark harness: pinned isolation, scorecards, API lifecycle."""

import asyncio

import httpx
import pytest

from persona_twin.api.app import app, build_state
from persona_twin.config import Settings
from persona_twin.eval.benchmark import (
    BenchmarkContext,
    BenchmarkRun,
    _judge_pairs,
    _pinned_router,
    _sample,
    run_benchmark,
)
from persona_twin.eval.dataset import load_eval_dataset
from persona_twin.llm import LLMRequest, ModelRegistry
from persona_twin.llm.router import AllProvidersFailedError


class FailingProvider:
    name = "anthropic"

    async def complete(self, request, spec):
        raise TimeoutError("down")


def mock_spec():
    return next(s for s in ModelRegistry.from_yaml().specs if s.provider == "mock")


@pytest.fixture
async def ctx():
    state = build_state(Settings(_env_file=None))
    from persona_twin.chunking import get_chunker
    from persona_twin.pipeline import ingest_corpus

    await ingest_corpus(
        get_chunker("content_aware"), state.embedder, state.store, records=state.records
    )
    return BenchmarkContext(
        personas=state.personas,
        records=state.records,
        items=load_eval_dataset(),
        embedder=state.embedder,
        store=state.store,
        providers=state.router.providers,
    )


class TestIsolation:
    async def test_pinned_router_has_no_fallback(self):
        spec = mock_spec().model_copy(update={"provider": "anthropic"})
        router = _pinned_router(spec, {"anthropic": FailingProvider()})
        with pytest.raises(AllProvidersFailedError):
            await router.complete(LLMRequest(system="s", user="u"))

    def test_sample_includes_unanswerables(self):
        sample = _sample(load_eval_dataset(), limit=6)
        assert sum(1 for i in sample if i.answerable) == 6
        assert any(not i.answerable for i in sample)


class TestJudgePairs:
    def test_pairs_balanced_and_cross_persona(self, ctx):
        sample = _sample(ctx.items, limit=4)
        pairs = _judge_pairs(ctx, sample)
        answerable = sum(1 for i in sample if i.answerable)
        assert len(pairs) == 2 * answerable
        assert sum(1 for _, _, expected in pairs if expected) == answerable


class TestRunBenchmark:
    async def test_mock_full_run(self, ctx):
        run = BenchmarkRun()
        await run_benchmark(
            ctx, run, [mock_spec()],
            ["twin_answer", "rerank", "eval_judge"], items_limit=4,
        )
        assert run.status == "completed"
        assert run.progress_done == run.progress_total
        tasks = {(r.task, r.provider, r.model) for r in run.results}
        assert ("twin_answer", "mock", "mock-extractive-1") in tasks
        assert ("rerank", "baseline", "none") in tasks
        assert ("rerank", "baseline", "lexical") in tasks
        assert ("eval_judge", "mock", "mock-extractive-1") in tasks
        for r in run.results:
            for value in r.metrics.values():
                assert 0.0 <= value <= 1.0

    async def test_failing_model_records_errors_not_fallback(self, ctx):
        spec = mock_spec().model_copy(update={"provider": "anthropic", "id": "fake"})
        ctx2 = ctx.model_copy(update={"providers": {"anthropic": FailingProvider()}})
        run = BenchmarkRun()
        await run_benchmark(ctx2, run, [spec], ["twin_answer"], items_limit=3)
        assert run.status == "completed"
        result = run.results[0]
        assert result.errors == result.n > 0
        assert result.metrics["fact_presence"] == 0.0


@pytest.fixture
async def client(tmp_path):
    from persona_twin.eval.bench_store import BenchmarkStore

    app.state.twin = build_state(Settings(_env_file=None))
    from persona_twin.chunking import get_chunker
    from persona_twin.pipeline import ingest_corpus

    state = app.state.twin
    state.bench_store = BenchmarkStore(tmp_path)  # never touch ./benchmarks
    await ingest_corpus(
        get_chunker("content_aware"), state.embedder, state.store, records=state.records
    )
    async with (
        httpx.ASGITransport(app=app) as transport,
        httpx.AsyncClient(transport=transport, base_url="http://test") as client,
    ):
        yield client


class TestBenchmarkAPI:
    async def test_lifecycle(self, client):
        idle = (await client.get("/benchmark")).json()
        assert idle["status"] == "idle"

        started = await client.post("/benchmark", json={"items_limit": 3})
        assert started.status_code == 202

        for _ in range(100):
            body = (await client.get("/benchmark")).json()
            if body["status"] in ("completed", "failed"):
                break
            await asyncio.sleep(0.1)
        assert body["status"] == "completed"
        assert body["results"]
        assert {r["task"] for r in body["results"]} == {
            "twin_answer", "rerank", "eval_judge", "embedding",
        }
        emb = [r for r in body["results"] if r["task"] == "embedding"]
        assert {(r["provider"], r["model"]) for r in emb} == {
            ("hash", "vector"), ("hash", "hybrid"),
        }

    async def test_running_guard_409(self, client):
        app.state.twin.benchmark = BenchmarkRun(status="running")
        response = await client.post("/benchmark", json={})
        assert response.status_code == 409
        app.state.twin.benchmark = BenchmarkRun()

    async def test_unknown_model_422(self, client):
        response = await client.post(
            "/benchmark", json={"models": ["anthropic:claude-9000"]}
        )
        assert response.status_code == 422


class TestStopAndPersistence:
    async def test_stop_running_benchmark_keeps_partials(self, client, tmp_path):
        from persona_twin.eval.bench_store import BenchmarkStore

        state = app.state.twin
        state.bench_store = BenchmarkStore(tmp_path)

        class SlowProvider:
            name = "anthropic"

            async def complete(self, request, spec):
                await asyncio.sleep(30)
                raise AssertionError("should have been cancelled")

        state.router.providers["anthropic"] = SlowProvider()
        started = await client.post(
            "/benchmark",
            json={
                # mock first (finishes instantly), then the slow model
                "models": ["mock:mock-extractive-1", "anthropic:claude-opus-4-8"],
                "tasks": ["twin_answer"],
                "items_limit": 2,
            },
        )
        assert started.status_code == 202
        await asyncio.sleep(0.3)  # mock result lands; slow model in flight

        stopped = await client.post("/benchmark/stop")
        assert stopped.status_code == 200
        for _ in range(50):
            body = (await client.get("/benchmark")).json()
            if body["status"] == "stopped":
                break
            await asyncio.sleep(0.1)
        assert body["status"] == "stopped"
        assert any(r["provider"] == "mock" for r in body["results"])  # partials kept
        # persisted with partial results
        history = (await client.get("/benchmark/history")).json()
        assert history and history[0]["status"] == "stopped"
        del state.router.providers["anthropic"]

    async def test_stop_when_idle_409(self, client):
        assert (await client.post("/benchmark/stop")).status_code == 409

    async def test_history_roundtrip(self, client, tmp_path):
        from persona_twin.eval.bench_store import BenchmarkStore

        app.state.twin.bench_store = BenchmarkStore(tmp_path)
        await client.post("/benchmark", json={"items_limit": 2, "tasks": ["eval_judge"]})
        for _ in range(100):
            body = (await client.get("/benchmark")).json()
            if body["status"] == "completed":
                break
            await asyncio.sleep(0.1)
        history = (await client.get("/benchmark/history")).json()
        assert len(history) == 1
        run_id = history[0]["run_id"]
        assert history[0]["tasks"] == ["eval_judge"]
        full = (await client.get(f"/benchmark/history/{run_id}")).json()
        assert full["run_id"] == run_id
        assert full["results"]
        assert (await client.get("/benchmark/history/nope")).status_code == 404
        assert (await client.get("/benchmark/history/..%2Fetc")).status_code == 404


class TestIncrementalAggregate:
    async def test_skip_existing_and_force_rerun(self, client, tmp_path):
        from persona_twin.eval.bench_store import BenchmarkStore

        app.state.twin.bench_store = BenchmarkStore(tmp_path)

        async def run_and_wait(payload):
            response = await client.post("/benchmark", json=payload)
            if response.status_code != 202:
                return response, None
            for _ in range(100):
                body = (await client.get("/benchmark")).json()
                if body["status"] in ("completed", "failed"):
                    return response, body
                await asyncio.sleep(0.1)
            raise AssertionError("benchmark did not finish")

        # first run populates the aggregate
        _, body = await run_and_wait({"tasks": ["eval_judge"], "items_limit": 2})
        assert body["status"] == "completed"
        first_run_id = body["run_id"]

        agg = (await client.get("/benchmark/aggregate")).json()
        assert [(e["task"], e["provider"]) for e in agg] == [("eval_judge", "mock")]

        # same selection again without force -> nothing to run
        response = await client.post(
            "/benchmark", json={"tasks": ["eval_judge"], "items_limit": 2}
        )
        assert response.status_code == 409

        # widening the selection runs ONLY the missing combos
        _, body = await run_and_wait(
            {"tasks": ["eval_judge", "twin_answer"], "items_limit": 2}
        )
        assert body["status"] == "completed"
        assert {r["task"] for r in body["results"]} == {"twin_answer"}  # judge skipped

        # force reruns and the aggregate points at the newest run
        _, body = await run_and_wait(
            {"tasks": ["eval_judge"], "items_limit": 2, "force": True}
        )
        assert body["status"] == "completed"
        agg = (await client.get("/benchmark/aggregate")).json()
        judge = next(e for e in agg if e["task"] == "eval_judge")
        assert judge["run_id"] == body["run_id"] != first_run_id
        assert len(agg) == 2  # latest-wins, no duplicates
