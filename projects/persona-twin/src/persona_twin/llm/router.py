"""Objective-aware router with provider fallback and validated
structured outputs.

The router orders candidate models from the registry by the requested
objective (``cost`` / ``latency`` / ``quality``), tries them in order,
and records every failover with its reason. The mock provider is the
guaranteed-terminal fallback, so a request can degrade but never die
with an empty hand.
"""

import json

from pydantic import BaseModel, ValidationError

from persona_twin.config import RouteObjective
from persona_twin.llm.base import LLMProvider, LLMRequest, LLMResponse, ModelSpec
from persona_twin.llm.registry import ModelRegistry
from persona_twin.log import get_logger, kv
from persona_twin.models import RoutingDecision

logger = get_logger("llm.router")


class AllProvidersFailedError(RuntimeError):
    pass


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


class LLMRouter:
    def __init__(
        self,
        registry: ModelRegistry,
        providers: dict[str, LLMProvider],
        objective: RouteObjective = "cost",
    ) -> None:
        self.registry = registry
        self.providers = providers
        self.objective = objective

    def plan(self, objective: RouteObjective | None = None) -> list[ModelSpec]:
        return self.registry.candidates(
            list(self.providers.keys()), objective or self.objective
        )

    async def complete(
        self, request: LLMRequest, objective: RouteObjective | None = None
    ) -> tuple[LLMResponse, RoutingDecision]:
        objective = objective or self.objective
        fallbacks: list[str] = []
        for spec in self.plan(objective):
            provider = self.providers[spec.provider]
            try:
                response = await provider.complete(request, spec)
            except Exception as exc:  # noqa: BLE001 — any provider error -> failover
                reason = f"{spec.provider}:{spec.id}: {type(exc).__name__}"
                fallbacks.append(reason)
                logger.warning("failover %s", kv(reason=reason, objective=objective))
                continue
            decision = RoutingDecision(
                provider=spec.provider,
                model=spec.id,
                objective=objective,
                fallbacks_taken=fallbacks,
                estimated_cost_usd=response.cost_usd,
                latency_ms=response.latency_ms,
            )
            return response, decision
        raise AllProvidersFailedError(f"all candidates failed: {fallbacks}")

    async def complete_structured(
        self,
        request: LLMRequest,
        output_model: type[BaseModel],
        objective: RouteObjective | None = None,
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
            response, decision = await self.complete(request, objective)
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
