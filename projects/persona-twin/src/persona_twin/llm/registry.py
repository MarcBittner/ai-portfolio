"""Model registry: loads models.yaml and orders candidates per objective."""

from pathlib import Path

import yaml

from persona_twin.config import RouteObjective
from persona_twin.llm.base import ModelSpec

DEFAULT_REGISTRY_PATH = Path(__file__).parent / "models.yaml"


class ModelRegistry:
    def __init__(self, specs: list[ModelSpec]) -> None:
        self._specs = specs

    @classmethod
    def from_yaml(cls, path: Path | None = None) -> "ModelRegistry":
        raw = yaml.safe_load((path or DEFAULT_REGISTRY_PATH).read_text())
        specs = [
            ModelSpec(provider=provider, **model)
            for provider, body in raw["providers"].items()
            for model in body["models"]
        ]
        return cls(specs)

    @property
    def specs(self) -> list[ModelSpec]:
        return list(self._specs)

    def candidates(
        self, available_providers: list[str], objective: RouteObjective
    ) -> list[ModelSpec]:
        """Models to try, in order. The mock model is always the final
        fallback and is never *selected* while a real provider is up."""
        real = [
            s
            for s in self._specs
            if s.provider in available_providers and s.provider != "mock"
        ]
        keys = {
            "cost": lambda s: (s.blended_price, -s.quality),
            "latency": lambda s: (-s.speed, s.blended_price),
            "quality": lambda s: (-s.quality, s.blended_price),
        }
        ordered = sorted(real, key=keys[objective])
        if "mock" in available_providers:
            ordered += [s for s in self._specs if s.provider == "mock"]
        return ordered
