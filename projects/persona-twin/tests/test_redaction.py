"""PII redactor: every type, checksum negatives, token stability."""

from persona_twin.governance import Redactor

R = Redactor()


def test_email():
    out = R.redact("Reach me at jo.bloggs@example.com for details.")
    assert out.text == "Reach me at [EMAIL_1] for details."
    assert out.counts == {"EMAIL": 1}
    assert out.mapping["[EMAIL_1]"] == "jo.bloggs@example.com"


def test_phone_formats():
    for raw in ["(555) 010-4422", "555-010-4422", "+1 555 010 4422", "555.010.4422"]:
        out = R.redact(f"call {raw} today")
        assert out.counts == {"PHONE": 1}, raw
        assert "[PHONE_1]" in out.text


def test_ssn():
    out = R.redact("SSN on file: 123-45-6789.")
    assert out.counts == {"SSN": 1}
    assert "[SSN_1]" in out.text


def test_credit_card_luhn_valid():
    out = R.redact("card 4111 1111 1111 1111 expires soon")
    assert out.counts == {"CREDIT_CARD": 1}


def test_credit_card_luhn_invalid_left_alone():
    out = R.redact("order number 4111 1111 1111 1112 shipped")
    assert "CREDIT_CARD" not in out.counts
    assert "4111 1111 1111 1112" in out.text


def test_ip_address():
    out = R.redact("server at 192.0.2.7 responded")
    assert out.counts == {"IP_ADDRESS": 1}


def test_ip_octet_range_validated():
    out = R.redact("version 999.999.999.999 is not an address")
    assert "IP_ADDRESS" not in out.counts


def test_street_address():
    out = R.redact("ship it to 742 Maplewood Lane before Friday")
    assert out.counts == {"STREET_ADDRESS": 1}


def test_same_value_same_token():
    out = R.redact("write a@example.com; again: a@example.com; also b@example.com")
    assert out.text.count("[EMAIL_1]") == 2
    assert out.text.count("[EMAIL_2]") == 1
    assert out.counts == {"EMAIL": 2}


def test_mixed_types_and_mapping_roundtrip():
    text = "Email a@example.com or call (555) 010-9999 re: card 4111 1111 1111 1111"
    out = R.redact(text)
    assert out.counts == {"EMAIL": 1, "PHONE": 1, "CREDIT_CARD": 1}
    restored = out.text
    for token, original in out.mapping.items():
        restored = restored.replace(token, original)
    assert restored == text


def test_clean_text_untouched():
    text = "The tide tables say low water at 14:30, fine weather for the crossing."
    out = R.redact(text)
    assert out.text == text
    assert out.total == 0
