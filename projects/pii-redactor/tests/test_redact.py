"""Redaction styles, per-value consistency, and counts."""

import pytest

from pii_redactor.redact import redact


def test_token_style_and_consistency():
    text = "from a@x.com to a@x.com and b@y.com"
    out, counts = redact(text, "token")
    assert "[EMAIL_1]" in out and "[EMAIL_2]" in out
    assert out.count("[EMAIL_1]") == 2  # same value → same token
    assert counts == {"EMAIL": 2}  # two distinct values


def test_label_style():
    out, _ = redact("ssn 123-45-6789", "label")
    assert out == "ssn <SSN>"


def test_mask_keeps_separators():
    out, _ = redact("mail a@b.com", "mask")
    assert "@" in out and "•" in out and "a@b.com" not in out


def test_partial_keeps_last_four_of_card():
    out, _ = redact("card 4111 1111 1111 1111", "partial")
    assert out.endswith("1111") and "4111 1111 1111 1111" not in out


def test_hash_is_deterministic_and_consistent():
    a, _ = redact("x@y.com", "hash")
    b, _ = redact("x@y.com", "hash")
    assert a == b and a.startswith("EMAIL_") and "x@y.com" not in a


def test_unknown_style_raises():
    with pytest.raises(ValueError):
        redact("a@b.com", "bogus")


def test_no_pii_returns_text_unchanged():
    out, counts = redact("nothing to see here")
    assert out == "nothing to see here" and counts == {}
