"""Declarative workflow specs — the replicable pattern.

A :class:`WorkflowSpec` is data: a name, a description, and an ordered list of
**stages**, where each stage is a single :class:`~quorum.agent.Agent` (sequential)
or a list of agents (parallel fan-out). The same :class:`~quorum.orchestrator.
Orchestrator` runs any spec — *new client = new spec, same governed engine*.

Two specs ship:

* **contract-review** (headline): ``clause_extractor`` → a parallel fan-out of one
  ``risk_scorer`` per risk class → a ``redline_drafter`` synthesis step.
* **policy-qa** (proves replicability): ``retriever`` → ``answerer`` →
  ``citation_checker``. Different domain, different agents, *identical engine
  and governance*.

Each agent carries a ``prompt_fn(state)`` (how it reads shared state into its
prompt) and an ``offline`` deterministic fallback so every workflow runs and the
eval reproduces with zero keys. The agents do fuzzy reasoning; the deterministic
**risk tally** lives in :func:`tally_risks`, not in any agent.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field

from quorum.agent import Agent
from quorum.data import POLICY_KB, RISK_CLASSES, RISK_LABELS


@dataclass
class WorkflowSpec:
    """An ordered DAG of agent stages (a stage = one agent or a parallel list)."""

    name: str
    description: str
    stages: list = field(default_factory=list)

    def step_names(self) -> list[str]:
        names: list[str] = []
        for stage in self.stages:
            agents = stage if isinstance(stage, list) else [stage]
            names.extend(a.name for a in agents)
        return names


def _agent(name: str, role: str, system: str, keys: tuple[str, ...],
           offline: Callable[[str, str], str],
           prompt_fn: Callable[[dict], str]) -> Agent:
    a = Agent(name=name, role=role, system_prompt=system, output_keys=keys,
              offline=offline)
    a.prompt_fn = prompt_fn  # type: ignore[attr-defined]  (orchestrator hook)
    return a


# --------------------------------------------------------------------------- #
# Deterministic offline detectors. These also define the keyword signal each   #
# risk scorer keys on, so the LLM path and the offline path agree on schema.   #
# --------------------------------------------------------------------------- #

# Phrases that signal each risk class (lowercased substring match).
_RISK_SIGNALS: dict[str, tuple[str, ...]] = {
    "auto_renewal": ("automatically renew", "auto-renew", "auto-renews",
                     "successive", "evergreen", "renew for successive"),
    "unlimited_liability": ("unlimited", "without cap", "without limitation",
                            "uncapped", "no cap", "all losses"),
    "ip_assignment": ("assigned to", "assignment of", "work product",
                      "intellectual property conceived", "irrevocably assigned"),
    "data_sharing": ("share, sublicense, or sell", "sell customer data",
                     "data broker", "sell de-identified", "sublicense", "resell"),
    "unilateral_term": ("sole discretion", "unilaterally", "without notice",
                        "modify these terms", "at any time", "replace sub-processors"),
}

# Phrases that NEGATE a risk (a liability cap, a no-assignment clause, etc.).
_RISK_NEGATIONS: dict[str, tuple[str, ...]] = {
    "unlimited_liability": ("shall not exceed", "total liability", "liability cap",
                            "agreed allocation of risk", "limited to the fees"),
    "ip_assignment": ("no assignment of ip", "retains all right",
                      "its own pre-existing"),
    "data_sharing": ("need to know", "no less protective"),
}


def _clause_list(state: dict) -> list[dict]:
    """The extracted clauses from shared state (or the raw input clauses)."""
    extracted = state.get("steps", {}).get("clause_extractor", {})
    clauses = extracted.get("clauses")
    if clauses:
        return clauses
    return state.get("input", {}).get("clauses", [])


def _offline_extract(_system: str, user: str) -> str:
    """Deterministic clause extractor: pull 'Clause N: ...' lines from the doc."""
    clauses = []
    for line in user.splitlines():
        line = line.strip()
        if line.lower().startswith("clause "):
            head, _, body = line.partition(":")
            cid = head.split()[-1] if len(head.split()) > 1 else str(len(clauses) + 1)
            clauses.append({"clause_id": cid, "text": body.strip()})
    return json.dumps({"clauses": clauses})


def _make_offline_scorer(risk_class: str) -> Callable[[str, str], str]:
    """A deterministic risk scorer for one class: substring match minus negations."""
    signals = _RISK_SIGNALS[risk_class]
    negations = _RISK_NEGATIONS.get(risk_class, ())

    def _score(_system: str, user: str) -> str:
        findings = []
        # The user prompt embeds the clauses as JSON; parse them back out.
        clauses = _parse_clauses_from_prompt(user)
        for cl in clauses:
            low = cl.get("text", "").lower()
            if any(neg in low for neg in negations):
                continue
            if any(sig in low for sig in signals):
                findings.append({
                    "clause_id": cl.get("clause_id", "?"),
                    "risk_class": risk_class,
                    "severity": "high" if risk_class in (
                        "unlimited_liability", "data_sharing") else "medium",
                    "rationale": f"Clause matches {RISK_LABELS[risk_class]} signal.",
                })
        return json.dumps({"findings": findings})

    return _score


def _parse_clauses_from_prompt(user: str) -> list[dict]:
    start, end = user.find("["), user.rfind("]")
    if start < 0 or end < start:
        return []
    try:
        obj = json.loads(user[start:end + 1])
        return obj if isinstance(obj, list) else []
    except Exception:
        return []


def _offline_redline(_system: str, user: str) -> str:
    """Deterministic synthesis: summarize the collected findings into a redline."""
    findings = _parse_clauses_from_prompt(user)
    by_class: dict[str, int] = {}
    for f in findings:
        rc = f.get("risk_class", "?")
        by_class[rc] = by_class.get(rc, 0) + 1
    redlines = []
    for f in findings:
        label = RISK_LABELS.get(f.get("risk_class", ""), "review")
        redlines.append({
            "clause_id": f.get("clause_id", "?"),
            "risk_class": f.get("risk_class"),
            "severity": f.get("severity", "medium"),
            "recommendation": f"Negotiate or strike: {label}.",
        })
    high = sum(1 for f in findings if f.get("severity") == "high")
    summary = (
        f"Review found {len(findings)} risky clause(s) across {len(by_class)} "
        f"risk class(es) ({high} high-severity). Recommend redlining each before "
        "signature."
    ) if findings else "No material risks detected; clauses appear standard."
    return json.dumps({"redlines": redlines, "summary": summary})


# --------------------------------------------------------------------------- #
# Deterministic risk tally — NOT an agent. The engine's source of truth.        #
# --------------------------------------------------------------------------- #

def tally_risks(trace_outputs: dict) -> dict:
    """Aggregate the parallel scorers' findings into the flagged-risk report.

    ``trace_outputs`` maps step name -> output dict. Deterministic: de-dupes on
    (clause_id, risk_class) so the count is reproducible regardless of provider.
    """
    flagged: dict[tuple, dict] = {}
    for step, out in trace_outputs.items():
        if not step.startswith("risk_"):
            continue
        for f in out.get("findings", []):
            key = (str(f.get("clause_id")), f.get("risk_class"))
            flagged[key] = f
    findings = list(flagged.values())
    by_class: dict[str, int] = {}
    for f in findings:
        rc = f.get("risk_class", "?")
        by_class[rc] = by_class.get(rc, 0) + 1
    return {"flagged": findings, "by_class": by_class, "count": len(findings)}


# --------------------------------------------------------------------------- #
# Prompt builders (how each agent reads shared state)                           #
# --------------------------------------------------------------------------- #

def _extract_prompt(state: dict) -> str:
    doc = state.get("input", {}).get("text", "")
    return f"Extract every numbered clause from this contract.\n\n{doc}"


def _scorer_prompt(state: dict) -> str:
    clauses = _clause_list(state)
    return ("Assess the following contract clauses for the assigned risk class. "
            "Return only clauses that trigger it.\n\nclauses = "
            + json.dumps(clauses))


def _redline_prompt(state: dict) -> str:
    # Gather all parallel scorer findings into one synthesis prompt.
    all_findings = []
    for step, out in state.get("steps", {}).items():
        if step.startswith("risk_"):
            all_findings.extend(out.get("findings", []))
    return ("Draft a redline summary from these risk findings.\n\nfindings = "
            + json.dumps(all_findings))


# --------------------------------------------------------------------------- #
# Headline workflow: contract-review                                            #
# --------------------------------------------------------------------------- #

def _contract_review_spec() -> WorkflowSpec:
    extractor = _agent(
        "clause_extractor", "Clause Extractor",
        ("You are a contract clause extractor. Read the contract and return STRICT "
         'JSON {"clauses": [{"clause_id": <str>, "text": <str>}]}. Output JSON only.'),
        ("clauses",), _offline_extract, _extract_prompt,
    )
    scorers = []
    for rc in RISK_CLASSES:
        scorers.append(_agent(
            f"risk_{rc}", f"Risk Scorer · {RISK_LABELS[rc]}",
            (f"You assess contract clauses for ONE risk class: {RISK_LABELS[rc]} "
             f"({rc}). Return STRICT JSON {{\"findings\": [{{\"clause_id\": <str>, "
             f"\"risk_class\": \"{rc}\", \"severity\": \"high|medium|low\", "
             f"\"rationale\": <str>}}]}}. Only include clauses that trigger this "
             "risk. Output JSON only."),
            ("findings",), _make_offline_scorer(rc), _scorer_prompt,
        ))
    drafter = _agent(
        "redline_drafter", "Redline Drafter",
        ("You synthesize risk findings into a redline. Return STRICT JSON "
         '{"redlines": [{"clause_id": <str>, "risk_class": <str>, "severity": '
         '<str>, "recommendation": <str>}], "summary": <str>}. Output JSON only.'),
        ("redlines", "summary"), _offline_redline, _redline_prompt,
    )
    return WorkflowSpec(
        name="contract-review",
        description=("Extract clauses, score each risk class in parallel, then "
                     "draft a redline. The headline governed multi-agent workflow."),
        stages=[extractor, scorers, drafter],
    )


# --------------------------------------------------------------------------- #
# Second workflow: policy-qa (same engine, different spec → replicable)         #
# --------------------------------------------------------------------------- #

_STOPWORDS = frozenset((
    "the", "is", "a", "an", "and", "or", "of", "to", "in", "on", "for", "how",
    "does", "do", "it", "what", "when", "are", "with", "this", "that", "be",
    "can", "i", "we", "my", "you", "your", "?",
))


def _terms(text: str) -> set[str]:
    return {w.strip(".,?():#") for w in text.lower().split()
            if w.strip(".,?():#") and w not in _STOPWORDS} - _STOPWORDS


def _offline_retrieve(_system: str, user: str) -> str:
    """Rank policy passages by distinctive (stopword-free) term overlap."""
    q_terms = _terms(user)
    hits = []
    for doc in POLICY_KB:
        overlap = q_terms & (_terms(doc["text"]) | _terms(doc["title"]))
        if overlap:
            hits.append((len(overlap), doc))
    hits.sort(key=lambda x: x[0], reverse=True)
    return json.dumps({"passages": [{"id": d["id"], "title": d["title"],
                                     "text": d["text"]} for _, d in hits[:2]]})


def _offline_answer(_system: str, user: str) -> str:
    passages = _passages_from_prompt(user)
    if not passages:
        return json.dumps({"answer": "No relevant policy found.", "cited": []})
    top = passages[0]
    return json.dumps({
        "answer": top["text"],
        "cited": [p["id"] for p in passages],
    })


def _offline_check(_system: str, user: str) -> str:
    # Verify the answer's cited ids actually exist in the retrieved passages.
    obj = _json_from_prompt(user)
    passages = {p["id"] for p in obj.get("passages", [])}
    cited = obj.get("cited", [])
    grounded = bool(cited) and all(c in passages for c in cited)
    return json.dumps({"grounded": grounded,
                       "unsupported": [c for c in cited if c not in passages]})


def _passages_from_prompt(user: str) -> list[dict]:
    obj = _json_from_prompt(user)
    return obj.get("passages", [])


def _json_from_prompt(user: str) -> dict:
    start, end = user.find("{"), user.rfind("}")
    if start < 0 or end < start:
        return {}
    try:
        obj = json.loads(user[start:end + 1])
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def _retrieve_prompt(state: dict) -> str:
    return state.get("input", {}).get("question", "")


def _answer_prompt(state: dict) -> str:
    passages = state.get("steps", {}).get("retriever", {}).get("passages", [])
    q = state.get("input", {}).get("question", "")
    return (f"Question: {q}\n\nAnswer ONLY from these passages.\n"
            + json.dumps({"passages": passages}))


def _check_prompt(state: dict) -> str:
    passages = state.get("steps", {}).get("retriever", {}).get("passages", [])
    ans = state.get("steps", {}).get("answerer", {})
    return json.dumps({"passages": passages, "cited": ans.get("cited", []),
                       "answer": ans.get("answer", "")})


def _policy_qa_spec() -> WorkflowSpec:
    retriever = _agent(
        "retriever", "Policy Retriever",
        ('You retrieve relevant policy passages for a question. Return STRICT JSON '
         '{"passages": [{"id": <str>, "title": <str>, "text": <str>}]}. JSON only.'),
        ("passages",), _offline_retrieve, _retrieve_prompt,
    )
    answerer = _agent(
        "answerer", "Policy Answerer",
        ('You answer ONLY from the supplied passages. Return STRICT JSON '
         '{"answer": <str>, "cited": [<passage id>]}. Never use outside knowledge. '
         "JSON only."),
        ("answer", "cited"), _offline_answer, _answer_prompt,
    )
    checker = _agent(
        "citation_checker", "Citation Checker",
        ('You verify every cited id is one of the retrieved passages. Return STRICT '
         'JSON {"grounded": <bool>, "unsupported": [<id>]}. JSON only.'),
        ("grounded", "unsupported"), _offline_check, _check_prompt,
    )
    return WorkflowSpec(
        name="policy-qa",
        description=("Retrieve, answer-from-context, then check citations are "
                     "grounded. Same engine + governance, different domain."),
        stages=[retriever, answerer, checker],
    )


# --------------------------------------------------------------------------- #
# Registry                                                                      #
# --------------------------------------------------------------------------- #

def registry() -> dict[str, WorkflowSpec]:
    return {
        "contract-review": _contract_review_spec(),
        "policy-qa": _policy_qa_spec(),
    }


def get_spec(name: str) -> WorkflowSpec | None:
    return registry().get(name)
