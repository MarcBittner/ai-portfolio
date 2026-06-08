"""Objective-aware router with provider fallback and validated
structured outputs.

The router orders candidate models from the registry by the requested
objective (``cost`` / ``latency`` / ``quality``), tries them in order,
and records every failover with its reason. The mock provider is the
guaranteed-terminal fallback, so a request can degrade but never die
with an empty hand.
"""

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass

from pydantic import BaseModel, ValidationError

from persona_twin.config import RouteObjective
from persona_twin.llm.base import LLMProvider, LLMRequest, LLMResponse, LLMUsage, ModelSpec
from persona_twin.llm.breaker import CircuitBreaker, is_rate_limit
from persona_twin.llm.policy import RoutingPolicy
from persona_twin.llm.registry import ModelRegistry
from persona_twin.log import get_logger, kv
from persona_twin.models import RoutingDecision

logger = get_logger("llm.router")


class AllProvidersFailedError(RuntimeError):
    pass


@dataclass
class StreamEvent:
    """One item from ``stream_complete``: a prose ``delta`` while generating,
    then a single terminal event carrying the accumulated ``response`` and the
    ``decision``. ``done`` distinguishes the terminal event."""

    delta: str = ""
    response: LLMResponse | None = None
    decision: RoutingDecision | None = None

    @property
    def done(self) -> bool:
        return self.decision is not None


def schema_for(model_cls: type[BaseModel]) -> dict:
    """Pydantic JSON schema tightened for strict structured outputs
    (every object level gets ``additionalProperties: false``)."""

    def tighten(node: dict) -> None:
        if node.get("type") == "object":
            node.setdefault("additionalProperties", False)
        for sub in node.get("properties", {}).values():
            tighten(sub)
        if "items" in node and isinstance(node["items"], dict):
            tighten(node["items"])
        for sub in node.get("$defs", {}).values():
            tighten(sub)

    schema = model_cls.model_json_schema()
    tighten(schema)
    return schema


async def _provider_stream(
    provider: LLMProvider, request: LLMRequest, spec: ModelSpec
) -> AsyncIterator[str]:
    """Adapt any provider to a text-delta stream. Providers exposing a native
    ``stream`` use it; the rest degrade to a single delta from ``complete``."""
    streamer = getattr(provider, "stream", None)
    if streamer is not None:
        async for delta in streamer(request, spec):
            yield delta
    else:
        response = await provider.complete(request, spec)
        yield response.text


