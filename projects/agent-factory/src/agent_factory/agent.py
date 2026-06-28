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
    status: str = "complete"            # "complete" | "awaiting_approval" | "blocked"
    steps: list[TraceStep] = field(default_factory=list)
    routing: Routing | None = None
    input_findings: list[dict] = field(default_factory=list)
    output_findings: list[dict] = field(default_factory=list)
    tokens_estimated: int = 0
    elapsed_ms: float = 0.0
    thread_id: str | None = None        # set by the orchestrator for durable runs


def _fill(args: dict, observations: list[str]) -> dict:
    out: dict = {}
    for key, value in args.items():
        if isinstance(value, str):
            for i, obs in enumerate(observations):
                value = value.replace(f"{{{i}}}", obs)
        out[key] = value
    return out


def build_plan(task: str, spec: AgentSpec) -> tuple[list[Step], str, Routing | None]:
    """Return (steps, planner_used, routing) — the *plan* half of a run.

    Exposed so an orchestrator can checkpoint the plan and pause for human
    approval before :func:`execute` acts on it (human-in-the-loop)."""
    if spec.planner in ("auto", "llm"):
        from agent_factory.llm_planner import llm_plan
        steps, result = llm_plan(task, spec)
        routing = Routing(result.provider, result.model, result.fallbacks)
        if steps is not None:
            return steps, "llm", routing
        # graceful fallback to the deterministic planner
        return rule_plan(task, spec.tools), "rule", routing
    return rule_plan(task, spec.tools), "rule", None


def input_guard(task: str, spec: AgentSpec) -> list[guardrails.Finding]:
    """Scan the task for prompt-injection / jailbreak phrasing."""
    if not spec.guardrails.input:
        return []
    return guardrails.scan_input(task)


def is_blocked(findings: list[guardrails.Finding]) -> bool:
    """True when the input findings include a hard-block category."""
    return any(f.category in _HARD_BLOCK for f in findings)


def blocked_run(spec: AgentSpec, task: str, findings: list[guardrails.Finding],
                started: float | None = None) -> AgentRun:
    started = time.monotonic() if started is None else started
    return AgentRun(
        agent=spec.name, task=task,
        answer="Blocked: the request looks like a prompt-injection / "
               "jailbreak attempt, so the agent declined to act on it.",
        blocked=True, status="blocked",
        input_findings=guardrails.findings_as_dicts(findings),
        elapsed_ms=round((time.monotonic() - started) * 1000, 1),
    )


def execute(task: str, spec: AgentSpec, steps: list[Step], planner_used: str,
            routing: Routing | None,
            input_findings: list[guardrails.Finding] | None = None,
            started: float | None = None) -> AgentRun:
    """The *act → answer → guard* half of a run, over an already-built plan.

    Split out from :func:`run` so an orchestrator can run it *after* a human
    approves the checkpointed plan (the approve-before-acting gate)."""
    started = time.monotonic() if started is None else started
    input_findings = input_findings or []

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
        status="complete", steps=trace, routing=routing,
        input_findings=guardrails.findings_as_dicts(input_findings),
        output_findings=guardrails.findings_as_dicts(output_findings),
        tokens_estimated=est,
        elapsed_ms=round((time.monotonic() - started) * 1000, 1),
    )


def run(task: str, spec: AgentSpec) -> AgentRun:
    """Execute ``spec`` over ``task`` end to end: guard → plan → act → answer.

    For durable, resumable, human-in-the-loop runs use
    :func:`agent_factory.orchestrate.run` instead — it inserts a checkpoint and
    an approval gate between :func:`build_plan` and :func:`execute`."""
    started = time.monotonic()
    findings = input_guard(task, spec)
    if is_blocked(findings):
        return blocked_run(spec, task, findings, started)
    steps, planner_used, routing = build_plan(task, spec)
    return execute(task, spec, steps, planner_used, routing, findings, started)
