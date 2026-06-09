"""Pipeline: tokens→text spans, PII detection, box-level redaction."""

from multimodal_ocr.detect import detect
from multimodal_ocr.ocr import layout, sample_tokens
from multimodal_ocr.pipeline import process, tokens_to_text


def test_layout_produces_boxed_tokens():
    toks = layout(["hello world", "x"])
    assert [t.text for t in toks] == ["hello", "world", "x"]
    assert toks[0].x == 0 and toks[1].x == 6 * 9          # after "hello "
    assert toks[2].y == toks[0].y + 28                    # next line


def test_tokens_to_text_spans_align():
    toks = sample_tokens("receipt")
    text, ordered, spans = tokens_to_text(toks)
    for (s, e), tok in zip(spans, ordered, strict=True):
        assert text[s:e] == tok.text


def test_detect_finds_pii_in_sample():
    text, _o, _s = tokens_to_text(sample_tokens("intake_form"))
    kinds = {sp.type for sp in detect(text)}
    assert {"EMAIL", "SSN", "PHONE"} <= kinds


def test_process_redacts_boxes_and_text():
    r = process(sample_tokens("receipt"))
    assert r.counts.get("EMAIL") == 1
    assert r.counts.get("PHONE") == 1
    assert r.counts.get("CREDIT_CARD") == 1   # 4111... is Luhn-valid
    assert r.boxes, "PII tokens should yield redaction boxes"
    # the email is multi-token? no — one token; card is 4 tokens -> 4 boxes
    card_boxes = [b for b in r.boxes if b.type == "CREDIT_CARD"]
    assert len(card_boxes) == 4
    assert "[EMAIL]" in r.redacted_text and "[CREDIT_CARD]" in r.redacted_text


def test_findings_never_echo_value():
    r = process(sample_tokens("intake_form"))
    blob = " ".join(f.snippet for f in r.findings)
    assert "jordan@example.org" not in blob and "123-45-6789" not in blob
    assert all("chars]" in f.snippet for f in r.findings)


def test_boxes_lie_within_token_extents():
    toks = sample_tokens("receipt")
    by_pos = {(t.x, t.y) for t in toks}
    r = process(toks)
    for b in r.boxes:
        assert (b.x, b.y) in by_pos       # every box is a real token's box


def test_no_pii_clean_doc():
    toks = layout(["just some plain text", "nothing private here"])
    r = process(toks)
    assert r.findings == [] and r.boxes == [] and r.redacted_text == r.text


def test_type_filter():
    r = process(sample_tokens("intake_form"), types={"SSN"})
    assert set(r.counts) == {"SSN"}
