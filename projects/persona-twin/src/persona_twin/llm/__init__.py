"""Multi-provider LLM layer: registry, providers, objective router."""

from persona_twin.config import Settings
from persona_twin.llm.base import (
    LLMProvider,
    LLMRequest,
    LLMResponse,
    LLMUsage,
    ModelSpec,
)
from persona_twin.llm.mock import MockProvider
from persona_twin.llm.policy import TASKS, RoutingPolicy, TaskRoute
from persona_twin.llm.registry import ModelRegistry
from persona_twin.llm.router import AllProvidersFailedError, LLMRouter, schema_for

__all__ = [
    "AllProvidersFailedError",
    "LLMProvider",
    "LLMRequest",
    "LLMResponse",
    "LLMRouter",
    "LLMUsage",
    "MockProvider",
    "ModelRegistry",
    "ModelSpec",
    "RoutingPolicy",
    "TASKS",
    "TaskRoute",
    "get_router",
    "schema_for",
]


def get_router(settings: Settings) -> LLMRouter:
    providers: dict[str, LLMProvider] = {}
    for backend in settings.llm_backends:
        if backend == "anthropic":
            from persona_twin.llm.anthropic_llm import AnthropicProvider

            providers["anthropic"] = AnthropicProvider(api_key=settings.anthropic_api_key)
        elif backend == "openai":
            from persona_twin.llm.openai_llm import OpenAIProvider

            providers["openai"] = OpenAIProvider(api_key=settings.openai_api_key)
        elif backend == "openrouter":
            from persona_twin.llm.openrouter_llm import OpenRouterProvider

            providers["openrouter"] = OpenRouterProvider(
                api_key=settings.openrouter_api_key
            )
        elif backend == "ollama":
            from persona_twin.llm.ollama_llm import OllamaProvider

            providers["ollama"] = OllamaProvider(base_url=settings.ollama_base_url)
        else:
            providers["mock"] = MockProvider()
    providers.setdefault("mock", MockProvider())
    specs = ModelRegistry.from_yaml().specs
    if "ollama" in providers:
        from persona_twin.llm.ollama_llm import discover_ollama_models

        specs = specs + discover_ollama_models(settings.ollama_base_url)
    if "openrouter" in providers and settings.openrouter_free_discovery:
        from persona_twin.llm.openrouter_llm import discover_free_models

        known = {(s.provider, s.id) for s in specs}
        specs = specs + [
            s for s in discover_free_models() if ("openrouter", s.id) not in known
        ]
    from persona_twin.llm.custom import (
        CustomOpenAIProvider,
        extra_specs,
        parse_extra_providers,
    )

    for extra in parse_extra_providers(settings.extra_providers):
        providers[extra.name] = CustomOpenAIProvider(extra)
        specs = specs + extra_specs(extra)
    return LLMRouter(
        ModelRegistry(specs), providers, objective=settings.route_objective
    )
