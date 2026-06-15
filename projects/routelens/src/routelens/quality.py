"""Quality measurement — the guardrail that stops routelens from "saving" money
by quietly degrading your app.

Quality is **measured, never assumed**: we score a candidate model's output
against the baseline model's output on the *same real request*. Two signals,
both computed from real outputs:

* **Deterministic heuristics** — JSON-validity + key agreement, length ratio,
  lexical similarity, refusal agreement, code-fence agreement. Cheap, always
  available, model-free.
* **LLM judge** — a strong, available model is asked whether the candidate is as
  good as the baseline for this task, returning a 0–1 score + rationale.

``judge()`` returns ``None`` when it has no real candidate/baseline pair to
compare — it will not invent a score. The combined ``retained`` is in [0, 1]:
1.0 means "as good as the baseline," which is the number the routing floor gates
on.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass

from . import providers
from .classify import Features
from .registry import Model, Registry

_REFUSAL = re.compile(
    r"\bI (can'?t|cannot|won'?t|am unable|'m unable)\b|\bas an AI\b|"
    r"\bI'?m (sorry|not able)\b",
    re.IGNORECASE,
)


@dataclass
class QualityScore:
    retained: float            # 0..1 — candidate quality relative to baseline
    method: str                # "llm+heuristics" | "heuristics"
    confidence: float          # 0..1 — higher when the LLM judge participated
    components: dict           # individual heuristic sub-scores
    judge_score: float | None
    judge_rationale: str

    def to_dict(self) -> dict:
        return asdict(self)


def _jaccard(a: str, b: str) -> float:
    ta = set(re.findall(r"\w+", a.lower()))
    tb = set(re.findall(r"\w+", b.lower()))
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def _json_keys(s: str) -> set | None:
    try:
        obj = json.loads(s)
    except Exception:
        m = re.search(r"\{.*\}", s, re.DOTALL)
        if not m:
            return None
        try:
            obj = json.loads(m.group(0))
        except Exception:
            return None
    return set(obj.keys()) if isinstance(obj, dict) else set()


def heuristics(baseline: str, candidate: str, f: Features) -> dict:
    comp: dict[str, float] = {}

    # length ratio — penalise drastically shorter/longer answers
    lb, lc = max(1, len(baseline)), max(1, len(candidate))
    ratio = min(lb, lc) / max(lb, lc)
    comp["length"] = round(ratio, 3)

    # lexical overlap
    comp["similarity"] = round(_jaccard(baseline, candidate), 3)

    # refusal agreement: both answer or both refuse
    rb, rc = bool(_REFUSAL.search(baseline)), bool(_REFUSAL.search(candidate))
    comp["refusal_agree"] = 1.0 if rb == rc else 0.0

    # JSON structure agreement for extraction tasks
    if f.wants_json or f.task_class == "extraction":
        kb, kc = _json_keys(baseline), _json_keys(candidate)
        if kb is None:
            comp["json"] = 1.0 if kc is None else 0.7
        elif kc is None:
            comp["json"] = 0.0  # baseline was valid JSON, candidate isn't
        else:
            comp["json"] = round(
                len(kb & kc) / len(kb | kc), 3) if (kb | kc) else 1.0

    # code-fence agreement for codegen
    if f.task_class == "codegen":
        comp["code"] = 1.0 if (("```" in baseline) == ("```" in candidate)) else 0.5

    return comp


_JUDGE_SYSTEM = (
    "You are a strict evaluation judge for an LLM routing proxy. You are given a "
    "task, a BASELINE answer from a strong model, and a CANDIDATE answer from a "
    "cheaper model. Score how well the candidate could REPLACE the baseline for "
    "this task: 1.0 = as good or better; 0.0 = unusable. Judge correctness, "
    "completeness, and format — not verbosity. Respond ONLY as JSON: "
    '{"score": <0..1>, "reason": "<one sentence>"}.'
)


def pick_judge(reg: Registry) -> Model | None:
    """Pick the strongest available model to act as judge."""
    avail = [m for m in reg.all() if providers.available(m.provider)]
    if not avail:
        return None
    avail.sort(key=lambda m: (m.quality_tier, m.speed), reverse=True)
    return avail[0]


def _llm_judge(judge: Model, prompt: str, baseline: str, candidate: str
               ) -> tuple[float, str] | None:
    user = (f"TASK:\n{prompt}\n\nBASELINE answer:\n{baseline}\n\n"
            f"CANDIDATE answer:\n{candidate}")
    try:
        c = providers.call(judge, [{"role": "system", "content": _JUDGE_SYSTEM},
                                   {"role": "user", "content": user}],
                           max_tokens=200, temperature=0.0, json_mode=True)
        obj = json.loads(re.search(r"\{.*\}", c.text, re.DOTALL).group(0))
        score = float(obj.get("score"))
        return max(0.0, min(1.0, score)), str(obj.get("reason", ""))[:300]
    except Exception:
        return None


def score_from_texts(baseline: str, candidate: str, f: Features, *,
                     judge_score: float | None = None,
                     judge_reason: str = "") -> QualityScore | None:
    """Combine a *pre-computed* judge score (e.g. from a browser→host Ollama call)
    with server-side deterministic heuristics. Same formula as ``judge()``; used by
    the browser→host ingest path so the heavy model calls run on the client while
    the deterministic scoring stays on the server."""
    if not (baseline and baseline.strip()) or not (candidate and candidate.strip()):
        return None
    comp = heuristics(baseline, candidate, f)
    heur_mean = sum(comp.values()) / len(comp) if comp else 0.0
    if judge_score is not None:
        js = max(0.0, min(1.0, float(judge_score)))
        retained = round(0.65 * js + 0.35 * heur_mean, 4)
        return QualityScore(retained, "llm+heuristics (browser→host)", 0.9, comp,
                            js, judge_reason or "browser→host judge")
    return QualityScore(round(heur_mean, 4), "heuristics", 0.5, comp, None,
                        "heuristic comparison only")


def judge(baseline: str, candidate: str, f: Features, *,
          reg: Registry, prompt: str = "", judge_model: Model | None = None,
          use_llm: bool = True) -> QualityScore | None:
    """Measure candidate quality vs baseline. Returns None if there is nothing
    real to compare (missing output)."""
    if not (baseline and baseline.strip()) or not (candidate and candidate.strip()):
        return None

    comp = heuristics(baseline, candidate, f)
    heur_mean = sum(comp.values()) / len(comp) if comp else 0.0

    jm = judge_model if judge_model is not None else (
        pick_judge(reg) if use_llm else None)
    judged = _llm_judge(jm, prompt or "(see answers)", baseline, candidate) if jm \
        else None

    if judged is not None:
        score, reason = judged
        retained = round(0.65 * score + 0.35 * heur_mean, 4)
        return QualityScore(retained, "llm+heuristics", 0.9, comp, score, reason)

    # heuristics-only: still a real measurement of real outputs, lower confidence
    return QualityScore(round(heur_mean, 4), "heuristics", 0.5, comp, None,
                        "no judge model reachable; heuristic comparison only")
