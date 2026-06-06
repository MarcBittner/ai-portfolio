"""Ingestion: load → redact → chunk → embed → upsert.

PII redaction is a mandatory gate — text reaches the embedder and the
vector store only after redaction (spec FR-9.2). The report carries
redaction *counts* per type, never values.
"""

import time
from pathlib import Path

from pydantic import BaseModel

from persona_twin.chunking.base import Chunker
from persona_twin.corpus import PersonaRecord, load_personas
from persona_twin.embedding.base import Embedder
from persona_twin.governance import Redactor
from persona_twin.log import get_logger, kv
from persona_twin.vectorstore.base import VectorStore

logger = get_logger("pipeline.ingest")

EMBED_BATCH_SIZE = 64


class IngestReport(BaseModel):
    personas: int
    documents: int
    chunks: int
    redactions: dict[str, int]
    strategy: str
    elapsed_ms: float


async def ingest_corpus(
    chunker: Chunker,
    embedder: Embedder,
    store: VectorStore,
    corpus_root: Path | None = None,
    records: list[PersonaRecord] | None = None,
) -> IngestReport:
    started = time.perf_counter()
    records = records if records is not None else load_personas(corpus_root)
    redactor = Redactor()

    all_chunks = []
    redaction_totals: dict[str, int] = {}
    doc_count = 0
    for record in records:
        for doc in record.documents:
            doc_count += 1
            result = redactor.redact(doc.text)
            for pii_type, n in result.counts.items():
                redaction_totals[pii_type] = redaction_totals.get(pii_type, 0) + n
            all_chunks.extend(
                chunker.chunk(result.text, doc_id=doc.doc_id, persona_id=doc.persona_id)
            )

    for i in range(0, len(all_chunks), EMBED_BATCH_SIZE):
        batch = all_chunks[i : i + EMBED_BATCH_SIZE]
        vectors = await embedder.embed_documents([c.text for c in batch])
        await store.upsert(batch, vectors)

    elapsed_ms = (time.perf_counter() - started) * 1000
    report = IngestReport(
        personas=len(records),
        documents=doc_count,
        chunks=len(all_chunks),
        redactions=redaction_totals,
        strategy=chunker.strategy,
        elapsed_ms=round(elapsed_ms, 1),
    )
    logger.info(
        "ingest complete %s",
        kv(
            personas=report.personas,
            documents=report.documents,
            chunks=report.chunks,
            redacted=sum(redaction_totals.values()),
            strategy=report.strategy,
        ),
    )
    return report
