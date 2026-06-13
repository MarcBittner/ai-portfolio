"""Multi-provider LLM router with a circuit breaker — vendored, stdlib-only.

Portfolio-standard routing order: **paid (Anthropic → OpenAI) → local (Ollama) →
free (OpenRouter) → deterministic offline mock**, so a call never raises. A
provider is *available* only when its key is set (Ollama autodetected via a probe
to ``/api/tags``); the offline mock is always terminal. ``LLM_MODE`` (or the
per-call ``provider`` arg) pins a tier: ``auto`` walks the full chain, or force
``paid`` / ``local`` / ``free`` / ``offline``. Adds, over the base router:

* **latency** measurement per call (``latency_ms`` on the result), and
* a per-provider **circuit breaker** — after N consecutive failures a provider is
  skipped for a cooldown, so one flapping upstream can't stall every request.

Config via environment (all optional): ANTHROPIC_API_KEY / ANTHROPIC_MODEL,
OPENAI_API_KEY / OPENAI_MODEL, OLLAMA_BASE_URL / OLLAMA_MODEL,
OPENROUTER_API_KEY / OPENROUTER_MODEL, LLM_MODE, LLM_TIMEOUT,
LLM_BREAKER_THRESHOLD (default 3), LLM_BREAKER_COOLDOWN (seconds, default 30).
"""

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

LLM_MODE = os.environ.get("LLM_MODE", "auto").lower()  # auto|paid|local|free|offline
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
# Default to a *free* model; OpenRouter routes across the fallback list on 429.
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "google/gemma-4-31b-it:free")
# OpenRouter caps the `models` fallback array at 3 entries.
OPENROUTER_FREE_FALLBACKS = [
    m.strip() for m in os.environ.get(
        "OPENROUTER_FREE_FALLBACKS",
        "google/gemma-4-31b-it:free,"
        "nvidia/nemotron-3-super-120b-a12b:free,"
        "nvidia/nemotron-3-nano-30b-a3b:free",
    ).split(",") if m.strip()
][:3]
LLM_TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "45"))
BREAKER_THRESHOLD = int(os.environ.get("LLM_BREAKER_THRESHOLD", "3"))
BREAKER_COOLDOWN = float(os.environ.get("LLM_BREAKER_COOLDOWN", "30"))

# Portfolio-standard order: paid (anthropic → openai) → local → free → offline.
PROVIDERS = ("anthropic", "openai", "ollama", "openrouter", "mock")


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


def _openai_compatible(base: str, key: str, model: str, system: str, prompt: str,
                       models: list[str] | None = None) -> str:
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": prompt}],
    }
    if models:  # OpenRouter: try these in order if `model` is unavailable/limited
        payload["models"] = models
    data = _post(f"{base}/chat/completions", payload,
                 headers={"authorization": f"Bearer {key}"})
    return data["choices"][0]["message"]["content"]


def _mock(system: str, prompt: str, model: str) -> str:
    return f"[mock completion] {prompt.strip()[:200]}"


def _paid(order: list[str]) -> list[str]:
    """Append available paid providers (Anthropic first, then OpenAI)."""
    if ANTHROPIC_API_KEY:
        order.append("anthropic")
    if OPENAI_API_KEY:
        order.append("openai")
    return order


def _resolve_order(provider: str | None) -> list[str]:
    """Resolve the provider chain. A concrete provider name pins it; a mode
    (paid/local/free/offline) selects a sub-chain; auto/None walks the full
    portfolio-standard order: paid → local → free → offline. A provider is
    included only when configured/reachable; ``mock`` is always terminal."""
    modes = ("auto", "paid", "local", "free", "offline")
    if provider and provider not in (*modes, None):
        return [provider]
    mode = provider if provider in modes else LLM_MODE
    if mode == "offline":
        return ["mock"]
    if mode == "paid":
        return _paid([]) + ["mock"]
    if mode == "local":
        return (["ollama"] if reachable() else []) + ["mock"]
    if mode == "free":
        return (["openrouter"] if OPENROUTER_API_KEY else []) + ["mock"]
    # auto: paid → local → free → offline
    order = _paid([])
    if reachable():
        order.append("ollama")
    if OPENROUTER_API_KEY:
        order.append("openrouter")
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
        models = OPENROUTER_FREE_FALLBACKS if model.endswith(":free") else None
        return _openai_compatible("https://openrouter.ai/api/v1", OPENROUTER_API_KEY,
                                  model, system, prompt, models)
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


def active_mode() -> str:
    """The effective tier the next ``auto`` call will reach first (for the UI).
    Mirrors the standard order: paid → local → free → offline."""
    if LLM_MODE in ("paid", "local", "free", "offline"):
        return LLM_MODE
    if ANTHROPIC_API_KEY or OPENAI_API_KEY:
        return "paid"
    if reachable():
        return "local"
    if OPENROUTER_API_KEY:
        return "free"
    return "offline"


def providers_status() -> dict:
    ollama_up = reachable()
    return {
        "mode": LLM_MODE,
        "active_mode": active_mode(),
        "default_order": _resolve_order("auto"),
        "available": {
            "paid": bool(ANTHROPIC_API_KEY or OPENAI_API_KEY),
            "local": ollama_up,
            "free": bool(OPENROUTER_API_KEY),
            "offline": True,
            "anthropic": bool(ANTHROPIC_API_KEY),
            "openai": bool(OPENAI_API_KEY),
            "ollama": ollama_up,
            "openrouter": bool(OPENROUTER_API_KEY),
            "mock": True,
        },
        "models": {
            "anthropic": ANTHROPIC_MODEL, "openai": OPENAI_MODEL,
            "ollama": OLLAMA_MODEL, "openrouter": OPENROUTER_MODEL, "mock": "mock",
        },
        "free_models": OPENROUTER_FREE_FALLBACKS,
        "breaker": breaker.state(),
    }
