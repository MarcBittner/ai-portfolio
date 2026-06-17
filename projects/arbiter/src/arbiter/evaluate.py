"""Reproducible, offline eval → ``eval-report.md``.

These evals gate the parts that MUST be correct regardless of any live model:
the task classifier, the cost arithmetic, the routing-decision safety (a candidate
below the floor is never selected), the quality heuristics' ordering, and the
end-to-end savings reproducibility. None of them call a model, so they run the
same everywhere.

Run: ``./run.sh eval``  (or ``python -m arbiter.evaluate``)
"""

from __future__ import annotations

import os
import sys

from .classify import Features, classify
from .cost import cost_usd
from .proxy import Proxy
from .quality import heuristics
from .registry import DEFAULT as REG
from .registry import Registry
from .rules import RouteConfig, Ruleset, generate_rules
from .store import Store
from .traffic import generate

_CLASSIFY_SET = [
    ([{"role": "system", "content": "Return JSON with fields name, total"},
      {"role": "user", "content": "Invoice for ACME"}], "extraction"),
    ([{"role": "user", "content": "Classify this ticket as billing or bug"}],
     "classification"),
    ([{"role": "user", "content": "Summarize the following meeting notes"}],
     "summarization"),
    ([{"role": "user", "content": "Write a Python function to sort a list"}],
     "codegen"),
    ([{"role": "user", "content": "Solve this step by step and show your reasoning"}],
     "reasoning"),
    ([{"role": "user", "content": "hi there"}], "chat"),
    ([{"role": "user", "content": "Translate this into Spanish"}], "translation"),
]


def _f(task: str, **kw) -> Features:
    base = dict(task_class=task, approx_in_tokens=100, n_messages=1, max_tokens=400,
                wants_json=False, has_code=False, system_tokens=0, multiturn=False)
    base.update(kw)
    return Features(**base)


def eval_classifier() -> dict:
    ok = 0
    for msgs, expected in _CLASSIFY_SET:
        wants = any("JSON" in (m.get("content") or "") for m in msgs)
        got = classify(msgs, wants_json=wants).task_class
        ok += int(got == expected)
    return {"name": "task-classifier", "metric": "accuracy",
            "score": round(ok / len(_CLASSIFY_SET), 3), "n": len(_CLASSIFY_SET),
            "pass": ok / len(_CLASSIFY_SET) >= 0.85}


def eval_cost() -> dict:
    reg = REG
    # opus: 15/75 $/Mtok. 1000 in, 1000 out = 0.015 + 0.075 = 0.09
    c = cost_usd(reg, "claude-opus-4-8", 1000, 1000)
    # cached: 1000 in of which 1000 cached at 0.10x => 0.0015 + 0.075 = 0.0765
    c_cached = cost_usd(reg, "claude-opus-4-8", 1000, 1000, cached_in_tokens=1000)
    ok = abs(c - 0.09) < 1e-9 and abs(c_cached - 0.0765) < 1e-9
    return {"name": "cost-arithmetic", "metric": "exact",
            "score": 1.0 if ok else 0.0, "detail": f"full={c} cached={c_cached}",
            "pass": ok}


def eval_routing_safety() -> dict:
    """generate_rules must NEVER select a below-floor candidate, and must pick the
    floor-clearing one the rate prefers."""
    cfg = RouteConfig(floor=0.9, rate=0.5, min_samples=3)
    stats = [
        # extraction: cheap cand A clears floor; cand B cheaper but below floor
        dict(task_class="extraction", baseline_model="opus", candidate_model="A",
             n=10, retained=0.96, saved_per_req=0.01, avg_in=100, avg_out=100,
             confidence=0.5),
        dict(task_class="extraction", baseline_model="opus", candidate_model="B",
             n=10, retained=0.70, saved_per_req=0.02, avg_in=100, avg_out=100,
             confidence=0.5),
    ]
    rules = generate_rules(stats, REG, cfg)
    chose_safe = len(rules) == 1 and rules[0].route_to == "A"
    no_below_floor = all(r.retained >= cfg.floor for r in rules)
    return {"name": "routing-safety", "metric": "never-below-floor",
            "score": 1.0 if (chose_safe and no_below_floor) else 0.0,
            "detail": f"chose={[r.route_to for r in rules]} (expected ['A'])",
            "pass": chose_safe and no_below_floor}


def eval_quality_heuristics() -> dict:
    f = _f("chat")
    same = heuristics("The capital is Paris.", "The capital is Paris.", f)
    refuse = heuristics("The capital is Paris.", "I can't help with that.", f)
    s_same = sum(same.values()) / len(same)
    s_refuse = sum(refuse.values()) / len(refuse)
    fx = _f("extraction", wants_json=True)
    js = heuristics('{"a":1,"b":2}', '{"a":1}', fx)
    ok = s_same > 0.95 and s_refuse < s_same and js.get("json", 1) < 1.0
    return {"name": "quality-heuristics-ordering", "metric": "monotonic",
            "score": 1.0 if ok else 0.0,
            "detail": f"identical={s_same:.2f} refusal={s_refuse:.2f} "
                      f"json_partial={js.get('json')}", "pass": ok}


def eval_savings_reproducible() -> dict:
    """The structural (cache) opportunities must be identical across two runs with
    the same seed — proof the analytics are deterministic."""
    def run():
        st = Store(":memory:")
        cfg = RouteConfig(mode="observe")
        px = Proxy(Registry(), cfg, Ruleset(), st, default_model="local")
        for r in generate(60, seed=7, baseline_id="claude-sonnet-4-6"):
            px.handle(r["model"], r["messages"], max_tokens=400, temperature=0.0,
                      json_mode=bool(r.get("response_format")))
        ops = st.opportunities(Registry(), cfg)
        return [(o["kind"], round(o["savings"], 6)) for o in ops]
    a, b = run(), run()
    return {"name": "savings-reproducibility", "metric": "deterministic",
            "score": 1.0 if a == b else 0.0,
            "detail": f"{len(a)} opportunities, identical across runs: {a == b}",
            "pass": a == b}


def main(argv: list[str] | None = None) -> int:
    evals = [eval_classifier(), eval_cost(), eval_routing_safety(),
             eval_quality_heuristics(), eval_savings_reproducible()]
    passed = sum(e["pass"] for e in evals)
    lines = ["# arbiter — eval report", "",
             f"**{passed}/{len(evals)} eval suites passed.**", "",
             "These evals are deterministic and model-free; they gate the logic "
             "that must be correct regardless of any live provider.", "",
             "| suite | metric | score | pass | detail |",
             "|---|---|---|:--:|---|"]
    for e in evals:
        lines.append(f"| {e['name']} | {e['metric']} | {e['score']} | "
                     f"{'✅' if e['pass'] else '❌'} | {e.get('detail', '')} |")
    lines += ["", "## What is NOT in this report", "",
              "Routing **quality retention** is measured live by real shadow-judging "
              "(LLM-judge + heuristics) against a reachable model — it is empirical, "
              "not a fixture, so it is intentionally excluded from this reproducible "
              "offline eval. Run `./run.sh demo` with Ollama or a provider key to see "
              "measured retention.", ""]
    report = "\n".join(lines)
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
                       "eval-report.md")
    with open(out, "w") as fh:
        fh.write(report)
    print(report)
    print(f"\nwrote {out}")
    return 0 if passed == len(evals) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
