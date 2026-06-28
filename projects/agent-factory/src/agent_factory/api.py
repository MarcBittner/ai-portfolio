"""FastAPI app — define an agent from a spec or template, then run it.

Endpoints:
  GET  /health          liveness + the active model mode
  GET  /providers       model routing/config (free/paid/offline availability)
  GET  /tools           the tool catalog (name, signature, params)
  GET  /templates       built-in agent templates (with their full spec)
  POST /spec/validate   validate/normalise an AgentSpec
  POST /tool            execute ONE deterministic tool server-side
  POST /run             run a task with a template or a full spec
  GET  /                the single-page UI

Browser→host Ollama: the cloud server can't reach a user's local Ollama, but
their browser can. When the UI is in ``local``/``auto`` mode and the browser
probes a reachable host Ollama, it drives the agent's LLM reasoning (planning +
answer synthesis) directly against that local model, and dispatches each tool
call back to :func:`run_tool` so the allowlist, validation, and sandboxed
implementations stay server-side. The browser never executes tools itself.
"""

from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from agent_factory import __version__, agent, evals, llm, scaffold
from agent_factory.models import (
    CustomizeRequest,
    HealthResponse,
    RunRequest,
    ScaffoldRequest,
    TemplateInfo,
    ToolRequest,
    ToolResponse,
)
from agent_factory.spec import TEMPLATES, AgentSpec, template, template_meta
from agent_factory.tools import TOOL_NAMES, TOOLS, ToolError, tool_catalog


def _resolve_spec(spec: AgentSpec | None, name: str | None) -> AgentSpec:
    """Pick the spec: an inline ``spec``, else a ``template`` name, else assistant."""
    if spec is not None:
        chosen = spec
    elif name is not None:
        try:
            chosen = template(name)
        except KeyError as exc:
            raise HTTPException(422, str(exc)) from exc
    else:
        chosen = template("assistant")
    try:
        return AgentSpec.model_validate(chosen.model_dump())
    except ValidationError as exc:
        raise HTTPException(422, exc.errors()) from exc

app = FastAPI(title="agent-factory", version=__version__)
_STATIC = Path(__file__).parent / "static"


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(version=__version__, active_mode=llm.active_mode())


@app.get("/providers")
def providers() -> dict:
    return llm.providers_status()


@app.get("/diagnostics")
def diagnostics(selftest: bool = True) -> dict:
    """App config + routing diagnostics: the resolved provider chain (so you can
    see *why* a route was chosen), provider reachability, models, and an optional
    deterministic self-eval. The one-stop pane for 'which model am I hitting?'."""
    status = llm.providers_status()
    available = status["available"]
    reachable = available["ollama"]
    order = status["default_order"]
    # the lead is the first provider that's actually usable (reachable / keyed);
    # an unreachable Ollama in the chain just falls through to the next one.
    lead = next((p for p in order if available.get(p, p == "mock")), "mock")
    why = {
        "ollama": "a reachable local Ollama leads (free + private)",
        "openrouter": "auto leads with a free OpenRouter model",
        "anthropic": "auto leads with your paid Anthropic key",
        "openai": "auto leads with your paid OpenAI key",
        "mock": "no model is configured or reachable — using the deterministic mock",
    }.get(lead, f"auto leads with {lead!r}")
    out: dict = {
        "version": __version__,
        "routing": {
            "mode": status["mode"],
            "active_mode": status["active_mode"],
            "resolved_order": order,
            "lead_provider": lead,
            "why": why,
            "ollama_reachable": reachable,
            "available": status["available"],
            "models": status["models"],
            "free_models": status["free_models"],
        },
        "tools": {"count": len(TOOL_NAMES), "names": TOOL_NAMES},
        "templates": {"count": len(TEMPLATES)},
    }
    if selftest:
        out["self_eval"] = evals.run_self_eval()
    return out


@app.get("/tools")
def tools() -> list[dict]:
    return tool_catalog()


