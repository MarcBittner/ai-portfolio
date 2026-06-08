"""Deterministic mock provider — the offline default, not a test stub.

Produces grounded, *extractive* answers from the context embedded in
the prompt. The persona layer formats retrieved chunks as lines
beginning with ``[chunk_id]``; the mock parses those, scores them
against the question by content-word overlap, and answers with
sentences from the best chunk — citing real chunk ids. Unanswerable
questions (no lexical support) are refused, exactly like the live
path.

Deterministic by construction, so integration tests and the offline
demo assert exact behavior.
"""

import asyncio
import json
import re
import time
from collections.abc import AsyncIterator

from persona_twin.llm.base import LLMRequest, LLMResponse, LLMUsage, ModelSpec

_CHUNK_LINE = re.compile(r"^\[([^\]]+)\]\s+(.*)$", re.MULTILINE)
_QUESTION = re.compile(r"Question:\s*(.+?)\s*$", re.MULTILINE)
_WORD = re.compile(r"[a-z]{3,}")
_STOPWORDS = frozenset({
    "the", "and", "for", "with", "that", "this", "you", "your", "what", "when",
    "where", "which", "how", "why", "does", "did", "are", "was", "were", "have",
    "has", "had", "about", "from", "into", "out", "not", "all", "any", "can",
    "will", "would", "should", "could", "their", "there", "they", "them", "his",
    "her", "she", "him", "who", "whom", "been", "being",
})


def _content_words(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if w not in _STOPWORDS}


class MockProvider:
    name = "mock"

    def _answer(self, request: LLMRequest) -> tuple[str, bool, list[str]]:
        """Extractive answer, answered flag, and cited ids for a request —
        shared by ``complete`` (structured or plain) and ``stream``."""
        chunks = _CHUNK_LINE.findall(request.user)
        q_match = _QUESTION.search(request.user)
        question = q_match.group(1) if q_match else request.user
        q_words = _content_words(question)

        scored = sorted(
            ((len(q_words & _content_words(text)), cid, text) for cid, text in chunks),
            key=lambda t: -t[0],
        )
        best = scored[0][0] if scored else 0
        threshold = 2 if len(q_words) >= 3 else 1
        answered = best >= threshold

        if answered:
            answer = self._extract_answer(scored[0][2], q_words)
            citations = [cid for score, cid, _ in scored if score >= max(1, best - 1)][:3]
        else:
            answer = "My notes don't cover that, so I won't guess."
            citations = []
        return answer, answered, citations

    async def complete(self, request: LLMRequest, spec: ModelSpec) -> LLMResponse:
        started = time.perf_counter()
        answer, answered, citations = self._answer(request)

        if request.json_schema is not None:
            text = json.dumps(
                self._fill_schema(request.json_schema, answer, answered, citations)
            )
        else:
            text = answer

        return LLMResponse(
            text=text,
            provider=self.name,
            model=spec.id,
            usage=LLMUsage(
                input_tokens=len(request.user) // 4, output_tokens=len(text) // 4
            ),
            latency_ms=round((time.perf_counter() - started) * 1000, 3),
            cost_usd=0.0,
        )

    async def stream(
        self, request: LLMRequest, spec: ModelSpec
    ) -> AsyncIterator[str]:
        """Yield the extractive prose answer word-by-word — the deterministic
        offline streaming path. Structured citations are produced separately
        via ``complete`` (json_schema set), so this ignores any schema."""
        answer, _answered, _citations = self._answer(request)
        words = answer.split(" ")
        for i, word in enumerate(words):
            await asyncio.sleep(0)  # yield control so the stream is cooperative
            yield word if i == 0 else f" {word}"

    def _extract_answer(self, chunk_text: str, q_words: set[str]) -> str:
        cleaned = re.sub(r"#+\s*", "", chunk_text)  # drop markdown heading marks
        sentences = re.split(r"(?<=[.!?])\s+", cleaned)
        relevant = [s for s in sentences if q_words & _content_words(s)]
        return " ".join(relevant[:2]) if relevant else sentences[0]

    def _fill_schema(
        self, schema: dict, answer: str, answered: bool, citations: list[str]
    ) -> dict:
        out: dict = {}
        for key, prop in schema.get("properties", {}).items():
            ptype = prop.get("type")
            lowered = key.lower()
            if ptype == "boolean":
                out[key] = answered
            elif ptype == "string":
                out[key] = answer if lowered in {"answer", "text", "response"} else ""
            elif ptype == "array":
                citing = any(w in lowered for w in ("citation", "source", "chunk"))
                out[key] = citations if citing else []
            elif ptype in {"integer", "number"}:
                out[key] = 0
            elif ptype == "object":
                out[key] = self._fill_schema(prop, answer, answered, citations)
        return out
