"""LLM-judge metric: 'is this answer correct given the reference?'

Routed through the multi-provider router (Ollama by default). When no provider
is reachable (mock) or the JSON doesn't parse, it falls back to a deterministic
token-F1 threshold so the metric is always defined and the suite stays offline.
"""

from evalkit import llm
from evalkit.metrics import token_f1

JUDGE_NAME = "llm_judge"
_THRESHOLD = 0.5
_SYSTEM = (
    "You are a strict grader. Given a REFERENCE answer and a candidate ANSWER, "
    'decide if the answer is correct. Return ONLY JSON: {"correct": true|false}.'
)


def judge(prediction: str, reference: str, provider: str | None = "auto",
          model: str | None = None) -> tuple[float, llm.LLMResult]:
    """Return (score in {0.0, 1.0}, routing). Deterministic fallback on mock /
    unreachable / unparseable response."""
    parsed, result = llm.complete_json(
        f"REFERENCE:\n{reference}\n\nANSWER:\n{prediction}", _SYSTEM, provider, model)
    if isinstance(parsed, dict) and isinstance(parsed.get("correct"), bool):
        return (1.0 if parsed["correct"] else 0.0), result
    return (1.0 if token_f1(prediction, reference) >= _THRESHOLD else 0.0), result
