"""Offline demo: ingest the synthetic corpus and query the twins.

Run with ``make demo`` — works on a fresh clone with no .env.
"""

import asyncio

from persona_twin.api.app import build_state
from persona_twin.chunking import get_chunker
from persona_twin.config import Settings
from persona_twin.log import configure
from persona_twin.persona.twin import ask_twin
from persona_twin.pipeline import ingest_corpus

QUESTIONS = [
    ("ada-quill", "What tomato variety are you growing this year?"),
    ("ada-quill", "What's your most-used kitchen gadget?"),
    ("buck-ramirez", "What's your current deadlift number?"),
    ("gus-okafor", "What did you do during the storm of '09?"),
    ("mei-tanaka", "How many copies did Attic Light sell?"),
    # deliberately unanswerable — the twin must refuse, not guess
    ("gus-okafor", "What's your favorite cryptocurrency exchange?"),
]

RULE = "─" * 72


async def main() -> None:
    configure()
    settings = Settings()
    state = build_state(settings)

    print(RULE)
    print("persona-twin demo")
    print(
        f"backends: vector={settings.vector_backend} "
        f"embeddings={settings.embedding_backend} llm={settings.llm_backends}"
    )
    print(RULE)

    report = await ingest_corpus(
        get_chunker("content_aware"), state.embedder, state.store, records=state.records
    )
    print(
        f"ingested {report.chunks} chunks from {report.documents} documents "
        f"({report.personas} personas); PII redactions: {report.redactions}"
    )

    for persona_id, question in QUESTIONS:
        persona = state.personas[persona_id]
        response = await ask_twin(
            persona,
            question,
            embedder=state.embedder,
            store=state.store,
            router=state.router,
            debug=True,
        )
        print(RULE)
        print(f"Q → {persona.name}: {question}")
        print(f"A: {response.answer}")
        if response.answered:
            for c in response.citations:
                print(f"   ↳ [{c.chunk_id}] {c.excerpt[:80]}…")
        else:
            print("   (refused — context does not support an answer)")
        if response.debug and response.debug.routing:
            r = response.debug.routing
            print(
                f"   routing: {r.provider}/{r.model} objective={r.objective} "
                f"cost=${r.estimated_cost_usd:.6f}"
            )
    print(RULE)
    print("demo complete — try `make serve` and POST /ask yourself")


if __name__ == "__main__":
    asyncio.run(main())
