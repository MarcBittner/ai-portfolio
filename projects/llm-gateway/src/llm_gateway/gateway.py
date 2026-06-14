"""The governed request path.

One function, ``complete``, runs every request through the same pipeline:

    input firewall → redact input → route to provider → output firewall
    → redact output → append to the tamper-evident audit log

Governance is not a wrapper a caller can forget — it *is* the path. Blocked
requests still produce an audit entry. Only redacted text is ever logged.
"""

from dataclasses import asdict, dataclass, field

from llm_gateway import audit, firewall, llm, redact
from llm_gateway.policy import DEFAULT, Policy

_AUDIT_TEXT_CAP = 500  # store at most this many chars of redacted text per side


@dataclass
class GovernedResult:
    output: str
    provider: str
    model: str
    latency_ms: float
    input_scan: dict
    output_scan: dict
    redactions: dict
    blocked: str | None
    audit_seq: int | None
    routing_fallbacks: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return asdict(self)


def complete(prompt: str, system: str = "You are a precise assistant.",
             provider: str | None = "auto", model: str | None = None,
             policy: Policy = DEFAULT,
             client_completion: str | None = None) -> GovernedResult:
    # 1. input firewall (always scanned for visibility; enforced per policy)
    in_v = firewall.scan(prompt, "input")
    if policy.firewall_input and in_v.verdict == "block":
        return _finalize(
            prompt="[blocked]", output="[blocked: input violated policy]",
            provider="-", model="-", latency_ms=0.0, in_v=in_v,
            out_v=firewall.scan("", "output"), in_red=[], out_red=[],
            blocked="input", policy=policy, fallbacks=[],
        )

    # 2. redact PII/secrets before the provider ever sees them
    sent, in_red = redact.redact(prompt) if policy.redact_input else (prompt, [])

    # 3. obtain the completion.
    if client_completion is not None:
        # Browser→host: the browser already ran the model completion on the user's
        # host Ollama and supplied it here. Skip server-side provider routing — but
        # the FULL governance pipeline below (output firewall + redact + audit) still
        # runs on the supplied completion. Governance is never bypassed.
        result = llm.LLMResult(
            text=client_completion, provider="ollama (browser→host)",
            model=model or "host", latency_ms=0.0, fallbacks=[],
        )
    else:
        # route to a provider (offline-first; mock terminal)
        result = llm.complete(sent, system, provider, model)

    # 4. output firewall + 5. redact output
    out_v = firewall.scan(result.text, "output")
    shown, out_red = (redact.redact(result.text) if policy.redact_output
                      else (result.text, []))
    blocked = "output" if (policy.firewall_output and out_v.verdict == "block") else None
    if blocked:
        shown = "[blocked: output violated policy]"

    return _finalize(
        prompt=sent, output=shown, provider=result.provider, model=result.model,
        latency_ms=result.latency_ms, in_v=in_v, out_v=out_v, in_red=in_red,
        out_red=out_red, blocked=blocked, policy=policy, fallbacks=result.fallbacks,
    )


def _finalize(prompt, output, provider, model, latency_ms, in_v, out_v,
              in_red, out_red, blocked, policy, fallbacks) -> GovernedResult:
    seq = None
    if policy.audit:
        entry = audit.log.append({
            "event": "complete", "provider": provider, "model": model,
            "latency_ms": latency_ms, "input_verdict": in_v.verdict,
            "output_verdict": out_v.verdict, "blocked": blocked,
            "redactions_in": in_red, "redactions_out": out_red,
            "request": prompt[:_AUDIT_TEXT_CAP], "response": output[:_AUDIT_TEXT_CAP],
        })
        seq = entry["seq"]
    return GovernedResult(
        output=output, provider=provider, model=model, latency_ms=latency_ms,
        input_scan=in_v.as_dict(), output_scan=out_v.as_dict(),
        redactions={"input": in_red, "output": out_red}, blocked=blocked,
        audit_seq=seq, routing_fallbacks=fallbacks,
    )
