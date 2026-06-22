"""FastAPI service: the platform console.

Endpoints expose the team's standard platform setup — scaffold a new service
from a free-text description (LLM -> service spec -> generated Terraform/k8s/CI/
service-health files), add it to the service catalog, run the example
price-transparency ingest workload, and read its data-quality score and the
service-health (SLO) view. Stateless; synthetic
data only; no secrets; runs fully offline (the scaffolder has a deterministic
offline parser). Makes no HIPAA claim.
"""

import io
import zipfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from baseplate import __version__, catalog, evaluate, ingest, llm, scaffold, slo
from baseplate.models import HealthResponse, IngestRequest, ScaffoldRequest
from baseplate.scaffold import ServiceSpec

STATIC_DIR = Path(__file__).parent / "static"

# Count of reusable Terraform modules the platform ships (the `service` module +
# the VPC/EKS/RDS/remote-state skeletons under deploy/terraform).
_MODULE_COUNT = 5

app = FastAPI(
    title="baseplate",
    version=__version__,
    description="The team's standard platform setup: reusable infrastructure "
                "(Terraform) + a standard CI/CD pipeline + GitOps delivery + "
                "service-health targets + a self-service service scaffolder.",
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__,
                          catalog=len(catalog.services()), modules=_MODULE_COUNT)


@app.post("/scaffold")
def scaffold_service(req: ScaffoldRequest) -> JSONResponse:
    """Scaffold a new service. Either describe it in free text (the LLM/offline
    parser extracts the spec) or pass an explicit spec. Returns the service
    spec, the routing telemetry, and every generated file.
    """
    routing: dict = {"provider": "explicit", "model": "n/a", "fallbacks": []}
    if req.client_spec is not None and req.mode in (None, "auto", "local"):
        # The browser ran the spec extraction on the user's host Ollama
        # (browser→host) and submitted the result. Use it instead of calling a
        # server-side provider — but re-validate/normalize it through the exact
        # same path as the LLM's own spec output (never trust raw browser input).
        spec = scaffold.spec_from_raw(req.client_spec,
                                      fallback_name=req.description or "")
        routing = {"provider": "ollama (browser→host)",
                   "model": req.model or "host", "fallbacks": []}
    elif req.name:
        spec = ServiceSpec(
            name=req.name,
            language=req.language or "python",
            needs_db=bool(req.needs_db),
            exposes_http=True if req.exposes_http is None else bool(req.exposes_http),
        )
    elif req.description:
        spec, routing = scaffold.extract_spec(req.description, mode=req.mode)
    else:
        return JSONResponse(
            {"error": "provide 'description' (free text) or an explicit 'name'"},
            status_code=400)

    gen = scaffold.generate(spec)
    onboarded = catalog.onboard(gen["spec"]) if req.onboard else None
    return JSONResponse({
        "spec": gen["spec"],
        "routing": routing,
        "files": gen["files"],
        "file_paths": sorted(gen["files"]),
        "onboarded": onboarded,
    })


def _spec_for_request(req: ScaffoldRequest) -> ServiceSpec:
    """Resolve a ServiceSpec from a request, mirroring /scaffold (minus telemetry).

    Used by the .zip download so the bundle is byte-identical to what /scaffold
    showed. Raises ValueError when neither a description nor a name is given.
    """
    if req.client_spec is not None and req.mode in (None, "auto", "local"):
        return scaffold.spec_from_raw(req.client_spec,
                                      fallback_name=req.description or "")
    if req.name:
        return ServiceSpec(
            name=req.name, language=req.language or "python",
            needs_db=bool(req.needs_db),
            exposes_http=True if req.exposes_http is None else bool(req.exposes_http))
    if req.description:
        spec, _ = scaffold.extract_spec(req.description, mode=req.mode)
        return spec
    raise ValueError("provide 'description' (free text) or an explicit 'name'")


@app.post("/scaffold/zip")
def scaffold_zip(req: ScaffoldRequest):
    """Download every generated file for a service as a .zip (deterministic —
    the bundle matches what /scaffold returned for the same input)."""
    try:
        spec = _spec_for_request(req)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    gen = scaffold.generate(spec)
    name = gen["spec"]["name"] if isinstance(gen["spec"], dict) else spec.name
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, content in gen["files"].items():
            zf.writestr(path, content)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}-scaffold.zip"'})


@app.get("/catalog")
def get_catalog() -> dict:
    """The services running on the standard platform setup (the example
    workload, the platform itself, and anything scaffolded with onboard=true)."""
    return {"services": catalog.services(), "count": len(catalog.services())}


@app.post("/ingest")
def post_ingest(req: IngestRequest) -> dict:
    """Run the example price-transparency ingest workload and report its
    data-quality score. Omit 'rows' to use the bundled synthetic rate file."""
    return ingest.score(req.rows)


@app.get("/quality")
def quality() -> dict:
    """The data-quality SLI on the bundled synthetic rate file."""
    return ingest.score()


@app.get("/slo")
def get_slo() -> dict:
    """The SLO view for the ingest+serve workload (data-quality SLI plugged in)."""
    return slo.view()


@app.get("/evals")
def evals() -> dict:
    """Run the scaffolder + data-quality eval and return the summary."""
    return evaluate.run()


@app.get("/llm")
def llm_status() -> dict:
    """Which providers are configured/reachable + the active routing mode."""
    return llm.status()


@app.post("/admin/reset")
def admin_reset() -> dict:
    catalog.reset()
    return {"reset": True, "catalog": len(catalog.services())}


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
