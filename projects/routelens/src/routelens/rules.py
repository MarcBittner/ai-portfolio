"""Routing ruleset + the global route config.

A rule maps a request *match* (task class, size, json-ness) to a target model,
guarded by a per-rule quality floor. The ruleset is first-match-wins with an
implicit passthrough default. Rules are either auto-generated from measured
quality stats or authored/edited by hand — both carry their evidence
(``confidence``, ``samples``) so a reviewer can see *why* a downgrade is allowed.

The cost/quality control is exactly what was specced:

* **floor** — a hard gate: a candidate is only eligible if its *measured* retained
  quality ≥ floor.
* **rate** ($/quality-point) — a tiebreak *among already-eligible* models:
  ``value = savings_per_req − rate · (1 − retained)``. A low rate ≈ "cheapest that
  clears the floor"; a high rate prefers retaining quality.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .classify import Features
from .registry import Registry


@dataclass
class RouteConfig:
    mode: str = "observe"          # off | observe | route
    floor: float = 0.92            # hard quality gate (retained >= floor)
    rate: float = 0.5              # $/quality-point tiebreak among eligible models
    min_samples: int = 5           # evidence needed before a rule auto-activates
    shadow_sample: float = 1.0     # fraction of traffic to shadow-judge in observe
    route_shadow_sample: float = 0.1  # keep measuring while routing (drift guard)
    response_cache: bool = True    # exact-repeat response caching
    prompt_cache: bool = True      # provider-side prompt-prefix caching

    def to_dict(self) -> dict:
        return asdict(self)

    def update(self, **kw) -> None:
        for k, v in kw.items():
            if hasattr(self, k) and v is not None:
                setattr(self, k, v)


@dataclass
class Rule:
    id: str
    route_to: str                              # target model id
    match: dict = field(default_factory=dict)  # task_class / max_in_tokens / wants_json
    require_quality: float = 0.92
    source: str = "auto"                       # auto | manual
    confidence: float = 0.0
    samples: int = 0
    retained: float = 0.0                      # measured mean retained quality
    saved_per_req: float = 0.0                 # measured mean $ saved / request
    enabled: bool = True

    def to_dict(self) -> dict:
        return asdict(self)

    def matches(self, f: Features) -> bool:
        m = self.match
        if "task_class" in m and m["task_class"] != f.task_class:
            return False
        if "max_in_tokens" in m and f.approx_in_tokens > m["max_in_tokens"]:
            return False
        if "min_in_tokens" in m and f.approx_in_tokens < m["min_in_tokens"]:
            return False
        return not ("wants_json" in m and bool(m["wants_json"]) != f.wants_json)


class Ruleset:
    def __init__(self, rules: list[Rule] | None = None):
        self.rules: list[Rule] = rules or []

    def match(self, f: Features) -> Rule | None:
        for r in self.rules:
            if r.enabled and r.matches(f):
                return r
        return None

    def to_list(self) -> list[dict]:
        return [r.to_dict() for r in self.rules]

    def replace(self, rules: list[Rule]) -> None:
        self.rules = rules

    def upsert(self, rule: Rule) -> None:
        for i, r in enumerate(self.rules):
            if r.id == rule.id:
                self.rules[i] = rule
                return
        self.rules.append(rule)


def generate_rules(stats: list[dict], reg: Registry, cfg: RouteConfig) -> list[Rule]:
    """Build rules from measured quality stats.

    ``stats`` rows: {task_class, baseline_model, candidate_model, n, retained,
    saved_per_req}. For each task class we apply the floor as a hard gate, then the
    $/quality-point rate as a tiebreak to choose the winning candidate.
    """
    by_task: dict[str, list[dict]] = {}
    for s in stats:
        if s["n"] < cfg.min_samples:
            continue
        if s["retained"] < cfg.floor:
            continue
        by_task.setdefault(s["task_class"], []).append(s)

    rules: list[Rule] = []
    for task, cands in by_task.items():
        # value = savings − rate · quality_loss  (tiebreak among floor-clearers)
        best = max(cands, key=lambda s: s["saved_per_req"]
                   - cfg.rate * (1.0 - s["retained"]))
        if best["saved_per_req"] <= 0:
            continue
        rules.append(Rule(
            id=f"auto-{task}-{best['candidate_model']}",
            route_to=best["candidate_model"],
            match={"task_class": task},
            require_quality=cfg.floor,
            source="auto",
            confidence=round(min(1.0, best["n"] / 50.0), 3),
            samples=best["n"],
            retained=round(best["retained"], 4),
            saved_per_req=round(best["saved_per_req"], 6),
        ))
    # cheapest-saving first so the highest-value downgrades match earliest
    rules.sort(key=lambda r: r.saved_per_req, reverse=True)
    return rules
