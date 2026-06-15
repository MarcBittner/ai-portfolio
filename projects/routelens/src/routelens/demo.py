"""Offline-capable end-to-end demo: generate traffic → observe + shadow-judge →
generate rules → route → report realized + projected savings.

Run: ``./run.sh demo``  (or ``python -m routelens.demo``)

With a reachable model (host Ollama or a provider key) you get the *full* story:
real shadow-judged quality, generated rules, and realized routing savings. With
no model reachable, the routing/quality half is honestly skipped ("can't measure
without a model") and the demo still shows the **caching** opportunities, which
are detected structurally from the traffic and need no model call.
"""

from __future__ import annotations

import sys

from . import providers
from .proxy import Proxy
from .quality import pick_judge
from .registry import DEFAULT as REG
from .rules import RouteConfig, Ruleset, generate_rules
from .store import Store
from .traffic import generate


def _bar(label: str, value: float, peak: float, width: int = 28) -> str:
    fill = int(round(width * value / peak)) if peak else 0
    return f"  {label:<22} {'█' * fill}{'·' * (width - fill)} ${value:.4f}"


def main(argv: list[str] | None = None) -> int:
    n = 80
    if argv:
        for a in argv:
            if a.isdigit():
                n = int(a)

    store = Store(":memory:")
    cfg = RouteConfig(mode="observe")
    ruleset = Ruleset()
    proxy = Proxy(REG, cfg, ruleset, store, default_model="local")

    judge = pick_judge(REG)
    have_model = judge is not None
    baseline = judge.id if have_model else "claude-sonnet-4-6"

    print("=" * 64)
    print("routelens — cost/quality routing proxy: end-to-end demo")
    print("=" * 64)
    print(f"providers reachable: {providers.status()['providers']}")
    print(f"baseline model for synthetic traffic: {baseline}")
    qmode = "REAL shadow-judging" if have_model else "unavailable (no model)"
    print(f"quality measurement: {qmode}")
    print()

    # ---- 1) OBSERVE -------------------------------------------------------
    print(f"[1] OBSERVE — sending {n} synthetic requests, shadow-judging cheaper "
          f"candidates...")
    for r in generate(n, seed=1, baseline_id=baseline):
        proxy.handle(r["model"], r["messages"], max_tokens=r.get("max_tokens", 400),
                     temperature=r.get("temperature", 0.0),
                     json_mode=bool(r.get("response_format")))
    s = store.summary()
    print(f"    requests={s['requests']}  baseline_cost=${s['baseline_cost']:.4f}"
          f"  by_strategy={ {k: v['n'] for k, v in s['by_strategy'].items()} }")
    print()

    # ---- 2) OPPORTUNITIES -------------------------------------------------
    print("[2] OPPORTUNITIES (ranked by savings):")
    ops = store.opportunities(REG, cfg)
    if not ops:
        print("    (none yet)")
    for o in ops[:8]:
        qi = ("no quality impact" if o["quality_impact"] == 0
              else f"{o['retained_quality'] * 100:.0f}% retained"
              if o.get("retained_quality") is not None else "")
        print(f"    • [{o['kind']:<14}] {o['detail']}")
        if o["savings"]:
            print(f"      └─ projected savings ${o['savings']:.4f}  {qi}")
    print()

    # ---- 3) QUALITY (measured) -------------------------------------------
    qstats = store.quality_stats()
    if qstats:
        print("[3] MEASURED QUALITY RETENTION (real shadow-judging):")
        for q in sorted(qstats, key=lambda x: x["task_class"]):
            print(f"    {q['task_class']:<14} {q['baseline_model']} → "
                  f"{q['candidate_model']}: {q['retained'] * 100:.0f}% retained "
                  f"(n={q['n']}, {q.get('avg_in', 0)}→{q.get('avg_out', 0)} tok)")
        print()
    else:
        print("[3] MEASURED QUALITY: skipped — no model reachable to shadow-judge.")
        print("    Start Ollama or set a provider key to measure routing quality.")
        print()

    # ---- 4) GENERATE RULES + ROUTE ---------------------------------------
    rules = generate_rules(qstats, REG, cfg)
    ruleset.replace(rules)
    print(f"[4] GENERATED {len(rules)} routing rule(s) "
          f"(floor={cfg.floor}, rate=${cfg.rate}/quality-pt):")
    for r in rules:
        print(f"    {r.id}: {r.match.get('task_class')} → {r.route_to} "
              f"(retained {r.retained * 100:.0f}%, saved/req ${r.saved_per_req:.5f})")
    print()

    if rules and have_model:
        cfg.mode = "route"
        store.reset()
        print("[5] ROUTE — replaying the same traffic with rules active...")
        for r in generate(n, seed=1, baseline_id=baseline):
            proxy.handle(r["model"], r["messages"],
                         max_tokens=r.get("max_tokens", 400),
                         temperature=r.get("temperature", 0.0),
                         json_mode=bool(r.get("response_format")))
        s2 = store.summary()
        print(f"    realized: baseline ${s2['baseline_cost']:.4f} → served "
              f"${s2['served_cost']:.4f}  saved ${s2['saved']:.4f} "
              f"({s2['saved_pct']:.0f}%) at {s2['avg_retained_quality'] * 100:.0f}% "
              f"retained quality")
        print()

    # ---- projection (honest dollar bridge) -------------------------------
    print("[*] PROJECTION at published list prices (quality is measured; dollars "
          "apply a price list to the measured decision):")
    for scen in Store.PRICE_SCENARIOS:
        p = store.projection(cfg, scen)
        print(f"    {p['label']:<18} → ${p['total_savings']:.4f} across "
              f"{len(p['per_task'])} task class(es)")
    print()
    print("Done. `./run.sh serve` for the live console; `./run.sh eval` for the "
          "reproducible eval.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
