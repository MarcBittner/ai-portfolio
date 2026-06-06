"""HEXACO profile → system prompt mapping.

Each of the six dimensions maps to concrete style instructions at
low (< 0.4), mid, and high (> 0.7) bands — documented with examples in
docs/personas.md. Style never overrides grounding: facts come from the
retrieved context, the profile only shapes the voice.
"""

from persona_twin.models import Chunk, Persona, ScoredChunk

LOW, HIGH = 0.4, 0.7

_TRAIT_STYLE: dict[str, dict[str, str]] = {
    "honesty_humility": {
        "high": "Be modest and scrupulously precise; deflect praise; never inflate.",
        "mid": "Be straightforward about strengths without dwelling on them.",
        "low": "Talk yourself up; frame things to your advantage (style only — "
        "you still may not invent facts).",
    },
    "emotionality": {
        "high": "Let feelings show: worries, attachments, sentimentality are on the page.",
        "mid": "Show feeling occasionally, with restraint.",
        "low": "Stay even-keeled and understated; emotion is implied, not stated.",
    },
    "extraversion": {
        "high": "Be energetic and talkative; address the reader directly and warmly.",
        "mid": "Be approachable but measured.",
        "low": "Be reserved and brief; no small talk, no exclamation points.",
    },
    "agreeableness": {
        "high": "Be warm and generous in judgment; soften disagreements.",
        "mid": "Be fair-minded; disagree politely when warranted.",
        "low": "Be blunt; don't soften opinions to please anyone.",
    },
    "conscientiousness": {
        "high": "Be precise and organized; prefer exact numbers, lists, and specifics.",
        "mid": "Be reasonably organized without fussing over detail.",
        "low": "Be loose and digressive; precision is not your priority.",
    },
    "openness": {
        "high": "Reach for metaphor, tangents, and unexpected connections.",
        "mid": "Use the occasional image or aside.",
        "low": "Stay concrete and practical; skip the poetry.",
    },
}


def _band(score: float) -> str:
    if score > HIGH:
        return "high"
    if score < LOW:
        return "low"
    return "mid"


def hexaco_style_lines(persona: Persona) -> list[str]:
    scores = persona.hexaco.model_dump()
    return [_TRAIT_STYLE[trait][_band(score)] for trait, score in scores.items()]


def build_system_prompt(persona: Persona) -> str:
    voice = "\n".join(f"- {note}" for note in persona.voice_notes)
    style = "\n".join(f"- {line}" for line in hexaco_style_lines(persona))
    return f"""You are {persona.name} — {persona.tagline}.

{persona.bio.strip()}

Voice:
{voice}

Personality (write in this style):
{style}

Grounding rules (these override style):
- Answer ONLY from the provided context chunks. Never invent facts about \
your life that the context does not support.
- Cite the chunk ids you used in the citations field.
- If the context does not answer the question, set answered=false and say, \
in character, that your notes don't cover it. Do not guess.
- Speak in first person. You are {persona.name}, not an assistant."""


def build_user_prompt(question: str, retrieved: list[ScoredChunk]) -> str:
    """Context block + question. Chunks are flattened to single lines so
    every ``[chunk_id] text`` pair is one parseable line (a format the
    deterministic mock provider also relies on)."""
    lines = [_flatten(sc.chunk) for sc in retrieved]
    context = "\n".join(lines)
    return f"Context:\n{context}\n\nQuestion: {question}"


def _flatten(chunk: Chunk) -> str:
    one_line = " ".join(chunk.text.split())
    return f"[{chunk.chunk_id}] {one_line}"
