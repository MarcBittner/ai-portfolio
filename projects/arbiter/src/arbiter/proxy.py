"""The proxy core: classify → decide → dispatch → shadow-score → log.

This is where the modes live. In **observe** mode every request is served by its
baseline model unchanged, and a sampled subset is shadow-judged against cheaper
candidates to build the quality evidence. In **route** mode the ruleset picks a
cheaper model when its *measured* retained quality clears the floor, and a smaller
sample keeps being judged so quality drift is caught. Caching (response + prompt
prefix) applies in every non-off mode at zero quality cost.

Cost is always counterfactual-honest: when we route to a cheaper model we price
the baseline at the *same* realized token counts, so ``saved`` is the real price
delta for the work that was actually done — never an inflated estimate.
"""

from __future__ import annotations

import hashlib
import time

from . import cache, classify, providers, quality
from .cost import cost_usd
from .registry import Model, Registry
from .rules import RouteConfig, Ruleset
from .store import Store


def _offline_stub(messages: list[dict], max_tokens: int) -> tuple[str, int, int]:
    """Deterministic last-resort completion when no provider is reachable, so the
    proxy never crashes offline. Quality is *not* measured against this (it isn't
    a real model output) — the analytics simply skip it."""
    user = " ".join(m.get("content") or "" for m in messages
                    if m.get("role") != "system")
    text = ("[offline] arbiter has no model provider reachable; this is a "
            "deterministic stub. Connect Ollama or set a provider key to serve "
            "real completions and measure routing quality. Echo: "
            + user[:200])
    return text, max(1, len(user) // 4), max(1, len(text) // 4)


class Proxy:
    def __init__(self, reg: Registry, cfg: RouteConfig, ruleset: Ruleset,
                 store: Store, *, default_model: str = "local"):
        self.reg = reg
        self.cfg = cfg
        self.ruleset = ruleset
        self.store = store
        self.default_model = default_model
        self.response_cache = cache.ResponseCache()

    # deterministic sampling so behaviour is reproducible (no Math.random)
    @staticmethod
    def _sample(key: str, fraction: float) -> bool:
        if fraction >= 1.0:
            return True
        if fraction <= 0.0:
            return False
        h = int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) % 1000
        return h < fraction * 1000

    def _baseline(self, model_id: str) -> Model:
        m = self.reg.get(model_id)
        if m:
            return m
        # unknown id → synthesize an Ollama target (local) or fall back to default
        if "/" in model_id or ":" in model_id:
            return Model(model_id, "ollama", model_id, 0.0, 0.0, 2, 4, "ad-hoc")
        return self.reg.get(self.default_model) or self.reg.all()[0]

    def _serve(self, model: Model, messages: list[dict], *, max_tokens: int,
               temperature: float, json_mode: bool, prefix_tokens: int):
        """Return (text, in_tok, out_tok, cached_in, latency_ms, served_model_id,
        is_real)."""
        use_cache = (self.cfg.prompt_cache and model.provider == "anthropic"
                     and cache.should_cache_prefix(prefix_tokens))
        try:
            c = providers.call(model, messages, max_tokens=max_tokens,
                               temperature=temperature, json_mode=json_mode,
                               cache_prefix=use_cache)
            return (c.text, c.in_tokens, c.out_tokens, c.cached_in_tokens,
                    c.latency_ms, model.id, True)
        except providers.ProviderError:
            t0 = time.monotonic()
            text, in_t, out_t = _offline_stub(messages, max_tokens)
            return (text, in_t, out_t, 0, round((time.monotonic() - t0) * 1000, 1),
                    "offline", False)

    def handle(self, model_id: str, messages: list[dict], *, max_tokens: int = 1024,
               temperature: float = 0.0, json_mode: bool = False) -> dict:
        cfg = self.cfg
        f = classify.classify(messages, max_tokens=max_tokens, wants_json=json_mode)
        baseline = self._baseline(model_id)
        deterministic = temperature == 0.0
        rkey = cache.request_key(baseline.id, messages, max_tokens, temperature)
        prefix_hash, prefix_tokens = cache.prefix_signature(messages)

        # 1) response cache (exact deterministic repeat → $0, zero quality impact)
        if cfg.mode != "off" and cfg.response_cache and deterministic:
            hit = self.response_cache.get(rkey)
            if hit:
                base_cost = cost_usd(self.reg, baseline.id, hit.in_tokens,
                                     hit.out_tokens)
                self.store.log_event(
                    ts=time.time(), mode=cfg.mode, task_class=f.task_class,
                    requested_model=model_id, served_model=hit.model_id,
                    strategy="response-cache", in_tokens=hit.in_tokens,
                    out_tokens=hit.out_tokens, cached_in_tokens=0,
                    baseline_cost=base_cost, served_cost=0.0, saved=base_cost,
                    latency_ms=0.1, cache_hit=1, deterministic=1, request_key=rkey,
                    prefix_hash=prefix_hash, prefix_tokens=prefix_tokens)
                return self._response(hit.model_id, hit.text, hit.in_tokens,
                                      hit.out_tokens, f, strategy="response-cache",
                                      requested=model_id, baseline=baseline.id,
                                      saved=base_cost, cached=True)

        # 2) decide which model serves
        served_model = baseline
        strategy = "passthrough"
        matched_rule = None
        if cfg.mode == "route":
            rule = self.ruleset.match(f)
            if rule and rule.retained >= cfg.floor:
                cand = self.reg.get(rule.route_to)
                if cand and providers.available(cand.provider):
                    served_model = cand
                    strategy = "route"
                    matched_rule = rule.id
        elif cfg.mode == "observe":
            strategy = "observe"

        # 3) dispatch
        text, in_t, out_t, cached_in, latency, served_id, is_real = self._serve(
            served_model, messages, max_tokens=max_tokens, temperature=temperature,
            json_mode=json_mode, prefix_tokens=prefix_tokens)

        # cache the (deterministic) response for next time
        if cfg.mode != "off" and cfg.response_cache and deterministic and is_real:
            self.response_cache.put(rkey, text, in_t, out_t, served_id)

        # 4) cost (counterfactual-honest: baseline priced at the same tokens).
        # If no real model ran (offline stub), nothing was spent or saved.
        if not is_real:
            served_cost = baseline_cost = saved = 0.0
        else:
            served_cost = cost_usd(self.reg, served_id, in_t, out_t, cached_in)
            baseline_cost = cost_usd(self.reg, baseline.id, in_t, out_t,
                                     cached_in if served_id == baseline.id else 0)
            saved = round(baseline_cost - served_cost, 6)

        self.store.log_event(
            ts=time.time(), mode=cfg.mode, task_class=f.task_class,
            requested_model=model_id, served_model=served_id, strategy=strategy,
            in_tokens=in_t, out_tokens=out_t, cached_in_tokens=cached_in,
            baseline_cost=baseline_cost, served_cost=served_cost, saved=saved,
            latency_ms=latency, cache_hit=0, deterministic=1 if deterministic else 0,
            request_key=rkey, prefix_hash=prefix_hash, prefix_tokens=prefix_tokens)

        # 5) shadow-judge candidates against the real baseline output
        shadow = []
        sample_rate = (cfg.shadow_sample if cfg.mode == "observe"
                       else cfg.route_shadow_sample if cfg.mode == "route" else 0.0)
        if is_real and served_id == baseline.id and self._sample(rkey, sample_rate):
            shadow = self._shadow_judge(baseline, text, in_t, out_t, messages, f,
                                        max_tokens, temperature, json_mode)

        return self._response(served_id, text, in_t, out_t, f, strategy=strategy,
                              requested=model_id, baseline=baseline.id, saved=saved,
                              matched_rule=matched_rule, served_cost=served_cost,
                              baseline_cost=baseline_cost, shadow=shadow,
                              real=is_real)

    def _shadow_judge(self, baseline: Model, base_text: str, base_in: int,
                      base_out: int, messages: list[dict], f, max_tokens: int,
                      temperature: float, json_mode: bool) -> list[dict]:
        prompt = " ".join(m.get("content") or "" for m in messages
                          if m.get("role") != "system")[:1000]
        out = []
        candidates = [c for c in self.reg.cheaper_candidates(baseline.id)
                      if providers.available(c.provider)][:2]
        base_cost = cost_usd(self.reg, baseline.id, base_in, base_out)
        for cand in candidates:
            try:
                cc = providers.call(cand, messages, max_tokens=max_tokens,
                                    temperature=temperature, json_mode=json_mode)
            except providers.ProviderError:
                continue
            q = quality.judge(base_text, cc.text, f, reg=self.reg, prompt=prompt)
            if q is None:
                continue
            cand_cost = cost_usd(self.reg, cand.id, cc.in_tokens, cc.out_tokens)
            self.store.log_quality(
                ts=time.time(), task_class=f.task_class,
                baseline_model=baseline.id, candidate_model=cand.id,
                retained=q.retained, method=q.method, confidence=q.confidence,
                judge_score=q.judge_score, baseline_cost=base_cost,
                candidate_cost=cand_cost, saved=round(base_cost - cand_cost, 6),
                in_tokens=cc.in_tokens, out_tokens=cc.out_tokens)
            out.append({"candidate": cand.id, "retained": q.retained,
                        "method": q.method, "saved_per_req": round(
                            base_cost - cand_cost, 6)})
        return out

    def _response(self, served_id, text, in_t, out_t, f, *, strategy, requested,
                  baseline, saved, matched_rule=None, served_cost=None,
                  baseline_cost=None, cached=False, shadow=None, real=True) -> dict:
        rid = cache.request_key(served_id, [{"content": text}], in_t, out_t)
        return {
            "id": f"chatcmpl-{rid}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": served_id,
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": text}}],
            "usage": {"prompt_tokens": in_t, "completion_tokens": out_t,
                      "total_tokens": in_t + out_t},
            "arbiter": {
                "mode": self.cfg.mode,
                "requested_model": requested,
                "baseline_model": baseline,
                "served_model": served_id,
                "strategy": strategy,
                "task_class": f.task_class,
                "matched_rule": matched_rule,
                "baseline_cost": baseline_cost,
                "served_cost": served_cost,
                "saved": saved,
                "cache_hit": cached,
                "real_model": real,
                "shadow": shadow or [],
            },
        }
