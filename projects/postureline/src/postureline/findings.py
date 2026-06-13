"""The canonical ``Finding`` — the one currency both scanners emit.

The whole point of postureline is that two very different scanners (a data
warehouse and an internet-exposure estate) share a single posture/compliance
engine. That only works if they speak a common language: a *finding*. Both the
warehouse scanner and the exposure scanner reduce their native artifacts (an
unmasked PHI column; a MongoDB open to ``0.0.0.0/0``) to the same shape:

    {id, surface, severity, resource, evidence, control_ids, remediation, title}

- ``surface`` ∈ {``warehouse``, ``exposure``} — which scanner emitted it.
- ``severity`` ∈ {``critical``, ``high``, ``medium``, ``low``} — drives the
  severity-weighted posture (``posture.py``).
- ``resource`` — the affected thing (``ANALYTICS.CLAIMS.MEMBERS.SSN`` or
  ``data-01.example-estate.test:27017``).
- ``evidence`` — machine-readable proof the detector saw (parsed cert fields, the
  open port, the discovered PHI types).
- ``control_ids`` — the controls this finding breaks, attached at the moment of
  detection so the compliance crosswalk is never an afterthought. Every finding
  maps to ≥ 1 control (an invariant the eval asserts).
- ``remediation`` — the fix.

Findings carry their control ids as bare SOC 2 anchor ids (e.g. ``CC6.6``);
``controls.py`` expands each anchor across all six frameworks.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

SURFACES = ("warehouse", "exposure")
SEVERITIES = ("critical", "high", "medium", "low")


@dataclass
class Finding:
    """One governed finding, emitted by either scanner in an identical shape."""

    id: str                       # stable rule id (e.g. UNMASKED_PHI, DB_EXPOSED)
    surface: str                  # warehouse | exposure
    severity: str                 # critical | high | medium | low
    resource: str                 # the affected resource (col fqn / host:port)
    title: str                    # human-readable finding title
    evidence: dict                # machine-readable proof
    control_ids: list[str]        # SOC 2 anchor control ids this finding breaks
    remediation: str              # the fix

    def __post_init__(self) -> None:
        if self.surface not in SURFACES:
            raise ValueError(f"unknown surface {self.surface!r}")
        if self.severity not in SEVERITIES:
            raise ValueError(f"unknown severity {self.severity!r}")
        if not self.control_ids:
            raise ValueError(f"finding {self.id} maps to no control")

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ScanResult:
    """A scanner's raw output: the findings plus any surface-specific extras.

    ``extras`` carries the distinctive per-surface artifacts the shared core does
    not model (the warehouse's policy-as-code + k-anonymity; the exposure estate's
    inventory summary), so nothing either origin demo did is lost in the merge.
    """

    surface: str
    findings: list[Finding] = field(default_factory=list)
    extras: dict = field(default_factory=dict)

    def dicts(self) -> list[dict]:
        return [f.to_dict() for f in self.findings]
