"""Shared arithmetic helpers for counsel internals."""


def _round2(x: float) -> float:
    return round(x + 1e-9, 2)
