"""Pydantic request/response shapes. The completion endpoint is OpenAI-compatible
so arbiter is a drop-in: a client only changes its ``base_url``."""

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
    n: int = Field(60, ge=1, le=2000)
    seed: int = 1


class ClientCompletion(BaseModel):
    """One browser→host-executed completion. ``model_id`` is the registry id used
    for PRICING (the tier being simulated); ``executor`` names the actual local
    model that produced the text, for transparency."""
    model_id: str
    executor: str | None = None
    text: str
    in_tokens: int = 0
    out_tokens: int = 0
    judge_score: float | None = None
    judge_reason: str = ""


class ClientObservation(BaseModel):
    """A full observation executed in the browser against the host's Ollama: the
    baseline output plus one or more cheaper-candidate outputs (each optionally
    carrying a browser-computed judge score). The server classifies, prices,
    runs the deterministic heuristics, and logs it — no server-side model call."""
    messages: list[ChatMessage]
    max_tokens: int = 400
    temperature: float = 0.0
    wants_json: bool = False
    baseline: ClientCompletion
    candidates: list[ClientCompletion] = Field(default_factory=list)
