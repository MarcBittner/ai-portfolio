"""The grounded copilot: guardrail → retrieve → compute → narrate → verify.

This module wires the deterministic core to the LLM under strict rules so the
narration can never become the source of truth:

  1. **Guardrail first** (:mod:`counsel.guardrail`) — discriminatory or
     unlicensed-advice asks are refused *before* any retrieval or model call.
  2. **Retrieve + compute** (:mod:`counsel.retrieve`, :mod:`counsel.compute`) —
     a deterministic intent maps the question to a code-computed answer plus the
     records that back it. Ungrounded questions short-circuit to an honest
     "not in your records" refusal — the model is never asked to guess.
  3. **Narrate** — the LLM is handed the *code-computed* facts and asked only to
     phrase them and cite record ids. It is told the numbers are authoritative
     and that it may cite only the provided ids. With no provider, a
     deterministic offline narrator runs — the app works with zero keys.
  4. **Validate citations** — every id the model emits is checked against the
     retrieved set; hallucinated cites are dropped (and surfaced, to show the
     gate working).
  5. **Verify** — the model's stated numbers are extracted and compared to the
     code-computed figures; any drift is flagged. The model literally cannot
     change a balance: if it states a wrong number, verify catches it and the
     UI shows the code value as authoritative.

Everything is deterministic except step 3, and step 3 has a deterministic
fallback — so the whole pipeline runs, and the eval reproduces, with no keys.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from counsel import guardrail, llm, retrieve
from counsel.compute import Computation
from counsel.data import Dataset

SYSTEM = (
    "You are counsel, a careful personal-finance assistant. You are given a "
    "user's question, a set of FACTS that were computed by trusted code from "
    "the user's own records, and the RECORD IDS those facts are drawn from.\n"
    "Rules you must follow exactly:\n"
    "1. The FACTS are authoritative. State the numbers EXACTLY as given — never "
    "recompute, round differently, or invent a figure.\n"
    "2. Answer ONLY from the FACTS and RECORDS provided. If something is not "
    "there, say you don't have it — never guess.\n"
    "3. Cite the record ids you used in a \"citations\" list, using ONLY ids "
    "from the provided RECORD IDS.\n"
    "4. Do not give investment, tax, or legal advice. Describe and explain only.\n"
    'Return STRICT JSON: {"answer": "<one or two sentences>", '
    '"citations": ["<id>", ...]}. Output JSON only.'
)


@dataclass
class VerifyRow:
    label: str
    code_value: float
    stated_value: float | None
    ok: bool


@dataclass
class AnswerResult:
    question: str
    refused: bool
    refusal_reason: str             # "" | "guardrail:<cat>" | "ungrounded"
    answer: str
    intent: str
    facts: dict
    citations: list[str]            # validated
    dropped_citations: list[str]    # hallucinated, dropped
    verify: list[VerifyRow] = field(default_factory=list)
    verified_ok: bool = True
    records: list[dict] = field(default_factory=list)
    routing: dict = field(default_factory=dict)
    proposals_available: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "question": self.question,
            "refused": self.refused,
            "refusal_reason": self.refusal_reason,
            "answer": self.answer,
            "intent": self.intent,
            "facts": self.facts,
            "citations": self.citations,
            "dropped_citations": self.dropped_citations,
            "verify": [vars(v) for v in self.verify],
            "verified_ok": self.verified_ok,
            "records": self.records,
            "routing": self.routing,
            "proposals_available": self.proposals_available,
        }


# --------------------------------------------------------------------------- #
# Offline deterministic narrator (no LLM). Phrases the code facts honestly.    #
# --------------------------------------------------------------------------- #

def _fmt_usd(x: float) -> str:
    return f"${x:,.2f}"


def _offline_narration(comp: Computation, r: retrieve.Retrieval) -> str:
    intent, f = comp.intent, comp.facts
    win = r.window_label
    if intent == "net_worth":
        return (f"Your net worth is {_fmt_usd(f['net_worth'])}: "
                f"{_fmt_usd(f['assets'])} in assets minus "
                f"{_fmt_usd(f['liabilities'])} in liabilities.")
    if intent == "balance":
        return f"That account's balance is {_fmt_usd(f['balance'])} {win}."
    if intent == "category_spend":
        cat = comp.detail.get("category", "that category")
        return (f"You spent {_fmt_usd(f['total'])} on {cat} over {win}, across "
                f"{int(f['transactions'])} transactions.")
    if intent == "spend_breakdown":
        top = list(comp.detail["by_category"].items())[:3]
        parts = ", ".join(f"{c} {_fmt_usd(v)}" for c, v in top)
        return (f"Over {win} you spent {_fmt_usd(f['total_outflow'])} total. "
                f"Top categories: {parts}.")
    if intent == "unusual_charges":
        n = int(f["flagged"])
        if n == 0:
            return f"I found no unusual charges over {win}."
        return (f"I flagged {n} unusual charge(s) over {win}: "
                f"{int(f['duplicates'])} duplicate group(s) and "
                f"{int(f['outliers'])} outlier(s).")
    if intent == "project_balance":
        return (f"Projecting your checking forward {int(f['horizon_days'])} days at "
                f"the recent average net flow of {_fmt_usd(f['avg_daily_net'])}/day, "
                f"you'd have about {_fmt_usd(f['projected_balance'])} (now "
                f"{_fmt_usd(f['current_balance'])}). Mechanical extrapolation, "
                "not a guarantee.")
    if intent == "list_transactions":
        return (f"I found {int(f['count'])} transaction(s) over {win} "
                "(listed with their record ids).")
    return "Here is what your records show."


def _offline_responder(comp: Computation, r: retrieve.Retrieval):
    """Build the (system, user) -> text offline fn the router falls back to."""
    text = json.dumps({"answer": _offline_narration(comp, r),
                       "citations": comp.citation_ids})

    def fn(_system: str, _user: str) -> str:
        return text
    return fn


# --------------------------------------------------------------------------- #
# Prompt + parse                                                               #
# --------------------------------------------------------------------------- #

def _build_user_prompt(comp: Computation, r: retrieve.Retrieval) -> str:
    facts = {k: v for k, v in comp.facts.items()}
    record_ids = comp.citation_ids
    return (
        f"QUESTION: {r.question}\n"
        f"INTENT: {comp.intent}  WINDOW: {r.window_label}\n"
        f"FACTS (authoritative, computed by code): {json.dumps(facts)}\n"
        f"RECORD IDS you may cite: {json.dumps(record_ids)}\n"
        "Phrase the answer for the user using exactly these numbers, and cite "
        "the record ids you used."
    )


def _parse(text: str) -> tuple[str, list[str]]:
    s = (text or "").strip()
    if "```" in s:
        parts = s.split("```")
        if len(parts) >= 2:
            s = parts[1].removeprefix("json").strip()
    start, end = s.find("{"), s.rfind("}")
    obj: dict = {}
    if start >= 0 and end > start:
        try:
            obj = json.loads(s[start:end + 1])
        except Exception:
            obj = {}
    if not isinstance(obj, dict):
        obj = {}
    answer = obj.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        # Model returned prose, not JSON — use it verbatim, no citations.
        answer = s if s else "I don't have an answer for that."
    cites = obj.get("citations", [])
    if not isinstance(cites, list):
        cites = []
    cites = [str(c) for c in cites if isinstance(c, str | int)]
    return answer.strip(), cites


# --------------------------------------------------------------------------- #
# Verify: extract numbers the model stated and compare to code-computed facts  #
# --------------------------------------------------------------------------- #

_NUM_RE = re.compile(r"-?\$?\s*\d[\d,]*(?:\.\d+)?")

# The headline facts each intent's narration is expected to state, in order.
# Verify checks exactly these against the model's text — the numbers a user
# reads — rather than every internal fact (some facts are inputs, not output).
_VERIFY_FACTS: dict[str, list[str]] = {
    "net_worth": ["net_worth", "assets", "liabilities"],
    "balance": ["balance"],
    "category_spend": ["total"],
    "spend_breakdown": ["total_outflow"],
    "project_balance": ["projected_balance", "current_balance"],
    "unusual_charges": [],          # count intent — nothing to dollar-verify
    "list_transactions": [],
}


def _stated_numbers(answer: str) -> list[float]:
    out: list[float] = []
    for m in _NUM_RE.findall(answer):
        cleaned = m.replace("$", "").replace(",", "").replace(" ", "")
        try:
            out.append(round(float(cleaned), 2))
        except ValueError:
            continue
    return out


def _verify(comp: Computation, answer: str) -> tuple[list[VerifyRow], bool]:
    """For each headline code-fact, check the model stated it (within a cent).

    Only USD facts are verified (the meaningful figures a user reads). A fact is
    OK if the model's text contains a number equal to it; mismatch is flagged.
    """
    stated = set(_stated_numbers(answer))
    rows: list[VerifyRow] = []
    all_ok = True
    labels = _VERIFY_FACTS.get(comp.intent, [])
    for label in labels:
        if label not in comp.facts:
            continue
        value = comp.facts[label]
        if not isinstance(value, int | float):
            continue
        v = round(float(value), 2)
        present = any(abs(v - s) < 0.01 for s in stated)
        if not present:
            all_ok = False
        rows.append(VerifyRow(label=label, code_value=v,
                              stated_value=next((s for s in stated
                                                 if abs(v - s) < 0.01), None),
                              ok=present))
    return rows, all_ok


# --------------------------------------------------------------------------- #
# Public entry point                                                           #
# --------------------------------------------------------------------------- #

_PROPOSAL_FOR_INTENT = {
    "unusual_charges": "flag_charge",
    "spend_breakdown": "set_budget",
    "category_spend": "set_budget",
    "net_worth": "recommend_rebalance",
}


# --------------------------------------------------------------------------- #
# Deterministic core (guardrail → retrieve → compute), shared by every path.   #
# --------------------------------------------------------------------------- #

def _guardrail_refusal(question: str, verdict: guardrail.Verdict) -> AnswerResult:
    return AnswerResult(
        question=question, refused=True,
        refusal_reason=f"guardrail:{verdict.category}",
        answer=verdict.message, intent="refused", facts={}, citations=[],
        dropped_citations=[],
        routing={"provider": "guardrail", "model": "deterministic",
                 "mode": "n/a", "blocked": True},
    )


def _ungrounded_refusal(question: str) -> AnswerResult:
    return AnswerResult(
        question=question, refused=True, refusal_reason="ungrounded",
        answer=("I can't find that in your records. I can answer questions "
                "about your balances, spending by category, net worth, "
                "unusual charges, or a simple balance projection."),
        intent="unknown", facts={}, citations=[], dropped_citations=[],
        routing={"provider": "offline", "model": "deterministic",
                 "mode": "n/a"},
    )


def _finalize_narration(
    question: str, comp: Computation, r: retrieve.Retrieval,
    raw_answer: str, raw_cites: list[str], routing: dict,
) -> AnswerResult:
    """Apply the trust gates (validate citations, verify numbers) to one
    narration — whoever produced it. This is the single place the server
    enforces the trust boundary, so a server-routed, an offline, and a
    browser→host narration are all gated identically.
    """
    # 4. Validate citations against the retrieved set; drop hallucinations.
    val = retrieve.validate_citations(raw_cites, comp.citation_ids)

    # 5. Verify the stated numbers against the code-computed facts.
    verify_rows, verified_ok = _verify(comp, raw_answer)

    proposals: list[str] = []
    kind = _PROPOSAL_FOR_INTENT.get(comp.intent)
    if kind:
        proposals.append(kind)

    return AnswerResult(
        question=question, refused=False, refusal_reason="",
        answer=raw_answer, intent=comp.intent, facts=comp.facts,
        citations=val["valid"], dropped_citations=val["dropped"],
        verify=verify_rows, verified_ok=verified_ok, records=r.records,
        routing=routing, proposals_available=proposals,
    )


@dataclass
class Prepared:
    """The output of the deterministic core for a browser→host narration.

    Either a ready-to-return ``refusal`` (guardrail/ungrounded — no narration is
    needed, the model is never asked to guess), or the exact SYSTEM + built user
    prompt the browser should send its local Ollama, plus the computed facts and
    citable ids the server will re-verify the narration against on finalize.
    """

    refusal: AnswerResult | None
    intent: str = ""
    system_prompt: str = ""
    user_prompt: str = ""
    facts: dict = field(default_factory=dict)
    citation_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        if self.refusal is not None:
            return {"refused": True, "result": self.refusal.to_dict()}
        return {
            "refused": False,
            "intent": self.intent,
            "system_prompt": self.system_prompt,
            "user_prompt": self.user_prompt,
            "facts": self.facts,
            "citation_ids": self.citation_ids,
        }


def prepare(ds: Dataset, question: str) -> Prepared:
    """Deterministic core for the browser→host path.

    Runs guardrail + retrieve + compute (never calls a provider) and returns
    either a refusal (so the browser shows it without an Ollama call) or the
    exact prompt counsel would send the LLM. The browser runs the narration; the
    server re-derives all of this on :func:`answer` to verify it.
    """
    question = (question or "").strip()

    verdict = guardrail.check(question)
    if not verdict.allowed:
        return Prepared(refusal=_guardrail_refusal(question, verdict))

    r, comp = retrieve.route(ds, question)
    if comp is None or not r.grounded:
        return Prepared(refusal=_ungrounded_refusal(question))

    return Prepared(
        refusal=None, intent=comp.intent, system_prompt=SYSTEM,
        user_prompt=_build_user_prompt(comp, r),
        facts=comp.facts, citation_ids=comp.citation_ids,
    )


def answer(ds: Dataset, question: str, *, mode: str | None = None,
           client_summary: str | None = None,
           client_model: str | None = None) -> AnswerResult:
    """Run the full grounded, verified pipeline for one question.

    ``client_summary`` is the trust-safe browser→host hook: when present, the
    server still re-runs guardrail + retrieve + compute itself (it NEVER trusts
    client-supplied facts), but uses ``client_summary`` as the narration TEXT
    instead of calling a provider. That text is then run through the identical
    citation-validation + number-verification gates — so a hostile or garbled
    local narration (wrong number / hallucinated id) is caught exactly as a
    cloud model's would be. ``client_model`` is the host model name, echoed into
    routing for display only.
    """
    question = (question or "").strip()

    # 1. Guardrail — refuse discriminatory / unlicensed-advice asks up front.
    verdict = guardrail.check(question)
    if not verdict.allowed:
        return _guardrail_refusal(question, verdict)

    # 2. Retrieve + compute (deterministic — the source of truth for verify).
    r, comp = retrieve.route(ds, question)
    if comp is None or not r.grounded:
        return _ungrounded_refusal(question)

    # 3. Narrate. Browser→host: the narration text was produced by the user's
    #    local Ollama and passed in; the server does NOT call a provider, but it
    #    still verifies the text below against its own freshly-computed facts.
    if client_summary is not None:
        raw_answer, raw_cites = _parse(client_summary)
        routing = {
            "provider": "ollama (browser→host)",
            "model": client_model or "host", "mode": mode or "local",
            "latency_ms": None, "cost_usd": 0.0, "fallbacks": [],
        }
    else:
        res = llm.complete(SYSTEM, _build_user_prompt(comp, r),
                           offline=_offline_responder(comp, r), mode=mode,
                           json_mode=True, max_tokens=400)
        raw_answer, raw_cites = _parse(res.text)
        routing = {
            "provider": res.provider, "model": res.model, "mode": res.mode,
            "latency_ms": res.latency_ms, "cost_usd": res.cost_usd,
            "fallbacks": res.fallbacks,
        }

    # 4 + 5. Validate citations and verify numbers — the trust gates, applied to
    #         every narration source identically.
    return _finalize_narration(question, comp, r, raw_answer, raw_cites, routing)
