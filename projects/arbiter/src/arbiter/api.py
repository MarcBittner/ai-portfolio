"""FastAPI app: an OpenAI-compatible proxy endpoint + the control/analytics plane,
plus the static console.

The proxy endpoint (``POST /v1/chat/completions``) is a drop-in: point any
OpenAI-SDK client at this base URL. Everything else is the control plane the
console drives — mode, config, rules, opportunities, and the over-time report.
"""

from __future__ import annotations

import os
import time

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import classify as _classify
from . import providers
from .cache import prefix_signature, request_key
from .cost import cost_usd
from .models import (
    ChatCompletionRequest,
    ClientObservation,
    ConfigUpdate,
    RuleIn,
    SimulateRequest,
)
from .proxy import Proxy
from .quality import _JUDGE_SYSTEM, pick_judge, score_from_texts
from .registry import DEFAULT as REGISTRY
from .rules import RouteConfig, Rule, Ruleset, generate_rules
from .store import Store

_STATIC = os.path.join(os.path.dirname(__file__), "static")

app = FastAPI(title="arbiter", version="0.1.0")

store = Store()
cfg = RouteConfig()
ruleset = Ruleset()
# restore persisted config + rules
_saved_cfg = store.get_meta("config")
if _saved_cfg:
    cfg.update(**_saved_cfg)
_saved_rules = store.get_meta("rules")
if _saved_rules:
    ruleset.replace([Rule(**r) for r in _saved_rules])

proxy = Proxy(REGISTRY, cfg, ruleset, store,
              default_model=os.environ.get("ARBITER_DEFAULT_MODEL", "local"))


def _persist_cfg() -> None:
    store.set_meta("config", cfg.to_dict())


def _persist_rules() -> None:
    store.set_meta("rules", ruleset.to_list())


def _strongest_available() -> str:
    m = pick_judge(REGISTRY)
    return m.id if m else (REGISTRY.get("local") or REGISTRY.all()[0]).id


@app.get("/health")
def health():
    return {"ok": True, "version": "0.1.0", "mode": cfg.mode,
            "providers": providers.status(),
            "strongest_available": _strongest_available()}


@app.post("/v1/chat/completions")
def chat_completions(req: ChatCompletionRequest):
    resp = proxy.handle(req.model, req.as_messages(), max_tokens=req.max_tokens,
                        temperature=req.temperature, json_mode=req.wants_json())
    rl = resp["arbiter"]
    headers = {
        "x-arbiter-strategy": str(rl["strategy"]),
        "x-arbiter-served-model": str(rl["served_model"]),
        "x-arbiter-baseline-model": str(rl["baseline_model"]),
        "x-arbiter-saved-usd": str(rl["saved"]),
    }
    return JSONResponse(resp, headers=headers)


@app.get("/config")
def get_config():
    return cfg.to_dict()


@app.put("/config")
def put_config(update: ConfigUpdate):
    cfg.update(**update.model_dump(exclude_none=True))
    _persist_cfg()
    return cfg.to_dict()


@app.get("/models")
def models():
    return {"models": [m.to_dict() | {"blended_price": REGISTRY.blended_price(m.id)}
                       for m in REGISTRY.all()],
            "available": providers.status()["providers"]}


@app.get("/rules")
def get_rules():
    return {"rules": ruleset.to_list()}


@app.put("/rules")
def put_rules(rules: list[RuleIn]):
    ruleset.replace([Rule(id=r.id, route_to=r.route_to, match=r.match,
                          require_quality=r.require_quality, source=r.source,
                          enabled=r.enabled) for r in rules])
    _persist_rules()
    return {"rules": ruleset.to_list()}


@app.post("/rules/generate")
def gen_rules():
    rules = generate_rules(store.quality_stats(), REGISTRY, cfg)
    ruleset.replace(rules)
    _persist_rules()
    return {"rules": ruleset.to_list(),
            "note": "generated from measured quality stats; floor applied as a "
                    "hard gate, $/quality-point rate as the tiebreak"}


@app.get("/opportunities")
def opportunities():
    return {"opportunities": store.opportunities(REGISTRY, cfg)}


@app.get("/quality")
def quality_stats():
    return {"quality": store.quality_stats()}


