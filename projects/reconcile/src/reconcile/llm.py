"""Minimal multi-provider LLM router — vendored, standard-library only.

Three runtime **modes**, selectable per call or via ``LLM_MODE`` (default ``auto``):

* ``free``    — OpenRouter **free** models (no cost; default when a key is present).
* ``paid``    — Anthropic/Claude or OpenAI (your own key, best quality).
* ``offline`` — a local **Ollama** model, else a deterministic **mock** — zero deps.
* ``auto``    — free if an OpenRouter key is set, else paid, else local, else mock.

A call never raises: the chain always ends at the mock, so the deterministic core
of every project stays usable with no provider at all. Free models are flaky
upstream (per-model 429s), so OpenRouter calls carry a ``models`` fallback array —
OpenRouter routes to the first one that's actually up.

Config via environment (all optional):
  LLM_MODE (auto|free|paid|offline),
  OPENROUTER_API_KEY / OPENROUTER_MODEL / OPENROUTER_FREE_FALLBACKS,
  ANTHROPIC_API_KEY / ANTHROPIC_MODEL, OPENAI_API_KEY / OPENAI_MODEL,
  OLLAMA_BASE_URL / OLLAMA_MODEL, LLM_TIMEOUT (seconds).
"""

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field

LLM_MODE = os.environ.get("LLM_MODE", "auto").lower()
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
# Default to a *free* model. Verified reliable on the free tier (Jun 2026).
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "google/gemma-4-31b-it:free")
# Tried in order when the primary free model is rate-limited (OpenRouter `models`).
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

PROVIDERS = ("ollama", "anthropic", "openrouter", "openai", "mock")


@dataclass
class LLMResult:
    text: str
    provider: str
    model: str
    fallbacks: list[str] = field(default_factory=list)


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
    }, headers={"x-api-key": ANTHROPIC_API_KEY or "",
                "anthropic-version": "2023-06-01"})
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
    # deterministic, offline: enough to keep the pipeline flowing without a model
    return f"[mock] {prompt.strip()[:200]}"


def _resolve_order(provider: str | None) -> list[str]:
    """Map a provider/mode hint to an ordered provider chain. Accepts a concrete
    provider name (pins it), a mode (``free``/``paid``/``offline``), or
    ``auto``/None (free-first when keyed, else paid, else local, else mock)."""
    if provider and provider not in ("auto", "free", "paid", "offline", None):
        return [provider]
    mode = provider if provider in ("free", "paid", "offline") else LLM_MODE
    if mode == "offline":
        return ["ollama", "mock"]
    if mode == "free":
        return ["openrouter", "mock"]
    if mode == "paid":
        order = []
        if ANTHROPIC_API_KEY:
            order.append("anthropic")
        if OPENAI_API_KEY:
            order.append("openai")
        order.append("mock")
        return order
    # auto: free (OpenRouter) leads when keyed, then paid, then local, then mock.
    order = []
    if OPENROUTER_API_KEY:
        order.append("openrouter")
    if ANTHROPIC_API_KEY:
        order.append("anthropic")
    if OPENAI_API_KEY:
        order.append("openai")
    order += ["ollama", "mock"]  # local-first offline, mock always terminal
    return order


def _model_for(provider: str, override: str | None) -> str:
    if override:
        return override
    return {"ollama": OLLAMA_MODEL, "anthropic": ANTHROPIC_MODEL, "openai": OPENAI_MODEL,
            "openrouter": OPENROUTER_MODEL, "mock": "mock"}.get(provider, "mock")


def complete(prompt: str, system: str = "You are a precise assistant.",
             provider: str | None = "auto", model: str | None = None) -> LLMResult:
    """Run the prompt through the resolved provider chain; mock is terminal so this
    never raises. ``provider`` pins a provider or selects a mode (free/paid/offline);
    ``model`` overrides the per-provider default."""
    fallbacks: list[str] = []
    for p in _resolve_order(provider):
        m = _model_for(p, model)
        try:
            if p == "ollama":
                text = _ollama(system, prompt, m)
            elif p == "anthropic" and ANTHROPIC_API_KEY:
                text = _anthropic(system, prompt, m)
            elif p == "openai" and OPENAI_API_KEY:
                text = _openai_compatible("https://api.openai.com/v1",
                                          OPENAI_API_KEY, m, system, prompt)
            elif p == "openrouter" and OPENROUTER_API_KEY:
                # carry the free-model fallback list only when running a free model
                models = OPENROUTER_FREE_FALLBACKS if m.endswith(":free") else None
                text = _openai_compatible("https://openrouter.ai/api/v1",
                                          OPENROUTER_API_KEY, m, system, prompt, models)
            elif p == "mock":
                text = _mock(system, prompt, m)
            else:
                continue
            return LLMResult(text=text, provider=p, model=m, fallbacks=fallbacks)
        except (urllib.error.URLError, OSError, KeyError, ValueError,
                TimeoutError) as exc:
            fallbacks.append(f"{p}: {type(exc).__name__}")
            continue
    return LLMResult(text=_mock(system, prompt, "mock"), provider="mock",
                     model="mock", fallbacks=fallbacks)


def complete_json(prompt: str, system: str, provider: str | None = "auto",
                  model: str | None = None) -> tuple[object | None, LLMResult]:
    """Like ``complete`` but extracts a JSON value from the response (handles code
    fences / surrounding prose). Returns ``(parsed_or_None, result)`` — parse
    failure (or the mock provider) yields ``None`` so callers fall back."""
    result = complete(prompt, system, provider, model)
    if result.provider == "mock":
        return None, result
    raw = result.text.strip()
    if raw.count("```") >= 2:  # strip a ```json ... ``` fence
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
    """Quick Ollama reachability check for the UI (GET /api/tags)."""
    try:
        with urllib.request.urlopen(  # noqa: S310 - fixed host
            f"{OLLAMA_BASE_URL}/api/tags", timeout=timeout
        ) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError, TimeoutError):
        return False


def active_mode() -> str:
    """The effective mode the next ``auto`` call will use (for the UI)."""
    if LLM_MODE in ("free", "paid", "offline"):
        return LLM_MODE
    if OPENROUTER_API_KEY:
        return "free"
    if ANTHROPIC_API_KEY or OPENAI_API_KEY:
        return "paid"
    return "offline"


def providers_status() -> dict:
    """What the UI needs to render the routing/config panel."""
    return {
        "mode": LLM_MODE,
        "active_mode": active_mode(),
        "default_order": _resolve_order("auto"),
        "available": {
            "free": bool(OPENROUTER_API_KEY),
            "paid": bool(ANTHROPIC_API_KEY or OPENAI_API_KEY),
            "offline": True,
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
        "free_models": OPENROUTER_FREE_FALLBACKS,
    }
