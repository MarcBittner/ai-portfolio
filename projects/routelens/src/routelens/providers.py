"""Explicit per-model provider client.

The portfolio's standard ``llm.complete()`` walks a fallback *chain*; a routing
proxy instead needs to call a **named** ``(provider, model)`` and get token usage
back, and to run two models side-by-side for shadow judging. This module provides
that lower-level primitive, reusing the same stdlib-``urllib`` HTTP approach so it
stays dependency-free and import-safe offline.

A provider is *available* only when its key is set (or, for Ollama, a probe to
``/api/tags`` succeeds). ``call()`` raises ``ProviderError`` when a model can't be
reached — callers decide whether that is fatal (the proxy falls back) or simply
means "can't measure quality here" (the judge skips).
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
from dataclasses import dataclass, field

from .registry import Model

_OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/")


class ProviderError(RuntimeError):
    pass


@dataclass
class Completion:
    text: str
    model_id: str
    provider: str
    in_tokens: int
    out_tokens: int
    latency_ms: float
    cached_in_tokens: int = 0   # provider-side prompt-cache reads (billed cheap)
    raw: dict = field(default_factory=dict)


_probe_cache: dict[str, tuple[bool, float]] = {}


def _ollama_reachable() -> bool:
    cached = _probe_cache.get("ollama")
    now = time.monotonic()
    if cached and now - cached[1] < 30:
        return cached[0]
    ok = False
    try:
        with urllib.request.urlopen(f"{_OLLAMA_URL}/api/tags", timeout=1.5) as r:
            ok = r.status == 200
    except Exception:
        ok = False
    _probe_cache["ollama"] = (ok, now)
    return ok


def available(provider: str) -> bool:
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
    return {
        "providers": {
            p: available(p) for p in ("anthropic", "openai", "openrouter", "ollama")
        },
        "ollama_url": _OLLAMA_URL,
        "any": any(
            available(p) for p in ("anthropic", "openai", "openrouter", "ollama")
        ),
    }


def _post(url: str, payload: dict, headers: dict, timeout: float) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("content-type", "application/json")
    for k, v in headers.items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def call(
    model: Model,
    messages: list[dict],
    *,
    max_tokens: int = 1024,
    temperature: float = 0.0,
    json_mode: bool = False,
    cache_prefix: bool = False,
) -> Completion:
    """Call one model. ``messages`` is OpenAI-shaped (role/content dicts).

    ``cache_prefix`` enables provider-native prompt caching where supported
    (Anthropic ``cache_control`` on the system + leading messages); the returned
    ``cached_in_tokens`` reflects cache reads so the cost model can bill them at
    the cheaper cached rate.
    """
    if not available(model.provider):
        raise ProviderError(f"{model.provider} not available")

    sys_text = ""
    convo = []
    for m in messages:
        if m.get("role") == "system":
            sys_text += (m.get("content") or "") + "\n"
        else:
            convo.append({"role": m["role"], "content": m.get("content") or ""})
    sys_text = sys_text.strip()

    t0 = time.monotonic()

    if model.provider == "anthropic":
        sys_block: object = sys_text
        if cache_prefix and sys_text:
            sys_block = [{"type": "text", "text": sys_text,
                          "cache_control": {"type": "ephemeral"}}]
        body = {
            "model": model.model, "max_tokens": max_tokens,
            "system": sys_block, "messages": convo, "temperature": temperature,
        }
        out = _post("https://api.anthropic.com/v1/messages", body, {
            "x-api-key": os.environ["ANTHROPIC_API_KEY"],
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "prompt-caching-2024-07-31",
        }, timeout=90)
        text = "".join(b.get("text", "") for b in out.get("content", []))
        u = out.get("usage", {})
        cached = u.get("cache_read_input_tokens", 0)
        in_tok = u.get("input_tokens", 0) + cached
        return Completion(text, model.id, model.provider, in_tok,
                          u.get("output_tokens", 0),
                          round((time.monotonic() - t0) * 1000, 1),
                          cached_in_tokens=cached, raw=out)

    if model.provider in ("openai", "openrouter"):
        base = ("https://api.openai.com/v1" if model.provider == "openai"
                else "https://openrouter.ai/api/v1")
        key = os.environ["OPENAI_API_KEY" if model.provider == "openai"
                         else "OPENROUTER_API_KEY"]
        msgs = ([{"role": "system", "content": sys_text}] if sys_text else []) + convo
        body = {"model": model.model, "messages": msgs,
                "max_tokens": max_tokens, "temperature": temperature}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        out = _post(f"{base}/chat/completions", body,
                    {"authorization": f"Bearer {key}"}, timeout=90)
        text = out["choices"][0]["message"]["content"]
        u = out.get("usage", {})
        cached = (u.get("prompt_tokens_details", {}) or {}).get("cached_tokens", 0)
        return Completion(text, model.id, model.provider,
                          u.get("prompt_tokens", 0), u.get("completion_tokens", 0),
                          round((time.monotonic() - t0) * 1000, 1),
                          cached_in_tokens=cached, raw=out)

    if model.provider == "ollama":
        msgs = ([{"role": "system", "content": sys_text}] if sys_text else []) + convo
        body = {"model": model.model, "stream": False, "messages": msgs,
                "options": {"temperature": temperature}}
        if json_mode:
            body["format"] = "json"
        out = _post(f"{_OLLAMA_URL}/api/chat", body, {}, timeout=180)
        text = out.get("message", {}).get("content", "")
        return Completion(text, model.id, model.provider,
                          out.get("prompt_eval_count", 0), out.get("eval_count", 0),
                          round((time.monotonic() - t0) * 1000, 1), raw=out)

    raise ProviderError(f"unknown provider {model.provider}")