class LLMRouter:
    def __init__(
        self,
        registry: ModelRegistry,
        providers: dict[str, LLMProvider],
        objective: RouteObjective = "cost",
        policy: RoutingPolicy | None = None,
        breaker: CircuitBreaker | None = None,
    ) -> None:
        self.registry = registry
        self.providers = providers
        self.policy = policy or RoutingPolicy(default_objective=objective)
        self.breaker = breaker or CircuitBreaker()

    @property
    def objective(self) -> RouteObjective:
        return self.policy.default_objective

    def plan(
        self, objective: RouteObjective | None = None, task: str | None = None
    ) -> list[ModelSpec]:
        resolved = objective or self.policy.resolve_objective(task)
        candidates = self.registry.candidates(list(self.providers.keys()), resolved)
        pin = self.policy.resolve_pin(task)
        if pin:
            pinned = [s for s in candidates if (s.provider, s.id) == pin]
            if pinned:
                # pinned model first; the fallback chain stays behind it
                candidates = pinned + [s for s in candidates if s is not pinned[0]]
        return candidates

    async def complete(
        self,
        request: LLMRequest,
        objective: RouteObjective | None = None,
        task: str | None = None,
    ) -> tuple[LLMResponse, RoutingDecision]:
        objective = objective or self.policy.resolve_objective(task)
        plan = self.plan(objective, task)
        fallbacks: list[str] = []
        skipped: list[str] = []
        # pass 1: skip circuits that are cooling down
        # pass 2 (only if pass 1 found nothing): try them anyway —
        # degraded beats dead
        for attempt_skipped in (False, True):
            for spec in plan:
                key = f"{spec.provider}:{spec.id}"
                if not attempt_skipped:
                    if self.breaker.is_open(key):
                        skipped.append(key)
                        continue
                elif key not in skipped:
                    continue
                provider = self.providers[spec.provider]
                try:
                    response = await provider.complete(request, spec)
                except Exception as exc:  # noqa: BLE001 — provider error -> failover
                    self.breaker.record_failure(key, rate_limited=is_rate_limit(exc))
                    reason = f"{key}: {type(exc).__name__}"
                    fallbacks.append(reason)
                    logger.warning("failover %s", kv(reason=reason, objective=objective))
                    continue
                self.breaker.record_success(key)
                decision = RoutingDecision(
                    provider=spec.provider,
                    model=spec.id,
                    objective=objective,
                    task=task,
                    fallbacks_taken=fallbacks,
                    skipped_cooldown=skipped,
                    estimated_cost_usd=response.cost_usd,
                    latency_ms=response.latency_ms,
                )
                return response, decision
            if not skipped:
                break
        raise AllProvidersFailedError(
            f"all candidates failed: {fallbacks} (cooling down: {skipped})"
        )

    async def stream_complete(
        self,
        request: LLMRequest,
        objective: RouteObjective | None = None,
        task: str | None = None,
    ) -> AsyncIterator[StreamEvent]:
        """Stream prose deltas from the first healthy candidate, then emit a
        terminal event with the accumulated response and routing decision.

        Failover only happens *before the first token* — once prose has
        reached the caller it cannot be unsent, so a mid-stream provider
        failure ends the stream (and trips the breaker) rather than retrying.
        Providers lacking ``stream`` degrade to a single-delta ``complete``.
        Usage/cost on the terminal response are estimated (the measured path
        is stateless ``/ask``)."""
        import time

        objective = objective or self.policy.resolve_objective(task)
        plan = self.plan(objective, task)
        fallbacks: list[str] = []
        skipped: list[str] = []
        for attempt_skipped in (False, True):
            for spec in plan:
                key = f"{spec.provider}:{spec.id}"
                if not attempt_skipped:
                    if self.breaker.is_open(key):
                        skipped.append(key)
                        continue
                elif key not in skipped:
                    continue
                provider = self.providers[spec.provider]
                started = time.perf_counter()
                parts: list[str] = []
                try:
                    async for delta in _provider_stream(provider, request, spec):
                        parts.append(delta)
                        yield StreamEvent(delta=delta)
                except Exception as exc:  # noqa: BLE001 — provider error
                    self.breaker.record_failure(key, rate_limited=is_rate_limit(exc))
                    reason = f"{key}: {type(exc).__name__}"
                    fallbacks.append(reason)
                    logger.warning("stream failover %s", kv(reason=reason))
                    if parts:
                        # tokens already delivered — cannot fail over cleanly
                        raise
                    continue
                self.breaker.record_success(key)
                text = "".join(parts)
                usage = LLMUsage(
                    input_tokens=len(request.system + request.user) // 4,
                    output_tokens=len(text) // 4,
                )
                response = LLMResponse(
                    text=text,
                    provider=spec.provider,
                    model=spec.id,
                    usage=usage,
                    latency_ms=round((time.perf_counter() - started) * 1000, 1),
                    cost_usd=spec.cost_usd(usage.input_tokens, usage.output_tokens),
                )
                decision = RoutingDecision(
                    provider=spec.provider,
                    model=spec.id,
                    objective=objective,
                    task=task,
                    fallbacks_taken=fallbacks,
                    skipped_cooldown=skipped,
                    estimated_cost_usd=response.cost_usd,
                    latency_ms=response.latency_ms,
                )
                yield StreamEvent(response=response, decision=decision)
                return
            if not skipped:
                break
        raise AllProvidersFailedError(
            f"all candidates failed to stream: {fallbacks} (cooling down: {skipped})"
        )

    async def complete_structured(
        self,
        request: LLMRequest,
        output_model: type[BaseModel],
        objective: RouteObjective | None = None,
        task: str | None = None,
    ) -> tuple[BaseModel, LLMResponse, RoutingDecision]:
        """Structured completion validated into ``output_model``, with one
        retry-on-validation-failure before failing over."""
        request = request.model_copy(
            update={
                "json_schema": schema_for(output_model),
                "schema_name": output_model.__name__,
            }
        )
        last_error: Exception | None = None
        for attempt in range(2):
            response, decision = await self.complete(request, objective, task)
            try:
                parsed = output_model.model_validate(json.loads(response.text))
                return parsed, response, decision
            except (json.JSONDecodeError, ValidationError) as exc:
                last_error = exc
                logger.warning(
                    "structured output invalid %s",
                    kv(attempt=attempt, model=decision.model, error=type(exc).__name__),
                )
                request = request.model_copy(
                    update={
                        "user": request.user
                        + "\n\nYour previous response was not valid for the required "
                        f"schema ({exc.__class__.__name__}). Respond with valid JSON "
                        "matching the schema exactly.",
                    }
                )
        raise AllProvidersFailedError(
            f"structured output failed validation after retry: {last_error}"
        )
