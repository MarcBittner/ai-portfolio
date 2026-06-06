"""Per-task routing policy, pins, OpenRouter availability, /routing API."""

import httpx
import pytest
from pydantic import ValidationError

from persona_twin.api.app import app, build_state
from persona_twin.config import Settings
from persona_twin.llm import (
    LLMRequest,
    LLMRouter,
    MockProvider,
    ModelRegistry,
    RoutingPolicy,
    TaskRoute,
)
from persona_twin.llm.policy import TASKS
from persona_twin.models import Chunk, ScoredChunk
from persona_twin.reranking.llm_rerank import LLMReranker

REGISTRY = ModelRegistry.from_yaml()


class TestPolicy:
    def test_defaults_inherit(self):
        policy = RoutingPolicy(default_objective="latency")
        assert policy.resolve_objective("twin_answer") == "latency"
        assert policy.resolve_pin("twin_answer") is None

    def test_task_overrides(self):
        policy = RoutingPolicy(
            default_objective="cost",
            tasks={
                "eval_judge": TaskRoute(objective="quality"),
                "twin_answer": TaskRoute(pin="anthropic:claude-haiku-4-5"),
            },
        )
        assert policy.resolve_objective("eval_judge") == "quality"
        assert policy.resolve_objective("rerank") == "cost"
        assert policy.resolve_pin("twin_answer") == ("anthropic", "claude-haiku-4-5")

    def test_unknown_task_rejected(self):
        with pytest.raises(ValidationError):
            RoutingPolicy(tasks={"nonsense": TaskRoute(objective="cost")})

    def test_malformed_pin_rejected(self):
        with pytest.raises(ValidationError):
            TaskRoute(pin="claude-haiku-4-5")  # missing provider:


class TestTaskAwareRouter:
    def make_router(self, policy=None):
        return LLMRouter(
            REGISTRY,
            {"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()},
            policy=policy,
        )

    def test_pin_jumps_queue_keeps_fallback_chain(self):
        policy = RoutingPolicy(
            default_objective="cost",
            tasks={"twin_answer": TaskRoute(pin="anthropic:claude-opus-4-8")},
        )
        plan = self.make_router(policy).plan(task="twin_answer")
        assert (plan[0].provider, plan[0].id) == ("anthropic", "claude-opus-4-8")
        assert len(plan) > 1  # fallback chain intact behind the pin
        assert plan[-1].provider == "mock"

    def test_unpinned_task_uses_task_objective(self):
        policy = RoutingPolicy(
            default_objective="cost", tasks={"eval_judge": TaskRoute(objective="quality")}
        )
        plan = self.make_router(policy).plan(task="eval_judge")
        assert plan[0].quality == 10

    def test_pin_to_unavailable_provider_is_ignored(self):
        policy = RoutingPolicy(
            tasks={"rerank": TaskRoute(pin="openrouter:deepseek/deepseek-chat")}
        )
        plan = self.make_router(policy).plan(task="rerank")  # openrouter not configured
        assert plan[0].provider != "openrouter"

    async def test_decision_records_task(self):
        router = LLMRouter(REGISTRY, {"mock": MockProvider()})
        _, decision = await router.complete(
            LLMRequest(system="s", user="Question: hi"), task="eval_judge"
        )
        assert decision.task == "eval_judge"


def test_openrouter_activates_from_env(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-placeholder")
    monkeypatch.delenv("PERSONA_TWIN_MOCK", raising=False)
    s = Settings(_env_file=None)
    assert "openrouter" in s.llm_backends
    assert {spec.provider for spec in REGISTRY.specs} >= {"openrouter"}


class TestLLMReranker:
    class PermutingRouter:
        """Stands in for LLMRouter: reverses candidate order."""

        async def complete_structured(self, request, output_model, task=None):
            assert task == "rerank"
            n = request.user.count("\n[")  # crude candidate count
            from persona_twin.reranking.llm_rerank import Ranking

            return Ranking(ranking=list(range(n + 1))[::-1]), None, None

    def chunk(self, i):
        return ScoredChunk(
            chunk=Chunk(
                chunk_id=f"d:fixed:{i:04d}",
                doc_id="d",
                persona_id="p",
                text=f"candidate {i}",
                strategy="fixed",
                char_span=(0, 10),
            ),
            score=1.0 - i / 10,
        )

    async def test_applies_model_ranking(self):
        candidates = [self.chunk(i) for i in range(3)]
        reranked = await LLMReranker(self.PermutingRouter()).rerank("q", candidates)
        assert [r.pre_rerank_rank for r in reranked] == [2, 1, 0]

    async def test_failure_falls_back_to_original_order(self):
        class FailingRouter:
            async def complete_structured(self, *a, **k):
                from persona_twin.llm.router import AllProvidersFailedError

                raise AllProvidersFailedError("boom")

        candidates = [self.chunk(i) for i in range(3)]
        reranked = await LLMReranker(FailingRouter()).rerank("q", candidates)
        assert [r.chunk.chunk_id for r in reranked] == [
            c.chunk.chunk_id for c in candidates
        ]


@pytest.fixture
async def client():
    app.state.twin = build_state(Settings(_env_file=None))
    async with (
        httpx.ASGITransport(app=app) as transport,
        httpx.AsyncClient(transport=transport, base_url="http://test") as client,
    ):
        yield client


class TestRoutingAPI:
    async def test_get_routing_shape(self, client):
        body = (await client.get("/routing")).json()
        assert body["tasks"] == list(TASKS)
        assert body["providers"]["mock"] is True
        assert body["providers"]["anthropic"] is False  # offline: not configured
        assert any(m["id"] == "claude-opus-4-8" for m in body["registry"])
        assert set(body["plans"]) == set(TASKS)
        assert body["plans"]["twin_answer"] == ["mock:mock-extractive-1"]

    async def test_put_routing_updates_policy_and_plans(self, client):
        new_policy = {
            "default_objective": "quality",
            "tasks": {"eval_judge": {"objective": "latency", "pin": None}},
        }
        response = await client.put("/routing", json=new_policy)
        assert response.status_code == 200
        body = response.json()
        assert body["policy"]["default_objective"] == "quality"
        # round-trips on GET
        again = (await client.get("/routing")).json()
        assert again["policy"]["tasks"]["eval_judge"]["objective"] == "latency"

    async def test_put_unknown_pin_rejected(self, client):
        response = await client.put(
            "/routing",
            json={"tasks": {"twin_answer": {"pin": "anthropic:claude-9000"}}},
        )
        assert response.status_code == 422

    async def test_put_unknown_task_rejected(self, client):
        response = await client.put(
            "/routing", json={"tasks": {"world_domination": {"objective": "cost"}}}
        )
        assert response.status_code == 422
