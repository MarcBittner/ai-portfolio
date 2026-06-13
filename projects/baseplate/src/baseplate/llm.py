"""Self-contained multi-provider LLM router with a deterministic offline fallback.

This is the portfolio's standard routing layer (the same shape as persona-twin's
``llm/`` package and trueline's ``convex/lib/llm.ts``), packaged as one stdlib-only
module so every demo carries an identical, reviewable chain:

    paid (Anthropic / OpenAI)  →  local (Ollama)  →  free (OpenRouter)  →  offline

A provider is *available* only when its key is set (or, for Ollama, when a probe
to ``/api/tags`` succeeds), so the chain self-selects from the environment. The
offline path is a caller-supplied **deterministic** function — it is the
last-resort safety net (the app always runs with zero keys and zero cost), never
the design centre. ``complete()`` walks the chain in order, records which
providers it fell back through, and returns the first success.

No third-party HTTP dependency: requests go through ``urllib`` so the module is
self-contained and import-safe offline.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

Mode = Literal["auto", "paid", "local", "free", "offline"]

# Order within each tier. "auto" is the full standardized chain.
_CHAIN: dict[str, list[str]] = {
    "auto": ["anthropic", "openai", "ollama", "openrouter"],
    "paid": ["anthropic", "openai"],
    "local": ["ollama"],
    "free": ["openrouter"],
    "offline": [],
}

# Indicative blended $/Mtok for the cost estimate (input, output). Free + local = 0.
_PRICE: dict[str, tuple[float, float]] = {
    "anthropic": (1.0, 5.0),     # claude-haiku-class
    "openai": (0.15, 0.60),      # gpt-4o-mini-class
    "openrouter": (0.0, 0.0),    # free models
    "ollama": (0.0, 0.0),
}

_DEFAULT_MODEL = {
    "anthropic": os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
    "openai": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
    "openrouter": os.environ.get("OPENROUTER_MODEL", "google/gemma-4-31b-it:free"),
    "ollama": os.environ.get("OLLAMA_MODEL", "llama3.1:8b"),
}

_OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/")


@dataclass
class LLMResult:
    """One completion plus the routing telemetry an interviewer will ask about."""

    text: str
    provider: str          # anthropic | openai | ollama | openrouter | offline
    model: str
    mode: str
    latency_ms: float
    cost_usd: float
    fallbacks: list[str] = field(default_factory=list)  # providers tried, then skipped


# --------------------------------------------------------------------------- #
# Availability                                                                 #
# --------------------------------------------------------------------------- #

_probe_cache: dict[str, tuple[bool, float]] = {}


def _ollama_reachable() -> bool:
    cached = _probe_cache.get("ollama")
    now = time.monotonic()
    if cached and now - cached[1] < 30:
        return cached[0]
    ok = False
    try:
        req = urllib.request.Request(f"{_OLLAMA_URL}/api/tags")
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            ok = resp.status == 200
    except Exception:
        ok = False
    _probe_cache["ollama"] = (ok, now)
    return ok


def _available(provider: str) -> bool:
    if provider == "anthropic":
        return bool(os.environ.get("ANTHROPIC_API_KEY"))
    if provider == "openai":
        return bool(os.environ.get("OPENAI_API_KEY"))
    if provider == "openrouter":
        return bool(os.environ.get("OPENROUTER_API_KEY"))
    if provider == "ollama":
        return _ollama_reachable()
    return False


def status() -> dict:
    """Which providers are configured/reachable right now — drives /health + config."""
    return {
        "mode": os.environ.get("LLM_MODE", "auto"),
        "providers": {p: _available(p) for p in ("anthropic", "openai", "ollama",
                                                  "openrouter")},
        "offline_fallback": True,
        "ollama_url": _OLLAMA_URL,
    }


def resolve_mode(mode: Mode | None) -> str:
    return (mode or os.environ.get("LLM_MODE", "auto") or "auto").lower()


# --------------------------------------------------------------------------- #
# Provider calls (stdlib HTTP)                                                 #
# --------------------------------------------------------------------------- #

def _post(url: str, payload: dict, headers: dict, timeout: float) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("content-type", "application/json")
    for k, v in headers.items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _call(provider: str, system: str, user: str, *, json_mode: bool,
          max_tokens: int) -> tuple[str, str, int, int]:
    """Return (text, model, in_tokens, out_tokens) or raise."""
    model = _DEFAULT_MODEL[provider]
    if provider == "anthropic":
        body = {
            "model": model, "max_tokens": max_tokens, "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        out = _post("https://api.anthropic.com/v1/messages", body, {
            "x-api-key": os.environ["ANTHROPIC_API_KEY"],
            "anthropic-version": "2023-06-01",
        }, timeout=60)
        text = "".join(b.get("text", "") for b in out.get("content", []))
        u = out.get("usage", {})
        return text, model, u.get("input_tokens", 0), u.get("output_tokens", 0)

    if provider in ("openai", "openrouter"):
        base = ("https://api.openai.com/v1" if provider == "openai"
                else "https://openrouter.ai/api/v1")
        key = os.environ["OPENAI_API_KEY" if provider == "openai"
                         else "OPENROUTER_API_KEY"]
        body = {
            "model": model,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
            "max_tokens": max_tokens,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        out = _post(f"{base}/chat/completions", body,
                    {"authorization": f"Bearer {key}"}, timeout=60)
        text = out["choices"][0]["message"]["content"]
        u = out.get("usage", {})
        return (text, model, u.get("prompt_tokens", 0), u.get("completion_tokens", 0))

    if provider == "ollama":
        body = {
            "model": model, "stream": False,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
        }
        if json_mode:
            body["format"] = "json"
        out = _post(f"{_OLLAMA_URL}/api/chat", body, {}, timeout=120)
        text = out.get("message", {}).get("content", "")
        return (text, model, out.get("prompt_eval_count", 0),
                out.get("eval_count", 0))

    raise ValueError(f"unknown provider {provider}")


# --------------------------------------------------------------------------- #
# Router                                                                       #
# --------------------------------------------------------------------------- #

def complete(system: str, user: str, *, offline: Callable[[str, str], str],
             mode: Mode | None = None, json_mode: bool = False,
             max_tokens: int = 1024) -> LLMResult:
    """Run the routing chain and return the first success.

    ``offline`` is the deterministic last-resort function ``(system, user) -> text``;
    it is always terminal, so this never raises for lack of a provider.
    """
    resolved = resolve_mode(mode)
    chain = _CHAIN.get(resolved, _CHAIN["auto"])
    fallbacks: list[str] = []
    for provider in chain:
        if not _available(provider):
            continue
        t0 = time.monotonic()
        try:
            text, model, in_tok, out_tok = _call(
                provider, system, user, json_mode=json_mode, max_tokens=max_tokens)
        except Exception:
            fallbacks.append(provider)
            continue
        if not text.strip():
            fallbacks.append(provider)
            continue
        in_p, out_p = _PRICE.get(provider, (0.0, 0.0))
        return LLMResult(
            text=text, provider=provider, model=model, mode=resolved,
            latency_ms=round((time.monotonic() - t0) * 1000, 1),
            cost_usd=round((in_tok * in_p + out_tok * out_p) / 1_000_000, 6),
            fallbacks=fallbacks,
        )
    t0 = time.monotonic()
    text = offline(system, user)
    return LLMResult(
        text=text, provider="offline", model="deterministic", mode=resolved,
        latency_ms=round((time.monotonic() - t0) * 1000, 1), cost_usd=0.0,
        fallbacks=fallbacks,
    )