@app.get("/templates", response_model=list[TemplateInfo])
def templates() -> list[TemplateInfo]:
    return [TemplateInfo(name=name, description=spec.description, spec=spec,
                         **template_meta(name))
            for name, spec in TEMPLATES.items()]


@app.post("/spec/validate")
def spec_validate(spec: AgentSpec) -> dict:
    """Echo back the normalised spec (422 with details on invalid input)."""
    return {"valid": True, "spec": spec.model_dump()}


@app.post("/tool", response_model=ToolResponse)
def run_tool(request: ToolRequest) -> ToolResponse:
    """Execute one deterministic tool, server-side, with full validation.

    Used by the browser→host Ollama loop: the LLM picks the tool + args, but the
    server enforces the allowlist and runs the sandboxed implementation, so a
    crafted browser request can never run an out-of-allowlist or unknown tool.
    Tool errors become a failed observation (``ok=False``), never a 500 — the
    same contract :func:`agent.run` uses for its server-side trace."""
    if request.tool not in TOOL_NAMES:
        raise HTTPException(422, f"unknown tool {request.tool!r}; valid: {TOOL_NAMES}")
    allow = request.tools if request.tools is not None else TOOL_NAMES
    if request.tool not in allow:
        return ToolResponse(
            tool=request.tool, args=request.args, ok=False,
            observation=f"error: tool {request.tool!r} not in allowlist",
        )
    tool = TOOLS[request.tool]
    try:
        observation, ok = tool.fn(**request.args), True
    except (ToolError, TypeError) as exc:
        observation, ok = f"error: {exc}", False
    return ToolResponse(tool=request.tool, args=request.args,
                        observation=observation, ok=ok)


@app.post("/run")
def run(request: RunRequest) -> dict:
    spec = _resolve_spec(request.spec, request.template)
    result = agent.run(request.task, spec)
    out = asdict(result)
    out["spec"] = spec.model_dump()
    return out


@app.post("/spec/customize")
def spec_customize(request: CustomizeRequest) -> dict:
    """AI-assisted: turn a description into a validated spec (model proposes,
    deterministic keyword fallback when offline). Optionally refines a base."""
    base = (_resolve_spec(request.spec, request.template)
            if (request.spec or request.template) else None)
    spec, meta = scaffold.customize_spec(request.prompt, base)
    return {"spec": spec.model_dump(), "meta": meta}


@app.get("/scaffold/languages")
def scaffold_languages() -> dict:
    return {"languages": list(scaffold.LANGUAGES)}


@app.post("/scaffold")
def scaffold_project(
    request: ScaffoldRequest,
    format: str = Query("files", pattern="^(files|dockerfile)$"),
) -> dict:
    """Generate a runnable project (paved road). ``format=files`` returns the
    whole file tree as JSON; ``format=dockerfile`` returns just the Dockerfile."""
    if request.language not in scaffold.LANGUAGES:
        raise HTTPException(422, f"unknown language {request.language!r}; "
                                 f"valid: {list(scaffold.LANGUAGES)}")
    spec = _resolve_spec(request.spec, request.template)
    if format == "dockerfile":
        return {"language": request.language,
                "dockerfile": scaffold.dockerfile(spec, request.language)}
    return {
        "language": request.language,
        "project": scaffold.slug(spec.name),
        "files": scaffold.scaffold(spec, request.language),
    }


@app.post("/scaffold/zip")
def scaffold_project_zip(request: ScaffoldRequest) -> Response:
    """Download the generated project as a zip (README + Dockerfile included)."""
    if request.language not in scaffold.LANGUAGES:
        raise HTTPException(422, f"unknown language {request.language!r}; "
                                 f"valid: {list(scaffold.LANGUAGES)}")
    spec = _resolve_spec(request.spec, request.template)
    data = scaffold.scaffold_zip(spec, request.language)
    filename = f"{scaffold.slug(spec.name)}-{request.language}.zip"
    return Response(
        content=data, media_type="application/zip",
        headers={"content-disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(_STATIC / "index.html")


app.mount("/static", StaticFiles(directory=_STATIC), name="static")
