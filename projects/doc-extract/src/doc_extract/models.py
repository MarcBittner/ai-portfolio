"""Request/response models for the API."""

from pydantic import BaseModel, ConfigDict, Field


class ExtractRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    text: str = Field(max_length=100_000)
    # accepted as "schema" on the wire; stored as schema_name to avoid shadowing
    schema_name: str = Field(validation_alias="schema", serialization_alias="schema")
    use_llm: bool = True            # Ollama-on by default; fills missing fields
    provider: str = "auto"
    model: str | None = None


class FieldResult(BaseModel):
    name: str
    type: str
    found: bool
    value: str | None = None
    normalized: str | None = None
    valid: bool = False
    confidence: float = 0.0
    start: int | None = None
    end: int | None = None
    method: str | None = None


class RoutingInfo(BaseModel):
    provider: str
    model: str
    fallbacks: list[str] = []


class ExtractResponse(BaseModel):
    schema_name: str = Field(serialization_alias="schema")
    fields: list[FieldResult]
    found: int
    total: int
    routing: RoutingInfo | None = None


class FieldInfo(BaseModel):
    name: str
    type: str
    description: str


class SchemaInfo(BaseModel):
    name: str
    description: str
    fields: list[FieldInfo]


class HealthResponse(BaseModel):
    status: str
    version: str
    schemas: int
    ollama: bool
