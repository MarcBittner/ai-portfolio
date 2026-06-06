"""Claim-support judging: LLM judge when live, lexical heuristic offline.

The judge gets one (answer, cited evidence) pair at a time and returns
a structured verdict. In mock mode the lexical heuristic stands in —
weaker, but deterministic and clearly labeled in the report.
"""

from pydantic import BaseModel, Field

from persona_twin.eval.metrics import lexical_support
from persona_twin.llm.base import LLMRequest
from persona_twin.llm.router import LLMRouter

SUPPORT_THRESHOLD = 0.5

JUDGE_SYSTEM = """You are a strict grounding auditor. Given an ANSWER and the
EVIDENCE chunks it cited, decide whether every factual claim in the answer is
supported by the evidence. Style and phrasing are not your concern; facts are.
Unsupported = any claim that the evidence does not state or directly imply."""


class SupportVerdict(BaseModel):
    supported: bool
    unsupported_claims: list[str] = Field(default_factory=list)


async def judge_support(
    answer: str, cited_texts: list[str], router: LLMRouter
) -> tuple[bool, str]:
    """Returns (supported, method). Uses the LLM judge if a real provider
    is configured; otherwise the lexical heuristic."""
    real_providers = [p for p in router.providers if p != "mock"]
    if not real_providers:
        score = lexical_support(answer, cited_texts)
        return score >= SUPPORT_THRESHOLD, "lexical-heuristic"

    evidence = "\n".join(f"- {t}" for t in cited_texts)
    request = LLMRequest(
        system=JUDGE_SYSTEM,
        user=f"ANSWER:\n{answer}\n\nEVIDENCE:\n{evidence}",
        max_tokens=512,
    )
    verdict, _, _ = await router.complete_structured(
        request, SupportVerdict, task="eval_judge"
    )
    return verdict.supported, "llm-judge"
