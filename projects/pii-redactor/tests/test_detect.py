"""Detection: each type, checksum validation, non-overlap, filtering."""

from pii_redactor.detect import TYPE_NAMES, counts, detect


def _types(text):
    return {s.type for s in detect(text)}


def test_detects_each_type():
    assert "EMAIL" in _types("ping me at a.b-c@sub.example.co")
    assert "PHONE" in _types("call (415) 555-0132 today")
    assert "SSN" in _types("ssn 123-45-6789 on file")
    assert "CREDIT_CARD" in _types("card 4111 1111 1111 1111 ok")  # valid Luhn
    assert "IP_ADDRESS" in _types("host 192.168.1.42 up")
    assert "IBAN" in _types("iban GB82WEST12345698765432 sent")
    assert "STREET_ADDRESS" in _types("at 1600 Pennsylvania Ave now")


def test_luhn_rejects_invalid_card():
    assert "CREDIT_CARD" not in _types("number 4111 1111 1111 1112")  # bad checksum


def test_iban_rejects_invalid_checksum():
    assert "IBAN" not in _types("iban GB00WEST12345698765432 nope")


def test_ipv4_rejects_out_of_range_octet():
    assert "IP_ADDRESS" not in _types("not an ip 999.1.1.1 here")


def test_spans_do_not_overlap_and_are_sorted():
    text = "mail x@y.com then call 415-555-0132"
    spans = detect(text)
    assert [s.type for s in spans] == ["EMAIL", "PHONE"]
    for a, b in zip(spans, spans[1:], strict=False):
        assert a.end <= b.start


def test_clean_text_has_no_pii():
    assert detect("The quick brown fox jumps over the lazy dog.") == []


def test_type_filter_limits_detection():
    text = "x@y.com and 123-45-6789"
    only_ssn = detect(text, types={"SSN"})
    assert {s.type for s in only_ssn} == {"SSN"}


def test_counts_helper():
    spans = detect("a@b.com, c@d.com, 123-45-6789")
    assert counts(spans) == {"EMAIL": 2, "SSN": 1}


def test_all_types_have_names():
    assert set(TYPE_NAMES) >= {"EMAIL", "PHONE", "SSN", "CREDIT_CARD"}
