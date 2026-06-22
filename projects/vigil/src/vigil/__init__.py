"""vigil — public observability + SOC monitoring for the ai-portfolio fleet.

A single self-contained FastAPI service that probes every portfolio demo (and
itself), records a time series in SQLite, scores security/compliance posture
against six control frameworks, dispatches alerts, and compresses the live fleet
state into an LLM-written incident narrative (deterministic offline fallback).
"""

__version__ = "0.1.0"
