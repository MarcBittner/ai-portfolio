"""Request/response models for the API."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class FieldSpec(BaseModel):
    model_config = ConfigDict(extra="allow")  # constraints (min/max/choices/…)

    name: str
    type: str


class GenerateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    preset: str | None = None
    fields: list[FieldSpec] | None = None
    n: int = Field(default=10, ge=1, le=1000)
    seed: int = 42
    fmt: Literal["json", "csv"] = Field(default="json", validation_alias="format")


class GenerateResponse(BaseModel):
    n: int
    seed: int
    columns: list[str]
    rows: list[dict[str, Any]]


class TypeInfo(BaseModel):
    name: str


class PresetInfo(BaseModel):
    name: str
    fields: list[dict[str, Any]]


class HealthResponse(BaseModel):
    status: str
    version: str
    types: int
    presets: int
