"""FastAPI app — define an agent from a spec or template, then run it.

Endpoints:
  GET  /health          liveness + the active model mode
  GET  /providers       model routing/config (free/paid/offline availability)
  GET  /tools           the tool catalog (name, signature, params)
  GET  /templates       built-in agent templates (with their full spec)
  POST /spec/validate   validate/normalise an AgentSpec
  POST /run             run a task with a template or a full spec
  GET  /                the single-page UI
"""

from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from agent_factory import __version__, agent, llm
from agent_factory.models import HealthResponse, RunRequest, TemplateInfo
from agent_factory.spec import TEMPLATES, AgentSpec, template
from agent_factory.tools import tool_catalog

app = FastAPI(title="agent-factory", version=__version__)
_STATIC = Path(__file__).parent / "static"


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(version=__version__, active_mode=llm.active_mode())


@app.get("/providers")
def providers() -> dict:
    return llm.providers_status()


@app.get("/tools")
def tools() -> list[dict]:
    return tool_catalog()


@app.get("/templates", response_model=list[TemplateInfo])
def templates() -> list[TemplateInfo]:
    return [TemplateInfo(name=name, description=spec.description, spec=spec)
            for name, spec in TEMPLATES.items()]


@app.post("/spec/validate")
def spec_validate(spec: AgentSpec) -> dict:
    """Echo back the normalised spec (422 with details on invalid input)."""
    return {"valid": True, "spec": spec.model_dump()}


@app.post("/run")
def run(request: RunRequest) -> dict:
    if request.spec is not None:
        spec = request.spec
    elif request.template is not None:
        try:
            spec = template(request.template)
        except KeyError as exc:
            raise HTTPException(422, str(exc)) from exc
    else:
        spec = template("assistant")
    try:
        spec = AgentSpec.model_validate(spec.model_dump())
    except ValidationError as exc:
        raise HTTPException(422, exc.errors()) from exc
    result = agent.run(request.task, spec)
    out = asdict(result)
    out["spec"] = spec.model_dump()
    return out


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(_STATIC / "index.html")


app.mount("/static", StaticFiles(directory=_STATIC), name="static")
