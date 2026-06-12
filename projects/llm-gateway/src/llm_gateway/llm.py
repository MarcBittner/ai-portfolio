"""Multi-provider LLM router with a circuit breaker — vendored, stdlib-only.

Offline-first: prefers a local **Ollama** model, falls back across configured
cloud providers (**Anthropic/Claude**, OpenRouter, OpenAI), and finally a
deterministic **mock**, so a call never raises. Adds, over the base router:

* **latency** measurement per call (``latency_ms`` on the result), and
* a per-provider **circuit breaker** — after N consecutive failures a provider is
  skipped for a cooldown, so one flapping upstream can't stall every request.

Config via environment (all optional): ANTHROPIC_API_KEY / ANTHROPIC_MODEL,
OLLAMA_BASE_URL / OLLAMA_MODEL, OPENAI_API_KEY / OPENAI_MODEL,
OPENROUTER_API_KEY / OPENROUTER_MODEL, LLM_TIMEOUT,
LLM_BREAKER_THRESHOLD (default 3), LLM_BREAKER_COOLDOWN (seconds, default 30).
"""

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "meta-llama/llama-3.1-8b-instruct")
LLM_TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "30"))
BREAKER_THRESHOLD = int(os.environ.get("LLM_BREAKER_THRESHOLD", "3"))
BREAKER_COOLDOWN = float(os.environ.get("LLM_BREAKER_COOLDOWN", "30"))

PROVIDERS = ("ollama", "anthropic", "openrouter", "openai", "mock")


@dataclass
class LLMResult:
    text: str
    provider: str
    model: str
    latency_ms: float = 0.0
    fallbacks: list[str] = field(default_factory=list)


class CircuitBreaker:
    """Per-provider consecutive-failure breaker. Opens after ``threshold`` fails;
    stays open for ``cooldown`` seconds, then allows a trial request."""

    def __init__(self, threshold: int = BREAKER_THRESHOLD,
                 cooldown: float = BREAKER_COOLDOWN):
        self.threshold = threshold
        self.cooldown = cooldown
        self._fail: dict[str, int] = {}
        self._opened: dict[str, float] = {}

    def _now(self) -> float:
        return time.monotonic()

    def is_open(self, provider: str) -> bool:
        opened = self._opened.get(provider)
        if opened is None:
            return False
        if self._now() - opened >= self.cooldown:  # cooldown elapsed → half-open
            self._opened.pop(provider, None)
            self._fail[provider] = 0
            return False
        return True

    def record_success(self, provider: str) -> None:
        self._fail[provider] = 0
        self._opened.pop(provider, None)

    def record_failure(self, provider: str) -> None:
        n = self._fail.get(provider, 0) + 1
        self._fail[provider] = n
        if n >= self.threshold:
            self._opened[provider] = self._now()

    def state(self) -> dict:
        return {p: ("open" if self.is_open(p) else "closed")
                for p in set(self._fail) | set(self._opened)}


breaker = CircuitBreaker()


def _post(url: str, payload: dict, headers: dict | None = None,
          timeout: float = LLM_TIMEOUT) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"content-type": "application/json", **(headers or {})}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - fixed hosts
        return json.loads(resp.read().decode())


def _ollama(system: str, prompt: str, model: str) -> str:
    data = _post(f"{OLLAMA_BASE_URL}/api/chat", {
        "model": model, "stream": False,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": prompt}],
    })
    return data["message"]["content"]


def _anthropic(system: str, prompt: str, model: str) -> str:
    data = _post("https://api.anthropic.com/v1/messages", {
        "model": model, "max_tokens": 2048, "system": system,
        "messages": [{"role": "user", "content": prompt}],
    }, headers={"x-api-key": ANTHROPIC_API_KEY or "", "anthropic-version": "2023-06-01"})
    return data["content"][0]["text"]


def _openai_compatible(base: str, key: str, model: str, system: str, prompt: str) -> str:
    data = _post(f"{base}/chat/completions", {
        "model": model,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": prompt}],
    }, headers={"authorization": f"Bearer {key}"})
    return data["choices"][0]["message"]["content"]


def _mock(system: str, prompt: str, model: str) -> str:
    return f"[mock completion] {prompt.strip()[:200]}"


