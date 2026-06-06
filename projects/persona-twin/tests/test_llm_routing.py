"""Registry ordering, router fallback, mock grounding, structured outputs."""

import json

import pytest
from pydantic import BaseModel

from persona_twin.config import Settings
from persona_twin.llm import (
    AllProvidersFailedError,
    LLMRequest,
    LLMResponse,
    LLMRouter,
    LLMUsage,
    MockProvider,
    ModelRegistry,
    get_router,
    schema_for,
)

REGISTRY = ModelRegistry.from_yaml()
ALL_PROVIDERS = ["anthropic", "openai", "mock"]

CONTEXT_PROMPT = """Answer using only this context.

[ada-quill/garden-journal:content_aware:0001] Repotted six tomato seedlings — \
the variety is Black Krim this year. Two bags of compost hauled up four flights.
[ada-quill/writing-routine:content_aware:0000] I write from 6:30 to 10:00 most \
mornings, longhand first drafts in spiral notebooks.

Question: What tomato variety is Ada growing this year?"""


class TwinAnswer(BaseModel):
    answer: str
    answered: bool
    citations: list[str]


class FailingProvider:
    name = "anthropic"

    async def complete(self, request, spec):
        raise TimeoutError("simulated provider outage")


class InvalidJSONOnceProvider:
    """Returns broken JSON on the first call, valid JSON afterwards."""

    name = "openai"

    def __init__(self):
        self.calls = 0

    async def complete(self, request, spec) -> LLMResponse:
        self.calls += 1
        text = (
            "{not json"
            if self.calls == 1
            else json.dumps({"answer": "Black Krim.", "answered": True, "citations": []})
        )
        return LLMResponse(
            text=text,
            provider=self.name,
            model=spec.id,
            usage=LLMUsage(input_tokens=10, output_tokens=5),
            latency_ms=1.0,
            cost_usd=0.0,
        )


class TestRegistry:
    def test_loads_all_providers(self):
        providers = {s.provider for s in REGISTRY.specs}
        assert providers == {"anthropic", "openai", "openrouter", "mock"}

    def test_anthropic_pricing_current(self):
        by_id = {s.id: s for s in REGISTRY.specs}
        assert by_id["claude-opus-4-8"].input_per_mtok == 5.00
        assert by_id["claude-opus-4-8"].output_per_mtok == 25.00
        assert by_id["claude-sonnet-4-6"].input_per_mtok == 3.00
        assert by_id["claude-haiku-4-5"].output_per_mtok == 5.00

    def test_cost_objective_picks_cheapest_real_model(self):
        plan = REGISTRY.candidates(ALL_PROVIDERS, "cost")
        assert plan[0].id == "gpt-5.4-nano"

    def test_quality_objective_picks_flagship(self):
        plan = REGISTRY.candidates(ALL_PROVIDERS, "quality")
        assert plan[0].quality == 10

    def test_latency_objective_picks_fastest(self):
        plan = REGISTRY.candidates(ALL_PROVIDERS, "latency")
        assert plan[0].id == "gpt-5.4-nano"
        assert plan[0].speed == 10

    def test_mock_is_always_terminal_fallback(self):
        for objective in ("cost", "latency", "quality"):
            plan = REGISTRY.candidates(ALL_PROVIDERS, objective)
            assert plan[-1].provider == "mock"
            assert all(s.provider != "mock" for s in plan[:-1])

    def test_mock_only_when_no_real_providers(self):
        plan = REGISTRY.candidates(["mock"], "cost")
        assert [s.provider for s in plan] == ["mock"]


class TestMockProvider:
    @pytest.fixture
    def request_(self):
        return LLMRequest(system="You are Ada.", user=CONTEXT_PROMPT)

    async def test_grounded_extractive_answer(self, request_):
        spec = REGISTRY.candidates(["mock"], "cost")[0]
        response = await MockProvider().complete(request_, spec)
        assert "Black Krim" in response.text
        assert response.cost_usd == 0.0

    async def test_structured_answer_cites_real_chunks(self, request_):
        spec = REGISTRY.candidates(["mock"], "cost")[0]
        req = request_.model_copy(update={"json_schema": schema_for(TwinAnswer)})
        response = await MockProvider().complete(req, spec)
        parsed = TwinAnswer.model_validate(json.loads(response.text))
        assert parsed.answered is True
        assert "Black Krim" in parsed.answer
        assert any("garden-journal" in c for c in parsed.citations)

    async def test_unanswerable_is_refused(self):
        req = LLMRequest(
            system="You are Ada.",
            user=CONTEXT_PROMPT.replace(
                "What tomato variety is Ada growing this year?",
                "What is Ada's opinion on quarterly derivatives rebalancing strategy?",
            ),
        )
        spec = REGISTRY.candidates(["mock"], "cost")[0]
        req = req.model_copy(update={"json_schema": schema_for(TwinAnswer)})
        parsed = TwinAnswer.model_validate(
            json.loads((await MockProvider().complete(req, spec)).text)
        )
        assert parsed.answered is False
        assert parsed.citations == []

    async def test_deterministic(self, request_):
        spec = REGISTRY.candidates(["mock"], "cost")[0]
        r1 = await MockProvider().complete(request_, spec)
        r2 = await MockProvider().complete(request_, spec)
        assert r1.text == r2.text


class TestRouter:
    async def test_failover_to_mock_records_reason(self):
        router = LLMRouter(
            REGISTRY,
            {"anthropic": FailingProvider(), "mock": MockProvider()},
            objective="quality",
        )
        response, decision = await router.complete(
            LLMRequest(system="s", user=CONTEXT_PROMPT)
        )
        assert response.provider == "mock"
        assert decision.provider == "mock"
        # all three anthropic models tried and failed before mock
        assert len(decision.fallbacks_taken) == 3
        assert all("TimeoutError" in f for f in decision.fallbacks_taken)

    async def test_structured_retry_on_invalid_json(self):
        flaky = InvalidJSONOnceProvider()
        router = LLMRouter(REGISTRY, {"openai": flaky}, objective="cost")
        parsed, _, decision = await router.complete_structured(
            LLMRequest(system="s", user="u"), TwinAnswer
        )
        assert flaky.calls == 2  # one retry
        assert parsed.answer == "Black Krim."

    async def test_all_failed_raises(self):
        router = LLMRouter(REGISTRY, {"anthropic": FailingProvider()}, objective="cost")
        with pytest.raises(AllProvidersFailedError):
            await router.complete(LLMRequest(system="s", user="u"))

    def test_cost_estimation(self):
        spec = next(s for s in REGISTRY.specs if s.id == "claude-sonnet-4-6")
        # 100k input + 10k output at $3/$15 per mtok
        assert spec.cost_usd(100_000, 10_000) == pytest.approx(0.45)


class TestFactory:
    def test_offline_settings_build_mock_only_router(self):
        router = get_router(Settings(_env_file=None))
        assert list(router.providers.keys()) == ["mock"]
        assert [s.provider for s in router.plan()] == ["mock"]


def test_schema_for_tightens_objects():
    schema = schema_for(TwinAnswer)
    assert schema["additionalProperties"] is False
