"""Scanner registry — the pluggable seam that makes postureline two demos in one.

Both scanners reduce a different raw surface to the SAME canonical ``Finding`` (see
``findings.py``), which the shared core then runs through the identical pipeline
(controls crosswalk → severity posture → narrative → remediation diff). Adding a
third surface is one entry here plus a module that emits ``Finding`` objects.

    register["warehouse"] → warehouse_scan   (DuckDB/Snowflake column governance)
    register["exposure"]  → exposure_scan    (internet-intelligence inventory)
"""

from __future__ import annotations

from collections.abc import Callable

from postureline.findings import ScanResult
from postureline.scanners.exposure import scan as exposure_scan
from postureline.scanners.warehouse import scan as warehouse_scan

# surface name → scanner callable (remediated: bool, mode: str|None) -> ScanResult
REGISTRY: dict[str, Callable[..., ScanResult]] = {
    "warehouse": warehouse_scan,
    "exposure": exposure_scan,
}

SURFACES = tuple(REGISTRY)


def get(surface: str) -> Callable[..., ScanResult]:
    """Resolve a scanner by surface name, or raise with the known surfaces."""
    try:
        return REGISTRY[surface]
    except KeyError:
        raise ValueError(
            f"unknown surface {surface!r}; known: {', '.join(SURFACES)}") from None
