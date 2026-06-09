"""The agent loop: plan → execute tools → collect a trace → answer.

Executes the planner's steps in order, substituting ``{n}`` placeholders in a
step's arguments with earlier observations (so tools chain), and records a full
thought→action→observation trace. Tool errors are caught and surfaced as failed
steps rather than crashing the run — the answer is the last observation.
"""

from dataclasses import dataclass, field

from agent_sandbox import __version__  # noqa: F401  (kept for parity/imports)
from agent_sandbox.planner import plan
from agent_sandbox.tools import TOOLS, ToolError

MAX_STEPS = 8


@dataclass
class TraceStep:
    thought: str
    tool: str
    args: dict
    observation: str
    ok: bool


@dataclass
class AgentRun:
    query: str
    steps: list[TraceStep] = field(default_factory=list)
    answer: str = ""


def _fill(args: dict, observations: list[str]) -> dict:
    out: dict = {}
    for key, value in args.items():
        if isinstance(value, str):
            for i, obs in enumerate(observations):
                value = value.replace(f"{{{i}}}", obs)
        out[key] = value
    return out


def run(query: str) -> AgentRun:
    """Run the agent over ``query`` and return the trace + final answer."""
    observations: list[str] = []
    trace: list[TraceStep] = []
    for step in plan(query)[:MAX_STEPS]:
        args = _fill(step.args, observations)
        tool = TOOLS.get(step.tool)
        try:
            if tool is None:
                raise ToolError(f"unknown tool: {step.tool}")
            observation, ok = tool[0](**args), True
        except ToolError as exc:
            observation, ok = f"error: {exc}", False
        observations.append(observation)
        trace.append(TraceStep(step.thought, step.tool, args, observation, ok))
    answer = observations[-1] if observations else "I couldn't determine an answer."
    return AgentRun(query=query, steps=trace, answer=answer)
