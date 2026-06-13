"""The agent runtime: guard → plan → act → answer → guard.

Given an :class:`AgentSpec` and a task, it scans the input, builds a plan (LLM
planner when a provider is configured, deterministic rule planner otherwise),
executes the tools in order while chaining observations, synthesises a final
answer, and redacts any leaked secrets/PII. Every step is recorded as a
thought→action→observation trace; tool errors become failed steps, never
crashes.
"""

import time
from dataclasses import dataclass, field

from agent_factory import guardrails
from agent_factory.planner import Step
from agent_factory.planner import plan as rule_plan
from agent_factory.spec import AgentSpec
from agent_factory.tools import TOOLS, ToolError

_HARD_BLOCK = {"jailbreak", "prompt-exfiltration"}


@dataclass
class TraceStep:
    thought: str
    tool: str
    args: dict
    observation: str
    ok: bool


@dataclass
class Routing:
    provider: str
    model: str
    fallbacks: list[str] = field(default_factory=list)


@dataclass
class AgentRun:
    agent: str
    task: str
    answer: str
    planner: str = "rule"               # "rule" | "llm"
    blocked: bool = False
    steps: list[TraceStep] = field(default_factory=list)
    routing: Routing | None = None
    input_findings: list[dict] = field(default_factory=list)
    output_findings: list[dict] = field(default_factory=list)
    tokens_estimated: int = 0
    elapsed_ms: float = 0.0


def _fill(args: dict, observations: list[str]) -> dict:
    out: dict = {}
    for key, value in args.items():
        if isinstance(value, str):
            for i, obs in enumerate(observations):
                value = value.replace(f"{{{i}}}", obs)
        out[key] = value
    return out


def _build_plan(task: str, spec: AgentSpec) -> tuple[list[Step], str, Routing | None]:
    """Return (steps, planner_used, routing)."""
    if spec.planner in ("auto", "llm"):
        from agent_factory.llm_planner import llm_plan
        steps, result = llm_plan(task, spec)
        routing = Routing(result.provider, result.model, result.fallbacks)
        if steps is not None:
            return steps, "llm", routing
        # graceful fallback to the deterministic planner
        return rule_plan(task, spec.tools), "rule", routing
    return rule_plan(task, spec.tools), "rule", None


def run(task: str, spec: AgentSpec) -> AgentRun:
    """Execute ``spec`` over ``task`` and return the full run record."""
    started = time.monotonic()

    # 1) input guardrail
    input_findings: list[guardrails.Finding] = []
    if spec.guardrails.input:
        input_findings = guardrails.scan_input(task)
        if any(f.category in _HARD_BLOCK for f in input_findings):
            return AgentRun(
                agent=spec.name, task=task,
                answer="Blocked: the request looks like a prompt-injection / "
                       "jailbreak attempt, so the agent declined to act on it.",
                blocked=True,
                input_findings=guardrails.findings_as_dicts(input_findings),
                elapsed_ms=round((time.monotonic() - started) * 1000, 1),
            )

    # 2) plan
    steps, planner_used, routing = _build_plan(task, spec)

    # 3) act
    observations: list[str] = []
    trace: list[TraceStep] = []
    for step in steps[: spec.max_steps]:
        if step.tool not in spec.tools:
            trace.append(TraceStep(step.thought, step.tool, step.args,
                                   f"error: tool {step.tool!r} not in allowlist",
                                   False))
            observations.append("")
            continue
        args = _fill(step.args, observations)
        tool = TOOLS.get(step.tool)
        try:
            if tool is None:
                raise ToolError(f"unknown tool: {step.tool}")
            observation, ok = tool.fn(**args), True
        except (ToolError, TypeError) as exc:
            observation, ok = f"error: {exc}", False
        observations.append(observation)
        trace.append(TraceStep(step.thought, step.tool, args, observation, ok))

    # 4) answer synthesis
    answer = ""
    if planner_used == "llm":
        from agent_factory.llm_planner import llm_answer
        text, _ = llm_answer(task, spec, observations)
        answer = text or ""
    if not answer:
        good = [o for o, s in zip(observations, trace, strict=False) if s.ok]
        answer = good[-1] if good else (
            observations[-1] if observations
            else "I couldn't find a tool that fits this task.")

    # 5) output guardrail
    output_findings: list[guardrails.Finding] = []
    if spec.guardrails.output:
        answer, output_findings = guardrails.scan_and_redact_output(answer)

    est = (len(spec.system_prompt) + len(task)
           + sum(len(o) for o in observations) + len(answer)) // 4
    return AgentRun(
        agent=spec.name, task=task, answer=answer, planner=planner_used,
        steps=trace, routing=routing,
        input_findings=guardrails.findings_as_dicts(input_findings),
        output_findings=guardrails.findings_as_dicts(output_findings),
        tokens_estimated=est,
        elapsed_ms=round((time.monotonic() - started) * 1000, 1),
    )
