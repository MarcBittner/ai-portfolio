"""Request/response models for the API."""

from pydantic import BaseModel


class ReviewRequest(BaseModel):
    contract_id: str | None = None   # a known synthetic contract, or…
    text: str | None = None          # …raw contract text to review
    mode: str | None = None          # auto | paid | local | free | offline


class RunRequest(BaseModel):
    workflow: str                    # a named WorkflowSpec
    payload: dict = {}               # the workflow's input
    mode: str | None = None


class HealthResponse(BaseModel):
    status: str
    version: str
    workflows: int
    contracts: int
