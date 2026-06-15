"""FastAPI app: an OpenAI-compatible proxy endpoint + the control/analytics plane,
plus the static console.

The proxy endpoint (``POST /v1/chat/completions``) is a drop-in: point any
OpenAI-SDK client at this base URL. Everything else is the control plane the
console drives — mode, config, rules, opportunities, and the over-time report.
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import providers
from .models import (
    ChatCompletionRequest,
    ConfigUpdate,
    RuleIn,
    SimulateRequest,
)
from .proxy import Proxy
from .quality import pick_judge
from .registry import DEFAULT as REGISTRY
from .rules import RouteConfig, Rule, Ruleset, generate_rules
from .store import Store

_STATIC = os.path.join(os.path.dirname(__file__), "static")

app = FastAPI(title="routelens", version="0.1.0")

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
              default_model=os.environ.get("ROUTELENS_DEFAULT_MODEL", "local"))


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
    rl = resp["routelens"]
    headers = {
        "x-routelens-strategy": str(rl["strategy"]),
        "x-routelens-served-model": str(rl["served_model"]),
        "x-routelens-baseline-model": str(rl["baseline_model"]),
        "x-routelens-saved-usd": str(rl["saved"]),
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
