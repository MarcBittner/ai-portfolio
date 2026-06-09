"""Per-task routing policy.

Each call type routes independently: pinned to an explicit
``provider:model`` (which jumps the queue but keeps the fallback chain
behind it), or by objective, or inheriting the default objective.
"""

from pydantic import BaseModel, Field, field_validator

from persona_twin.config import RouteObjective

TASKS = (
    "twin_answer", "twin_chat", "twin_interview", "query_rewrite", "rerank",
    "eval_judge",
)


class TaskRoute(BaseModel):
    objective: RouteObjective | None = None
    pin: str | None = None  # "provider:model_id"

    @field_validator("pin")
    @classmethod
    def pin_shape(cls, v: str | None) -> str | None:
        if v is not None and ":" not in v:
            raise ValueError("pin must be 'provider:model_id'")
        return v


class RoutingPolicy(BaseModel):
    default_objective: RouteObjective = "cost"
    tasks: dict[str, TaskRoute] = Field(default_factory=dict)

    @field_validator("tasks")
    @classmethod
    def known_tasks(cls, v: dict[str, TaskRoute]) -> dict[str, TaskRoute]:
        unknown = set(v) - set(TASKS)
        if unknown:
            raise ValueError(f"unknown tasks: {sorted(unknown)}; valid: {list(TASKS)}")
        return v

    def resolve_objective(self, task: str | None) -> RouteObjective:
        route = self.tasks.get(task) if task else None
        if route and route.objective:
            return route.objective
        return self.default_objective

    def resolve_pin(self, task: str | None) -> tuple[str, str] | None:
        route = self.tasks.get(task) if task else None
        if route and route.pin:
            provider, _, model_id = route.pin.partition(":")
            return provider, model_id
        return None


def parse_route_pins(spec: str | None) -> dict[str, str]:
    """Parse ``"task=provider:model,task2=..."`` into ``{task: pin}``.

    Unknown task names and malformed entries are skipped (fail safe) so a bad
    env var degrades to default routing rather than crashing startup."""
    pins: dict[str, str] = {}
    for entry in (spec or "").split(","):
        entry = entry.strip()
        if "=" not in entry:
            continue
        task, _, pin = entry.partition("=")
        task, pin = task.strip(), pin.strip()
        if task in TASKS and ":" in pin:
            pins[task] = pin
    return pins
