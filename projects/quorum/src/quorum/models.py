"""Request/response models for the API."""

from pydantic import BaseModel


# Per-step completions the BROWSER obtained from the user's host Ollama
# (browser→host). The cloud server can't reach localhost; the browser can, so
# when these are supplied the orchestrator uses them for the matching steps
# instead of calling a provider — letting a cloud demo run a real local model.
# Orchestration + governance (redact-before, audit-after) STILL run server-side.
class ReviewRequest(BaseModel):
    contract_id: str | None = None   # a known synthetic contract, or…
    text: str | None = None          # …raw contract text to review
    mode: str | None = None          # auto | paid | local | free | offline
    client_completions: dict[str, str] | None = None  # step id -> raw completion
    client_model: str | None = None  # host Ollama model name (for telemetry)


class RunRequest(BaseModel):
    workflow: str                    # a named WorkflowSpec
    payload: dict = {}               # the workflow's input
    mode: str | None = None
    client_completions: dict[str, str] | None = None  # browser→host (see above)
    client_model: str | None = None


class PlanRequest(BaseModel):
    """Ask the server for each agent step's resolved, redacted prompt."""

    workflow: str                    # a named WorkflowSpec
    payload: dict = {}               # the workflow's input


class HealthResponse(BaseModel):
    status: str
    version: str
    workflows: int
    contracts: int
