"""FastAPI service: run the agent and serve the trace UI.

Stateless, fully offline (deterministic planner + sandboxed tools; no model,
no network, no secrets).
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

from agent_sandbox import __version__
from agent_sandbox.agent import run
from agent_sandbox.models import (
    HealthResponse,
    RunRequest,
    RunResponse,
    StepOut,
    ToolInfo,
)
from agent_sandbox.tools import TOOL_NAMES, TOOLS

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="agent-sandbox",
    version=__version__,
    description="A deterministic ReAct-style agent over safe, offline tools.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__, tools=len(TOOL_NAMES))


@app.get("/tools", response_model=list[ToolInfo])
def list_tools() -> list[ToolInfo]:
    return [ToolInfo(name=n, description=TOOLS[n][1]) for n in TOOL_NAMES]


@app.post("/run", response_model=RunResponse)
def run_agent(request: RunRequest) -> RunResponse:
    result = run(request.query)
    return RunResponse(
        query=result.query,
        steps=[
            StepOut(thought=s.thought, tool=s.tool, args=s.args,
                    observation=s.observation, ok=s.ok)
            for s in result.steps
        ],
        answer=result.answer,
        n_steps=len(result.steps),
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
