"""An :class:`Agent` is one node in a workflow DAG.

Each agent has a **role**, a **system prompt**, and a **JSON output contract** (the
keys it must return). It calls :func:`quorum.llm.complete` through the
vendor-neutral routing chain, with a deterministic ``offline`` fallback so the
agent always produces a contract-shaped result — with zero keys, fully offline.

The agent does *only* its fuzzy job (read text, propose structured output). It
does **not** redact, audit, or tally — the orchestrator owns those governance
concerns. Every call records a :class:`StepResult` carrying the output plus the
routing telemetry (provider / model / latency / cost) an interviewer will ask
about.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field

from quorum import llm


@dataclass
class StepResult:
    """One agent invocation: its structured output plus routing telemetry."""

    step: str                 # the workflow step id
    role: str                 # the agent's role
    output: dict              # the agent's contract-shaped JSON output
    provider: str             # anthropic | openai | ollama | openrouter | offline
    model: str
    mode: str
    latency_ms: float
    cost_usd: float
    prompt_summary: str = ""  # redacted, value-light prompt preview
    fallbacks: list[str] = field(default_factory=list)


def _extract_json(text: str) -> dict:
    """Best-effort JSON object parse from a model response (tolerates fences)."""
    s = text.strip()
    if "```" in s:
        parts = s.split("```")
        if len(parts) >= 2:
            s = parts[1].removeprefix("json").strip()
    start, end = s.find("{"), s.rfind("}")
    if start < 0 or end < start:
        return {}
    try:
        obj = json.loads(s[start:end + 1])
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


@dataclass
class Agent:
    """A single role in a workflow: prompt in, contract-shaped JSON out."""

    name: str                              # step id, e.g. "clause_extractor"
    role: str                              # human role label
    system_prompt: str
    output_keys: tuple[str, ...]           # the JSON output contract
    offline: Callable[[str, str], str]     # deterministic fallback (system,user)->json

    def _shape(self, raw_text: str) -> dict:
        """Parse a model response to JSON and enforce the output contract."""
        output = _extract_json(raw_text)
        # Enforce the output contract: every declared key is present (default []),
        # so downstream steps and the deterministic tally can rely on the shape.
        for k in self.output_keys:
            output.setdefault(k, [])
        return output

    def run(self, user_prompt: str, *, mode: str | None = None,
            max_tokens: int = 1024) -> StepResult:
        """Run this agent through the routing chain and validate its output."""
        res = llm.complete(self.system_prompt, user_prompt, offline=self.offline,
                           mode=mode, json_mode=True, max_tokens=max_tokens)
        return StepResult(
            step=self.name, role=self.role, output=self._shape(res.text),
            provider=res.provider, model=res.model, mode=res.mode,
            latency_ms=res.latency_ms, cost_usd=res.cost_usd,
            fallbacks=res.fallbacks,
        )

    def from_client_completion(self, raw_text: str, *, model: str | None = None,
                               mode: str | None = None) -> StepResult:
        """Build a StepResult from a browser→host Ollama completion.

        The browser ran *this agent's* prompt against the user's own host Ollama
        (the cloud server can't reach localhost; the browser can) and submitted the
        raw completion text. We skip the provider call and reuse the same contract
        validation as :meth:`run`, so the output shape is identical to a server-side
        run. The orchestrator still redacts the prompt before the browser sees it
        and audits the step after — governance is never bypassed.
        """
        return StepResult(
            step=self.name, role=self.role, output=self._shape(raw_text),
            provider="ollama (browser→host)", model=model or "host",
            mode=mode or "local", latency_ms=0.0, cost_usd=0.0, fallbacks=[],
        )