def _resolve_order(provider: str | None) -> list[str]:
    if provider and provider not in ("auto", None):
        return [provider]
    order = ["ollama"]
    if ANTHROPIC_API_KEY:
        order.append("anthropic")
    if OPENROUTER_API_KEY:
        order.append("openrouter")
    if OPENAI_API_KEY:
        order.append("openai")
    order.append("mock")
    return order


def _model_for(provider: str, override: str | None) -> str:
    if override:
        return override
    return {"ollama": OLLAMA_MODEL, "anthropic": ANTHROPIC_MODEL, "openai": OPENAI_MODEL,
            "openrouter": OPENROUTER_MODEL, "mock": "mock"}.get(provider, "mock")


def _call(provider: str, system: str, prompt: str, model: str) -> str:
    if provider == "ollama":
        return _ollama(system, prompt, model)
    if provider == "anthropic" and ANTHROPIC_API_KEY:
        return _anthropic(system, prompt, model)
    if provider == "openai" and OPENAI_API_KEY:
        return _openai_compatible("https://api.openai.com/v1", OPENAI_API_KEY,
                                  model, system, prompt)
    if provider == "openrouter" and OPENROUTER_API_KEY:
        return _openai_compatible("https://openrouter.ai/api/v1", OPENROUTER_API_KEY,
                                  model, system, prompt)
    if provider == "mock":
        return _mock(system, prompt, model)
    raise RuntimeError(f"provider {provider} unavailable")


def complete(prompt: str, system: str = "You are a precise assistant.",
             provider: str | None = "auto", model: str | None = None) -> LLMResult:
    """Route through the provider chain (skipping open breakers); mock is terminal
    so this never raises. Records latency and updates the breaker per provider."""
    fallbacks: list[str] = []
    for p in _resolve_order(provider):
        if p != "mock" and breaker.is_open(p):
            fallbacks.append(f"{p}: breaker_open")
            continue
        m = _model_for(p, model)
        t0 = time.monotonic()
        try:
            text = _call(p, system, prompt, m)
            breaker.record_success(p)
            return LLMResult(text=text, provider=p, model=m,
                             latency_ms=round((time.monotonic() - t0) * 1000, 1),
                             fallbacks=fallbacks)
        except (urllib.error.URLError, OSError, KeyError, ValueError,
                TimeoutError, RuntimeError) as exc:
            breaker.record_failure(p)
            fallbacks.append(f"{p}: {type(exc).__name__}")
            continue
    return LLMResult(text=_mock(system, prompt, "mock"), provider="mock",
                     model="mock", fallbacks=fallbacks)


def complete_json(prompt: str, system: str, provider: str | None = "auto",
                  model: str | None = None) -> tuple[object | None, LLMResult]:
    """Like ``complete`` but extracts a JSON value (handles fences/prose). Returns
    ``(parsed_or_None, result)`` — None for the mock provider or a parse failure."""
    result = complete(prompt, system, provider, model)
    if result.provider == "mock":
        return None, result
    raw = result.text.strip()
    if raw.count("```") >= 2:
        raw = raw.split("```")[1].removeprefix("json").strip()
    start = min((i for i in (raw.find("{"), raw.find("[")) if i != -1), default=-1)
    if start == -1:
        return None, result
    end = max(raw.rfind("}"), raw.rfind("]"))
    try:
        return json.loads(raw[start:end + 1]), result
    except (ValueError, json.JSONDecodeError):
        return None, result


def reachable(timeout: float = 1.5) -> bool:
    try:
        with urllib.request.urlopen(  # noqa: S310 - fixed host
            f"{OLLAMA_BASE_URL}/api/tags", timeout=timeout
        ) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError, TimeoutError):
        return False


def providers_status() -> dict:
    return {
        "default_order": _resolve_order("auto"),
        "available": {
            "ollama": reachable(),
            "anthropic": bool(ANTHROPIC_API_KEY),
            "openrouter": bool(OPENROUTER_API_KEY),
            "openai": bool(OPENAI_API_KEY),
            "mock": True,
        },
        "models": {
            "ollama": OLLAMA_MODEL, "anthropic": ANTHROPIC_MODEL,
            "openrouter": OPENROUTER_MODEL, "openai": OPENAI_MODEL, "mock": "mock",
        },
        "breaker": breaker.state(),
    }
