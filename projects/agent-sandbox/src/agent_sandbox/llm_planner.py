"""Optional LLM planner — an alternative to the deterministic rule planner.

Given the query and the tool registry, the LLM proposes an ordered plan as
JSON; tool names are validated against the registry. Returns ``None`` when the
provider is the mock or the response can't be parsed, so the caller falls back
to the rule-based ``plan``. The agent loop and tools are unchanged.
"""

from agent_sandbox import llm
from agent_sandbox.planner import Step
from agent_sandbox.tools import TOOL_NAMES, TOOLS

MAX_STEPS = 6


def _tool_catalog() -> str:
    return "\n".join(f"- {n}: {TOOLS[n][1]}" for n in TOOL_NAMES)


_SYSTEM = (
    "You are a planning module for a ReAct agent. Given a QUESTION and the "
    "available TOOLS, output ONLY a JSON array of steps, each "
    '{"thought": str, "tool": one of the tool names, "args": {..}}. Use a '
    "later step's input by writing {0}, {1}, ... to reference an earlier step's "
    "result. No prose, no code fences."
)


def llm_plan(query: str, provider: str | None = "auto",
             model: str | None = None) -> tuple[list[Step] | None, llm.LLMResult]:
    parsed, result = llm.complete_json(
        f"TOOLS:\n{_tool_catalog()}\n\nQUESTION: {query}", _SYSTEM, provider, model)
    if not isinstance(parsed, list):
        return None, result
    steps: list[Step] = []
    for item in parsed[:MAX_STEPS]:
        if not isinstance(item, dict):
            continue
        tool = item.get("tool")
        args = item.get("args")
        if tool in TOOL_NAMES and isinstance(args, dict):
            steps.append(Step(str(item.get("thought", "")), tool, args))
    return (steps or None), result
