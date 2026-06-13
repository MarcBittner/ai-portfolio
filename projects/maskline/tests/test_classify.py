"""Classification: name/type heuristics for structured columns; LLM (offline
regex fallback) for free-text PHI. Same output shape on both paths."""

from maskline import classify, warehouse


def setup_function():
    warehouse.reset()


def _by_col(rows):
    return {(r["table"], r["column"]): r for r in rows}


def test_structured_classes():
    rows = _by_col(classify.classify_all())
    assert rows[("MEMBERS", "MEMBER_NAME")]["class"] == "direct"
    assert rows[("MEMBERS", "SSN")]["class"] == "direct"
    assert rows[("MEMBERS", "DOB")]["class"] == "quasi"
    assert rows[("MEMBERS", "ZIP")]["class"] == "quasi"
    assert rows[("CLAIMS", "DX_CODE")]["class"] == "clinical"
    assert rows[("CLAIMS", "ALLOWED_AMOUNT")]["class"] == "financial"
    assert rows[("CLAIMS", "CLAIM_ID")]["class"] == "non_sensitive"


def test_free_text_phi_detected_offline():
    rows = _by_col(classify.classify_all(mode="offline"))
    note = rows[("CLAIMS", "CLAIM_NOTE")]
    assert note["method"] == "llm"          # routed through the LLM surface
    assert note["provider"] == "offline"    # but fell back to the regex detector
    assert note["sensitive"] is True
    # regex offline detector finds embedded email/phone/name/ssn
    assert {"EMAIL", "PHONE"} <= set(note["phi_types"])


def test_output_shape_uniform():
    for r in classify.classify_all():
        assert set(r) >= {"table", "column", "type", "class", "sensitive",
                          "method", "provider", "phi_types"}
        assert r["class"] in classify.CLASSES


def test_sensitive_columns_subset():
    allc = classify.classify_all()
    sens = classify.sensitive_columns(allc)
    assert all(c["sensitive"] for c in sens)
    assert len(sens) < len(allc)
