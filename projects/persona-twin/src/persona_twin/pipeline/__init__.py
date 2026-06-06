"""Pipelines that assemble the ports: ingestion and (later) retrieval."""

from persona_twin.pipeline.ingest import IngestReport, ingest_corpus

__all__ = ["IngestReport", "ingest_corpus"]
