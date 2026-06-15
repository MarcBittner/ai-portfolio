"""Pydantic request/response shapes. The completion endpoint is OpenAI-compatible
so routelens is a drop-in: a client only changes its ``base_url``."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: str
    content: str | None = ""


class ChatCompletionRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    max_tokens: int = 1024
    temperature: float = 0.0
    response_format: dict[str, Any] | None = None
    stream: bool = False  # accepted; v0.1 responds non-streamed

    model_config = {"extra": "allow"}

    def wants_json(self) -> bool:
        return bool(self.response_format
                    and self.response_format.get("type") == "json_object")

    def as_messages(self) -> list[dict]:
        return [{"role": m.role, "content": m.content or ""} for m in self.messages]


class ConfigUpdate(BaseModel):
    mode: str | None = None
    floor: float | None = None
    rate: float | None = None
    min_samples: int | None = None
    shadow_sample: float | None = None
    route_shadow_sample: float | None = None
    response_cache: bool | None = None
    prompt_cache: bool | None = None


class RuleIn(BaseModel):
    id: str
    route_to: str
    match: dict[str, Any] = Field(default_factory=dict)
    require_quality: float = 0.92
    source: str = "manual"
    enabled: bool = True


class SimulateRequest(BaseModel):
    n: int = 60
    seed: int = 1
