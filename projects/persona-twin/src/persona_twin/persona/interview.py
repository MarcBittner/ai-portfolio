"""Twin-vs-twin: one twin interviews another.

The interviewer poses questions; the subject answers grounded in *its own*
corpus with validated citations (the answer side is just ``ask_twin``, so
grounding and citation-validation are identical to ``/ask``).

Questions are seeded deterministically from the subject's corpus so the
interview is always about real, answerable material — then the interviewer
rephrases each seed in its own voice via an LLM (``task=twin_interview``).
Offline (the deterministic mock) the phrasing step is a no-op and the seed
question is used directly, so the whole flow runs without any provider.
"""

import re

from pydantic import BaseModel

from persona_twin.embedding.base import Embedder
from persona_twin.llm.base import LLMRequest
from persona_twin.llm.router import AllProvidersFailedError, LLMRouter
from persona_twin.models import Chunk, Citation, Persona
from persona_twin.persona.prompting import hexaco_style_lines
from persona_twin.persona.twin import ask_twin
from persona_twin.reranking.lexical import LexicalReranker
from persona_twin.retrieval.bm25 import BM25Index
from persona_twin.vectorstore.base import VectorStore

MAX_ROUNDS = 6
SEED_WORDS = 12


class InterviewRound(BaseModel):
    question: str
    answer: str
    answered: bool
    citations: list[Citation] = []


class InterviewTranscript(BaseModel):
    interviewer_id: str
    subject_id: str
    rounds: list[InterviewRound]


class _Phrased(BaseModel):
    question: str = ""


def _seed_questions(chunks: list[Chunk], rounds: int) -> list[str]:
    """Deterministic, answerable seed questions spread across the subject's
    corpus — the first clause of evenly-spaced chunks turned into a prompt."""
    ranked = sorted(chunks, key=lambda c: c.chunk_id)
    if not ranked:
        return []
    step = max(1, len(ranked) // rounds)
    picked = ranked[::step][:rounds]
    questions: list[str] = []
    for chunk in picked:
        text = re.sub(r"[#*`>_]+", "", " ".join(chunk.text.split()))  # drop markdown
        first = re.split(r"(?<=[.!?])\s", text.strip())[0]
        seed = " ".join(first.split()[:SEED_WORDS]).rstrip(".,;:!?")
        questions.append(f"Tell me about {seed}.")
    return questions


def _interviewer_system(interviewer: Persona, subject: Persona) -> str:
    voice = "\n".join(f"- {n}" for n in interviewer.voice_notes)
    style = "\n".join(f"- {s}" for s in hexaco_style_lines(interviewer))
    return f"""You are {interviewer.name} — {interviewer.tagline}. You are
interviewing {subject.name}. Rephrase the PROMPT as a single natural,
conversational interview question in your own voice. Ask only one question;
output just the question text.

Voice:
{voice}

Personality:
{style}"""


async def _phrase(
    interviewer: Persona, subject: Persona, seed: str, router: LLMRouter
) -> str:
    """The interviewer's in-voice rephrasing of a seed question; falls back to
    the seed offline or on failure."""
    try:
        request = LLMRequest(
            system=_interviewer_system(interviewer, subject),
            user=f"PROMPT: {seed}",
            max_tokens=120,
        )
        parsed, _, _ = await router.complete_structured(
            request, _Phrased, task="twin_interview"
        )
    except AllProvidersFailedError:
        return seed
    return parsed.question.strip() or seed


async def interview(
    interviewer: Persona,
    subject: Persona,
    *,
    embedder: Embedder,
    store: VectorStore,
    router: LLMRouter,
    bm25: BM25Index | None = None,
    rounds: int = 3,
) -> InterviewTranscript:
    """Run a grounded interview: seed questions from the subject's corpus,
    phrase them in the interviewer's voice, answer each via ``ask_twin``."""
    rounds = max(1, min(rounds, MAX_ROUNDS))
    subject_chunks = [
        c for c in await store.all_chunks() if c.persona_id == subject.persona_id
    ]
    reranker = LexicalReranker()
    transcript: list[InterviewRound] = []
    for seed in _seed_questions(subject_chunks, rounds):
        question = await _phrase(interviewer, subject, seed, router)
        answer = await ask_twin(
            subject, question, embedder=embedder, store=store, router=router,
            reranker=reranker, bm25=bm25,
        )
        transcript.append(
            InterviewRound(
                question=question,
                answer=answer.answer,
                answered=answer.answered,
                citations=answer.citations,
            )
        )
    return InterviewTranscript(
        interviewer_id=interviewer.persona_id,
        subject_id=subject.persona_id,
        rounds=transcript,
    )
