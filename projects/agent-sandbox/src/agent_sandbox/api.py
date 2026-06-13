"""FastAPI service: run the agent (rule or LLM planner) and serve the trace UI.

The rule-based planner is deterministic and offline. With ``use_llm`` (on by
default) the LLM planner is tried first via the multi-provider router
(Ollama-first), falling back to the rule planner when no provider is reachable.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from agent_sandbox import __version__, llm
from agent_sandbox.agent import run
from agent_sandbox.models import (
    HealthResponse,
    RoutingInfo,
    RunRequest,
    RunResponse,
    StepOut,
    ToolInfo,
)
from agent_sandbox.tools import TOOL_NAMES, TOOLS

STATIC_DIR = Path(__file__).parent / "static"
VALID_PROVIDERS = ("auto", "free", "paid", "offline", *llm.PROVIDERS)

app = FastAPI(
    title="agent-sandbox",
    version=__version__,
    description="ReAct-style agent over safe tools, rule or LLM planner.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__, tools=len(TOOL_NAMES),
                          ollama=llm.reachable())


@app.get("/providers")
def providers() -> dict:
    return llm.providers_status()


@app.get("/tools", response_model=list[ToolInfo])
def list_tools() -> list[ToolInfo]:
    return [ToolInfo(name=n, description=TOOLS[n][1]) for n in TOOL_NAMES]


@app.post("/run", response_model=RunResponse)
def run_agent(request: RunRequest) -> RunResponse:
    if request.provider not in VALID_PROVIDERS:
        raise HTTPException(status_code=422, detail="unknown provider")
    result = run(request.query, request.use_llm, request.provider, request.model)
    routing = None
    if result.routing is not None:
        routing = RoutingInfo(provider=result.routing.provider,
                              model=result.routing.model,
                              fallbacks=result.routing.fallbacks)
    return RunResponse(
        query=result.query,
        steps=[StepOut(thought=s.thought, tool=s.tool, args=s.args,
                       observation=s.observation, ok=s.ok) for s in result.steps],
        answer=result.answer, n_steps=len(result.steps),
        planner=result.planner, routing=routing,
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
