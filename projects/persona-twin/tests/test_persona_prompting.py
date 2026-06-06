"""HEXACO → prompt mapping and context formatting."""

from persona_twin.models import Chunk, HexacoProfile, Persona, ScoredChunk
from persona_twin.persona.prompting import (
    build_system_prompt,
    build_user_prompt,
    hexaco_style_lines,
)


def make_persona(**hexaco) -> Persona:
    base = dict.fromkeys(
        (
            "honesty_humility",
            "emotionality",
            "extraversion",
            "agreeableness",
            "conscientiousness",
            "openness",
        ),
        0.5,
    )
    base.update(hexaco)
    return Persona(
        persona_id="test-p",
        name="Test Persona",
        tagline="a tagline",
        bio="A bio.",
        hexaco=HexacoProfile(**base),
        voice_notes=["Likes parentheses"],
    )


def test_high_and_low_bands_map_to_distinct_styles():
    extravert = hexaco_style_lines(make_persona(extraversion=0.9))
    introvert = hexaco_style_lines(make_persona(extraversion=0.1))
    assert any("energetic" in line for line in extravert)
    assert any("reserved" in line for line in introvert)


def test_low_honesty_still_forbids_invention():
    lines = hexaco_style_lines(make_persona(honesty_humility=0.2))
    promo = next(line for line in lines if "advantage" in line)
    assert "may not invent" in promo


def test_system_prompt_contains_identity_voice_and_grounding():
    prompt = build_system_prompt(make_persona())
    assert "Test Persona" in prompt
    assert "Likes parentheses" in prompt
    assert "Answer ONLY from the provided context" in prompt
    assert "answered=false" in prompt


def test_user_prompt_flattens_chunks_to_single_lines():
    chunk = Chunk(
        chunk_id="d1:fixed:0000",
        doc_id="d1",
        persona_id="test-p",
        text="line one\nline two\n\nline three",
        strategy="fixed",
        char_span=(0, 30),
    )
    prompt = build_user_prompt("What?", [ScoredChunk(chunk=chunk, score=0.9)])
    assert "[d1:fixed:0000] line one line two line three" in prompt
    assert prompt.rstrip().endswith("Question: What?")
