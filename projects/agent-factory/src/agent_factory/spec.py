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
    model: str | None = Field(default=None, max_length=200)
    max_steps: int = Field(default=6, ge=1, le=12)
    temperature: float = Field(default=0.2, ge=0.0, le=1.0)
    answer_style: AnswerStyle = "concise"
    guardrails: Guardrails = Field(default_factory=Guardrails)
    # ---- orchestration layer (LangGraph-style durable execution) ----
    hitl: bool = False    # human-in-the-loop: plan, then pause for approval before acting
    checkpoint: bool = False  # persist durable per-thread state (auto-on when hitl)
    audit: bool = True    # append each step's trace to an audit log (governance)

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

# ---- archetypes: the pipeline roles you actually compose ------------------
#
# These are the *kinds of agent you build*, each pre-wired with the role's system
# prompt, a fitting tool subset, the failure mode it guards, and orchestration
# defaults (e.g. the report and orchestrator roles default to human-in-the-loop
# + audit). They're starting specs — edit any field in the spec drawer, then run
# or scaffold. Narrow, independently-testable roles beat one mega-agent.

TEMPLATES.update({
    "ingestion": AgentSpec(
        name="ingestion",
        description="Turn messy inputs into validated, structured data.",
        system_prompt="You are a data-ingestion agent. Parse messy inputs into "
        "structured, validated fields. Extract with regex_extract, read structure "
        "with json_get, and measure with text_stats. NEVER pass through a value you "
        "could not validate — if a field is missing or malformed, say so explicitly "
        "rather than guessing. Guard against garbage-in.",
        tools=["regex_extract", "json_get", "text_stats"],
        audit=True,
    ),
    "retrieval": AgentSpec(
        name="retrieval",
        description="RAG: answer only from retrieved sources, always cited.",
        system_prompt="You are a requirements-retrieval (RAG) agent. Answer ONLY "
        "from what kb_search and doc_fetch return, and cite the source for every "
        "claim. If the sources do not contain the answer, say so and refuse — do "
        "NOT invent a requirement. Guard against fabricated or uncited requirements.",
        tools=["kb_search", "doc_fetch", "text_stats"],
        answer_style="detailed",
        audit=True,
    ),
    "model-construction": AgentSpec(
        name="model-construction",
        description="Assemble a model from validated inputs — never guessed.",
        system_prompt="You are a model-construction agent. Assemble the model for "
        "the study from inputs that are read and validated, never guessed. Pull "
        "values with json_get, derive with calculator, and normalise units with "
        "convert. If a required input is absent, halt and report it — do not "
        "fabricate or mis-type a value. Guard against fabricated/mis-typed inputs.",
        tools=["json_get", "calculator", "convert"],
        temperature=0.0,
        audit=True,
    ),
    "simulation": AgentSpec(
        name="simulation",
        description="Drive the deterministic simulator; interpret + flag anomalies.",
        system_prompt="You are a simulation-orchestration agent. Drive the "
        "deterministic tools to COMPUTE results — never estimate a number yourself. "
        "Use calculator/convert/date_diff for exact values and json_get to read "
        "results, then interpret and flag anomalies. The model decides WHAT to "
        "compute and explains why; the tool computes the number. Guard against the "
        "LLM estimating physics instead of computing it.",
        tools=["calculator", "convert", "date_diff", "json_get"],
        temperature=0.0,
        audit=True,
    ),
    "qa": AgentSpec(
        name="qa",
        description="Cross-check vs the standard; refuse or escalate on a violation.",
        system_prompt="You are a QA / verification agent. Cross-check each output "
        "against the governing standard (look it up with kb_search/doc_fetch) and "
        "re-derive numbers with json_get/regex_extract. On any violation or "
        "uncertainty, REFUSE and escalate rather than letting it pass — calibrated "
        "refusal beats a false approval. Guard against a violation reaching the "
        "deliverable.",
        tools=["kb_search", "doc_fetch", "json_get", "regex_extract"],
        audit=True,
    ),
    "report": AgentSpec(
        name="report",
        description="Draft the stamped deliverable, cited — human before signing.",
        system_prompt="You are a report-generation agent. Draft the deliverable "
        "with citations back to retrieved sources (kb_search/doc_fetch) and tool "
        "results — every figure traceable. The draft is NOT final: a human reviews "
        "and signs. Guard against an unreviewed document reaching a stamp.",
        tools=["kb_search", "doc_fetch", "text_stats"],
        hitl=True,
        audit=True,
    ),
    "orchestrator": AgentSpec(
        name="orchestrator",
        description="Plan, route, own state, keep the audit log, call a human.",
        system_prompt="You are the orchestrator (supervisor). Plan the work, route "
        "each step to the right narrow agent, own the shared state, keep an audit "
        "log of every step, and call for a human before anything is signed. Prefer "
        "delegating to a specialist over doing the work yourself. Guard against an "
        "unrouted, unaudited, or unapproved step.",
        tools=list(TOOL_NAMES),
        hitl=True,
        checkpoint=True,
        audit=True,
    ),
})

# Per-template metadata for the picker: kind (general vs the pipeline archetypes),
# the failure mode the role guards, and pipeline stage order (None = not a stage).
TEMPLATE_META: dict[str, dict] = {
    "assistant": {"kind": "general", "guards": None, "stage": None},
    "researcher": {"kind": "general", "guards": None, "stage": None},
    "calculator": {"kind": "general", "guards": None, "stage": None},
    "analyst": {"kind": "general", "guards": None, "stage": None},
    "ingestion": {"kind": "archetype", "stage": 1,
                  "guards": "garbage-in: unvalidated data passing through"},
    "retrieval": {"kind": "archetype", "stage": 2,
                  "guards": "invented / uncited requirements"},
    "model-construction": {"kind": "archetype", "stage": 3,
                           "guards": "fabricated or mis-typed inputs"},
    "simulation": {"kind": "archetype", "stage": 4,
                   "guards": "the LLM estimating numbers instead of computing them"},
    "qa": {"kind": "archetype", "stage": 5,
           "guards": "a violation reaching the deliverable"},
    "report": {"kind": "archetype", "stage": 6,
               "guards": "an unreviewed document reaching a stamp"},
    "orchestrator": {"kind": "archetype", "stage": 7,
                     "guards": "an unrouted, unaudited, or unapproved step"},
}


def template_meta(name: str) -> dict:
    """Picker metadata for a template (kind / guards / stage); empty if unknown."""
    return TEMPLATE_META.get(name, {"kind": "general", "guards": None, "stage": None})


TEMPLATE_NAMES = list(TEMPLATES)


def template(name: str) -> AgentSpec:
    """Return a fresh copy of a named template (so callers can mutate it)."""
    if name not in TEMPLATES:
        raise KeyError(f"unknown template {name!r}; have: {TEMPLATE_NAMES}")
    return TEMPLATES[name].model_copy(deep=True)