@app.get("/report")
def report(scenario: str = "sonnet-to-haiku"):
    return {
        "summary": store.summary(),
        "by_task": store.by_task(),
        "timeseries": store.timeseries(),
        "projection": store.projection(cfg, scenario),
        "scenarios": list(Store.PRICE_SCENARIOS),
        "cache": proxy.response_cache.stats(),
    }


@app.post("/simulate")
def simulate(req: SimulateRequest):
    from .traffic import generate
    baseline = _strongest_available()
    reqs = generate(req.n, req.seed, baseline_id=baseline)
    for r in reqs:
        proxy.handle(r["model"], r["messages"], max_tokens=r.get("max_tokens", 400),
                     temperature=r.get("temperature", 0.0),
                     json_mode=bool(r.get("response_format")))
    return {"ran": len(reqs), "baseline": baseline, "mode": cfg.mode,
            "summary": store.summary()}


@app.get("/traffic")
def traffic(n: int = Query(12, ge=1, le=500), seed: int = 1):
    """Synthetic requests for the browser→host measurement flow to execute on the
    host's Ollama (so the heavy model calls run client-side, not on this server)."""
    from .traffic import generate
    reqs = generate(n, seed, baseline_id="claude-sonnet-4-6")
    return {"requests": [{"messages": r["messages"],
                          "max_tokens": r.get("max_tokens", 400),
                          "temperature": r.get("temperature", 0.0),
                          "wants_json": bool(r.get("response_format"))}
                         for r in reqs]}


@app.get("/judge-prompt")
def judge_prompt():
    """The exact judge system prompt + user template, so a browser→host judge call
    matches the server-side judge."""
    return {"system": _JUDGE_SYSTEM,
            "user_template": ("TASK:\n{task}\n\nBASELINE answer:\n{baseline}\n\n"
                              "CANDIDATE answer:\n{candidate}")}


@app.post("/observe/client")
def observe_client(obs: ClientObservation):
    """Ingest a browser→host-executed observation: log the baseline serve, then
    score each candidate (browser-supplied judge score + server-side heuristics)
    and record a real quality sample. No model is called here."""
    msgs = [{"role": m.role, "content": m.content or ""} for m in obs.messages]
    f = _classify.classify(msgs, max_tokens=obs.max_tokens, wants_json=obs.wants_json)
    b = obs.baseline
    base_cost = cost_usd(REGISTRY, b.model_id, b.in_tokens, b.out_tokens)
    ph, pt = prefix_signature(msgs)
    rkey = request_key(b.model_id, msgs, obs.max_tokens, obs.temperature)
    store.log_event(
        ts=time.time(), mode="observe", task_class=f.task_class,
        requested_model=b.model_id, served_model=b.model_id, strategy="observe",
        in_tokens=b.in_tokens, out_tokens=b.out_tokens, cached_in_tokens=0,
        baseline_cost=base_cost, served_cost=base_cost, saved=0.0, latency_ms=0.0,
        cache_hit=0, deterministic=1 if obs.temperature == 0 else 0,
        request_key=rkey, prefix_hash=ph, prefix_tokens=pt)
    results = []
    for c in obs.candidates:
        q = score_from_texts(b.text, c.text, f, judge_score=c.judge_score,
                             judge_reason=c.judge_reason)
        if q is None:
            continue
        cand_cost = cost_usd(REGISTRY, c.model_id, c.in_tokens, c.out_tokens)
        store.log_quality(
            ts=time.time(), task_class=f.task_class, baseline_model=b.model_id,
            candidate_model=c.model_id, retained=q.retained, method=q.method,
            confidence=q.confidence, judge_score=q.judge_score,
            baseline_cost=base_cost, candidate_cost=cand_cost,
            saved=round(base_cost - cand_cost, 6),
            in_tokens=c.in_tokens, out_tokens=c.out_tokens)
        results.append({"candidate": c.model_id, "executor": c.executor,
                        "retained": q.retained, "method": q.method,
                        "saved_per_req": round(base_cost - cand_cost, 6)})
    return {"task_class": f.task_class, "baseline_executor": b.executor,
            "candidates": results}


@app.post("/reset")
def reset():
    store.reset()
    proxy.response_cache = type(proxy.response_cache)()
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(os.path.join(_STATIC, "index.html"))


if os.path.isdir(_STATIC):
    app.mount("/static", StaticFiles(directory=_STATIC), name="static")
