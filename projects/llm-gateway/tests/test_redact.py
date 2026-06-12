from llm_gateway.redact import detect, redact


def test_detects_pii_and_secrets():
    text = ("email bob@example.com ssn 123-45-6789 card 4111 1111 1111 1111 "
            "key sk-ant-EXAMPLE000000000000000 ip 10.0.0.5")
    types = {f.type for f in detect(text)}
    assert {"EMAIL", "SSN", "CREDIT_CARD", "API_KEY", "IP_ADDRESS"} <= types


def test_credit_card_requires_luhn():
    assert any(f.type == "CREDIT_CARD" for f in detect("card 4111111111111111"))
    assert not any(f.type == "CREDIT_CARD" for f in detect("card 4111111111111112"))


def test_redact_replaces_with_labels_and_never_echoes_value():
    secret = "sk-ant-EXAMPLE000000000000000"
    red, findings = redact(f"the key is {secret} ok")
    assert secret not in red
    assert "[API_KEY]" in red
    # findings expose type + count only — never the value
    blob = str(findings)
    assert secret not in blob
    assert {"type": "API_KEY", "category": "secret", "count": 1} in findings


def test_clean_text_unchanged():
    red, findings = redact("the capital of France is Paris")
    assert findings == [] and red == "the capital of France is Paris"
