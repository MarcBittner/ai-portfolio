"""LLM planning and answer synthesis via the multi-provider router.

``llm_plan`` asks the model for a JSON plan (a list of tool calls drawn only
from the agent's allowlist); ``llm_answer`` asks it to write the final answer
from the task and the observations. Both degrade gracefully: on the mock
provider or any parse/validation failure they return ``None`` so the caller
falls back to the deterministic path.
"""

from agent_factory import llm
from agent_factory.planner import Step
from agent_factory.spec import AgentSpec
from agent_factory.tools import tool_catalog

_PLAN_SYS = (
    "You are the planner for a tool-using agent. Given a task and a list of "
    "available tools, output a minimal JSON plan: a list of steps, each an object "
    '{"thought": str, "tool": str, "args": object}. Use ONLY the listed tools and '
    "their named arguments. To feed one step's result into a later step, put the "
    'placeholder {0}, {1}, ... (the index of the earlier step) in a string arg. '
    "Output ONLY the JSON array, no prose."
)


def _catalog_text(spec: AgentSpec) -> str:
    lines = []
    for t in tool_catalog(spec.tools):
        args = ", ".join(f"{p['name']}:{p['type']}" for p in t["params"])
        lines.append(f"- {t['name']}({args}) — {t['description']}")
    return "\n".join(lines)


def llm_plan(task: str, spec: AgentSpec) -> tuple[list[Step] | None, llm.LLMResult]:
    """Ask the model for a JSON plan. Returns (steps|None, routing result)."""
    prompt = (
        f"Task:\n{task}\n\nAvailable tools:\n{_catalog_text(spec)}\n\n"
        f"Plan (JSON array, at most {spec.max_steps} steps):"
    )
    parsed, result = llm.complete_json(
        prompt, _PLAN_SYS, provider=spec.provider_hint, model=spec.model)
    if not isinstance(parsed, list):
        return None, result
    allowed = set(spec.tools)
    steps: list[Step] = []
    for raw in parsed[: spec.max_steps]:
        if not isinstance(raw, dict):
            continue
        tool = str(raw.get("tool", "")).strip()
        if tool not in allowed:
            continue
        args = raw.get("args") or {}
        if not isinstance(args, dict):
            continue
        steps.append(Step(str(raw.get("thought", "")).strip() or f"Use {tool}.",
                          tool, {k: v for k, v in args.items()}))
    return (steps or None), result


def llm_answer(task: str, spec: AgentSpec,
               observations: list[str]) -> tuple[str | None, llm.LLMResult]:
    """Synthesise a final answer from the task and tool observations."""
    style = ("Answer in one or two sentences." if spec.answer_style == "concise"
             else "Answer thoroughly, explaining the reasoning.")
    obs = "\n".join(f"[{i}] {o}" for i, o in enumerate(observations)) or "(none)"
    prompt = (
        f"Task:\n{task}\n\nTool observations:\n{obs}\n\n"
        f"Write the final answer grounded in the observations. {style}"
    )
    result = llm.complete(prompt, spec.system_prompt,
                          provider=spec.provider_hint, model=spec.model)
    if result.provider == "mock":
        return None, result
    return result.text.strip(), result
