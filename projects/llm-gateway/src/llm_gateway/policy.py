"""Governance policy — which guardrails are enforced on the request path.

The whole point of the gateway is that these default to ON: firewall the input
and output, redact PII/secrets in both directions, and audit everything. A
deployment overrides via env (``GATEWAY_*``); the default is governance-by-default.
"""

import os
from dataclasses import asdict, dataclass


def _flag(name: str, default: bool = True) -> bool:
    v = os.environ.get(name)
    return default if v is None else v.lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Policy:
    firewall_input: bool = True       # scan + block malicious inputs
    firewall_output: bool = True      # scan + block leaking outputs
    redact_input: bool = True         # strip PII/secrets before the provider sees them
    redact_output: bool = True        # strip PII/secrets before returning + logging
    audit: bool = True                # append every request to the hash-chained log

    def as_dict(self) -> dict:
        return asdict(self)


DEFAULT = Policy(
    firewall_input=_flag("GATEWAY_FIREWALL_INPUT"),
    firewall_output=_flag("GATEWAY_FIREWALL_OUTPUT"),
    redact_input=_flag("GATEWAY_REDACT_INPUT"),
    redact_output=_flag("GATEWAY_REDACT_OUTPUT"),
    audit=_flag("GATEWAY_AUDIT"),
)
