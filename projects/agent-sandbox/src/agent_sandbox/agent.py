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
class Routing:
    provider: str
    model: str
    fallbacks: list[str] = field(default_factory=list)


@dataclass
class AgentRun:
    query: str
    steps: list[TraceStep] = field(default_factory=list)
    answer: str = ""
    planner: str = "rule"           # "rule" or "llm"
    routing: Routing | None = None


def exec_tool(name: str, args: dict) -> tuple[str, bool]:
    """Run a single tool server-side with its existing safety; never raises.

    Shared by the in-process loop (:func:`run`) and the per-step ``POST /tool``
    endpoint the browser-driven loop calls. Returns ``(observation, ok)``.
    """
    tool = TOOLS.get(name)
    try:
        if tool is None:
            raise ToolError(f"unknown tool: {name}")
        return tool[0](**args), True
    except ToolError as exc:
        return f"error: {exc}", False
    except TypeError as exc:  # bad/missing args from an untrusted caller
        return f"error: bad arguments for {name}: {exc}", False


def _fill(args: dict, observations: list[str]) -> dict:
    out: dict = {}
    for key, value in args.items():
        if isinstance(value, str):
            for i, obs in enumerate(observations):
                value = value.replace(f"{{{i}}}", obs)
        out[key] = value
    return out


def run(query: str, use_llm: bool = False, provider: str | None = "auto",
        model: str | None = None) -> AgentRun:
    """Run the agent over ``query``. With ``use_llm`` it asks the LLM planner
    first (falling back to the rule planner when no provider is reachable)."""
    planner_used = "rule"
    routing = None
    steps = None
    if use_llm:
        from agent_sandbox.llm_planner import llm_plan
        steps, result = llm_plan(query, provider, model)
        routing = Routing(result.provider, result.model, result.fallbacks)
        if steps is not None:
            planner_used = "llm"
    if steps is None:
        steps = plan(query)

    observations: list[str] = []
    trace: list[TraceStep] = []
    for step in steps[:MAX_STEPS]:
        args = _fill(step.args, observations)
        observation, ok = exec_tool(step.tool, args)
        observations.append(observation)
        trace.append(TraceStep(step.thought, step.tool, args, observation, ok))
    answer = observations[-1] if observations else "I couldn't determine an answer."
    return AgentRun(query=query, steps=trace, answer=answer,
                    planner=planner_used, routing=routing)
