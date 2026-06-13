"""The declarative agent specification and the built-in templates.

An :class:`AgentSpec` is the single source of truth for an agent: its role,
the tools it may call, how it plans, which model tier it uses, its step budget,
and its guardrails. It is plain validated data — serialisable to JSON/YAML —
so the same spec that runs here can later drive a project scaffolder.
"""

from typing import Literal

from pydantic import BaseModel, Field, field_validator

from agent_factory.tools import TOOL_NAMES

Planner = Literal["auto", "rule", "llm"]
ModelMode = Literal["auto", "free", "paid", "offline"]
AnswerStyle = Literal["concise", "detailed"]


class Guardrails(BaseModel):
    input: bool = True    # scan the task for prompt-injection before planning
    output: bool = True   # scan the answer for secret / PII leakage before return


class AgentSpec(BaseModel):
    """A complete, runnable agent definition."""

    name: str = Field(default="custom-agent", max_length=60)
    description: str = Field(default="A custom agent.", max_length=200)
    system_prompt: str = Field(
        default="You are a helpful, precise assistant. Use tools when they make "
        "the answer more accurate.",
        max_length=2000,
    )
    tools: list[str] = Field(default_factory=lambda: list(TOOL_NAMES))
    planner: Planner = "auto"
    model_mode: ModelMode = "auto"
    model: str | None = None
    max_steps: int = Field(default=6, ge=1, le=12)
    temperature: float = Field(default=0.2, ge=0.0, le=1.0)
    answer_style: AnswerStyle = "concise"
    guardrails: Guardrails = Field(default_factory=Guardrails)

    @field_validator("tools")
    @classmethod
    def _known_tools(cls, value: list[str]) -> list[str]:
        unknown = [t for t in value if t not in TOOL_NAMES]
        if unknown:
            raise ValueError(
                f"unknown tools: {unknown}; valid: {TOOL_NAMES}"
            )
        # dedupe, preserve order
        seen: dict[str, None] = {}
        for t in value:
            seen.setdefault(t, None)
        return list(seen)

    @property
    def provider_hint(self) -> str:
        """Map model_mode → the router's provider/mode keyword."""
        return self.model_mode


# ---- built-in templates --------------------------------------------------

TEMPLATES: dict[str, AgentSpec] = {
    "assistant": AgentSpec(
        name="assistant",
        description="A general helper with the full toolset.",
        system_prompt="You are a helpful, precise assistant. Break the task into "
        "small steps and use tools (math, conversion, search, text/JSON utilities) "
        "when they make the answer more accurate. Keep answers grounded in tool "
        "results.",
        tools=list(TOOL_NAMES),
    ),
    "researcher": AgentSpec(
        name="researcher",
        description="Answers questions from the knowledge base and document store.",
        system_prompt="You are a research assistant. Find relevant facts with "
        "kb_search and doc_fetch, then answer concisely and cite what you found. "
        "Do not invent facts that the tools did not return.",
        tools=["kb_search", "doc_fetch", "text_stats"],
    ),
    "calculator": AgentSpec(
        name="calculator",
        description="A precise quantitative agent for math, units, and dates.",
        system_prompt="You are a precise quantitative assistant. Use calculator, "
        "convert, and date_diff to compute exact results. Show the final value "
        "clearly and never guess at arithmetic.",
        tools=["calculator", "convert", "date_diff"],
        temperature=0.0,
    ),
    "analyst": AgentSpec(
        name="analyst",
        description="Extracts and computes over structured/unstructured data.",
        system_prompt="You are a data analyst. Pull fields with json_get, extract "
        "patterns with regex_extract, measure text with text_stats, and compute "
        "with calculator. Ground every claim in a tool result.",
        tools=["json_get", "regex_extract", "text_stats", "calculator"],
    ),
}

TEMPLATE_NAMES = list(TEMPLATES)


def template(name: str) -> AgentSpec:
    """Return a fresh copy of a named template (so callers can mutate it)."""
    if name not in TEMPLATES:
        raise KeyError(f"unknown template {name!r}; have: {TEMPLATE_NAMES}")
    return TEMPLATES[name].model_copy(deep=True)
