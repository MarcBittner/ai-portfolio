"""Circuit breaker behavior + Ollama embedder probe/fallback."""

import httpx
import pytest

from persona_twin.config import Settings
from persona_twin.embedding.base import get_embedder
from persona_twin.embedding.ollama_embed import OllamaEmbedder, _embed_url
from persona_twin.llm import LLMRequest, LLMRouter, MockProvider, ModelRegistry
from persona_twin.llm.breaker import CircuitBreaker, is_rate_limit

REGISTRY = ModelRegistry.from_yaml()


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class TestCircuitBreaker:
    def test_opens_after_threshold_and_recovers(self):
        clock = FakeClock()
        b = CircuitBreaker(failure_threshold=2, cooldown_s=60, clock=clock)
        b.record_failure("p:m")
        assert not b.is_open("p:m")  # one failure: still closed
        b.record_failure("p:m")
        assert b.is_open("p:m")
        clock.now += 61
        assert not b.is_open("p:m")  # half-open trial allowed
        b.record_failure("p:m")  # trial fails -> re-opens immediately
        assert b.is_open("p:m")
        clock.now += 61
        assert not b.is_open("p:m")
        b.record_success("p:m")  # trial succeeds -> fully closed
        b.record_failure("p:m")
        assert not b.is_open("p:m")  # back to needing the full threshold

    def test_rate_limit_opens_immediately_with_longer_cooldown(self):
        clock = FakeClock()
        b = CircuitBreaker(cooldown_s=60, rate_limit_cooldown_s=120, clock=clock)
        b.record_failure("p:m", rate_limited=True)
        assert b.is_open("p:m")
        clock.now += 61
        assert b.is_open("p:m")  # still cooling: 429 cooldown is longer
        clock.now += 60
        assert not b.is_open("p:m")

    def test_cooling_down_report(self):
        clock = FakeClock()
        b = CircuitBreaker(rate_limit_cooldown_s=120, clock=clock)
        b.record_failure("p:m", rate_limited=True)
        report = b.cooling_down()
        assert report == {"p:m": 120.0}

    def test_is_rate_limit_detection(self):
        class RateLimitError(Exception):
            pass

        class Boring(Exception):
            status_code = 500

        class By429(Exception):
            status_code = 429

        assert is_rate_limit(RateLimitError())
        assert is_rate_limit(By429())
        assert not is_rate_limit(Boring())


class FailNTimesProvider:
    name = "anthropic"

    def __init__(self, n: int):
        self.remaining = n
        self.calls = 0

    async def complete(self, request, spec):
        self.calls += 1
        if self.remaining > 0:
            self.remaining -= 1
            raise TimeoutError("down")
        from persona_twin.llm.base import LLMResponse, LLMUsage

        return LLMResponse(
            text="ok", provider=self.name, model=spec.id,
            usage=LLMUsage(input_tokens=1, output_tokens=1),
            latency_ms=1.0, cost_usd=0.0,
        )


class TestRouterWithBreaker:
    def make(self, provider, clock):
        return LLMRouter(
            REGISTRY,
            {"anthropic": provider, "mock": MockProvider()},
            objective="quality",
            breaker=CircuitBreaker(failure_threshold=2, cooldown_s=60, clock=clock),
        )

    async def test_open_circuits_are_skipped_not_retried(self):
        clock = FakeClock()
        provider = FailNTimesProvider(n=100)
        router = self.make(provider, clock)
        request = LLMRequest(system="s", user="Question: hi")

        # request 1: all three anthropic models fail (threshold not yet met per-model)
        await router.complete(request)
        calls_after_first = provider.calls
        # request 2: each model hits threshold 2 and opens
        await router.complete(request)
        # request 3: anthropic circuits open -> straight to mock, zero calls
        _, decision = await router.complete(request)
        assert provider.calls == calls_after_first * 2
        assert decision.provider == "mock"
        assert len(decision.skipped_cooldown) == 3
        assert decision.fallbacks_taken == []

    async def test_half_open_recovery(self):
        clock = FakeClock()
        provider = FailNTimesProvider(n=6)  # fails twice per model, then heals
        router = self.make(provider, clock)
        request = LLMRequest(system="s", user="Question: hi")
        await router.complete(request)
        await router.complete(request)  # circuits open
        clock.now += 61  # cooldown elapses -> half-open
        _, decision = await router.complete(request)
        assert decision.provider == "anthropic"  # trial call succeeded
        assert decision.skipped_cooldown == []

    async def test_all_open_still_tries_degraded(self):
        clock = FakeClock()
        provider = FailNTimesProvider(n=3)  # all three models fail once, then heal
        router = LLMRouter(
            REGISTRY,
            {"anthropic": provider},
            objective="quality",
            breaker=CircuitBreaker(failure_threshold=1, cooldown_s=60, clock=clock),
        )
        request = LLMRequest(system="s", user="Question: hi")
        # opens all circuits it touches
        from persona_twin.llm import AllProvidersFailedError

        with pytest.raises(AllProvidersFailedError):
            await router.complete(request)
        # all candidates cooling — pass 2 tries them anyway and succeeds
        _, decision = await router.complete(request)
        assert decision.provider == "anthropic"
        assert decision.skipped_cooldown  # routed despite open circuits


OLLAMA_EMBED_RESPONSE = {"embeddings": [[0.1] * 768]}


class TestOllamaEmbedder:
    def test_embed_url(self):
        assert _embed_url("http://x:11434") == "http://x:11434/api/embed"
        assert _embed_url("http://x:11434/v1") == "http://x:11434/api/embed"

    def test_probe_learns_dimensions(self, monkeypatch):
        def fake_post(url, json, timeout):
            return httpx.Response(
                200, json=OLLAMA_EMBED_RESPONSE, request=httpx.Request("POST", url)
            )

        monkeypatch.setattr(httpx, "post", fake_post)
        embedder = OllamaEmbedder("http://x:11434")
        assert embedder.dimensions == 768
        assert embedder.name == "ollama"

    def test_factory_falls_back_to_hash_when_unreachable(self, monkeypatch):
        def fake_post(url, json, timeout):
            raise httpx.ConnectError("refused")

        monkeypatch.setattr(httpx, "post", fake_post)
        embedder = get_embedder(
            Settings(_env_file=None, ollama_base_url="http://x:11434")
        )
        assert embedder.name == "hash"

    def test_backend_priority(self, monkeypatch):
        for var in ("OPENAI_API_KEY", "PERSONA_TWIN_MOCK", "OLLAMA_BASE_URL"):
            monkeypatch.delenv(var, raising=False)
        assert Settings(_env_file=None).embedding_backend == "hash"
        assert (
            Settings(_env_file=None, ollama_base_url="http://x").embedding_backend
            == "ollama"
        )
        monkeypatch.setenv("OPENAI_API_KEY", "test-placeholder")
        assert (
            Settings(_env_file=None, ollama_base_url="http://x").embedding_backend
            == "openai"
        )
