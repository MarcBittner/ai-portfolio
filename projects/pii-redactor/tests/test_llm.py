"""Vendored router + LLM NER — mock provider keeps these offline/hermetic."""

from pii_redactor import llm
from pii_redactor.detect import Span, detect
from pii_redactor.llm_ner import llm_entities, merge


def test_complete_mock_never_raises():
    r = llm.complete("hello", provider="mock")
    assert r.provider == "mock" and r.text


def test_complete_json_mock_returns_none():
    parsed, result = llm.complete_json("x", "sys", provider="mock")
    assert parsed is None and result.provider == "mock"


def test_llm_entities_empty_on_mock():
    spans, result = llm_entities("Jane from Acme", provider="mock")
    assert spans == [] and result.provider == "mock"


def test_merge_prefers_regex_on_overlap():
    text = "email a@b.com"
    regex = detect(text)  # the email span
    # an overlapping LLM "PERSON" claim should be dropped in favor of regex
    overlap = [Span("PERSON", regex[0].start, regex[0].end, "a@b.com")]
    assert merge(regex, overlap) == regex
    # a non-overlapping LLM span is kept
    person = [Span("PERSON", 0, 5, "email")]
    merged = merge(regex, person)
    assert len(merged) == 2 and merged[0].type == "PERSON"


def test_providers_status_shape():
    s = llm.providers_status()
    assert s["available"]["mock"] is True
    assert set(s["models"]) >= {"ollama", "mock"}
