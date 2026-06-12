"""A minimal OpenTelemetry-style span recorder (in-memory ring buffer).

Models the span shape an OTel exporter would emit — trace/span id, name,
duration, status, attributes — without the SDK dependency. A real deployment
swaps this for the OTel SDK exporting OTLP to Tempo/Jaeger; the instrumentation
call sites stay the same.
"""

from collections import deque
from dataclasses import dataclass, field

_MAX_SPANS = 200


@dataclass
class Span:
    trace_id: str
    span_id: str
    name: str
    duration_ms: float
    status: str            # "ok" | "error"
    attributes: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {"trace_id": self.trace_id, "span_id": self.span_id, "name": self.name,
                "duration_ms": round(self.duration_ms, 1), "status": self.status,
                "attributes": self.attributes}


class Tracer:
    def __init__(self) -> None:
        self._spans: deque[Span] = deque(maxlen=_MAX_SPANS)
        self._seq = 0

    def record(self, name: str, duration_ms: float, status: str,
               attributes: dict | None = None) -> Span:
        self._seq += 1
        span = Span(trace_id=f"{self._seq:032x}", span_id=f"{self._seq:016x}",
                    name=name, duration_ms=duration_ms, status=status,
                    attributes=attributes or {})
        self._spans.append(span)
        return span

    def recent(self, limit: int = 25) -> list[dict]:
        return [s.as_dict() for s in list(self._spans)[-limit:][::-1]]

    def reset(self) -> None:
        self._spans.clear()
        self._seq = 0


tracer = Tracer()
