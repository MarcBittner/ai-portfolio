from field_vault.deid import Vault, generalize


def test_direct_identifiers_tokenized_and_reversible():
    v = Vault()
    out = v.deidentify({"member_id": "M-0001", "member_name": "Ada Quill"})
    assert out["member_id"].startswith("tok_")
    assert out["member_name"].startswith("tok_")
    assert "Ada Quill" not in (out["member_id"] + out["member_name"])
    assert v.detokenize(out["member_name"]) == "Ada Quill"


def test_tokenization_is_deterministic():
    v1, v2 = Vault(), Vault()
    a = v1.deidentify({"member_name": "Ada Quill"})["member_name"]
    b = v2.deidentify({"member_name": "Ada Quill"})["member_name"]
    assert a == b   # same value → same token (joinable), across vaults


def test_quasi_identifiers_generalized_one_way():
    assert generalize("dob", "1972-03-14") == "1972"
    assert generalize("zip", "94110") == "941**"
    assert generalize("service_date", "2026-01-08") == "2026-01"


def test_clinical_and_financial_kept():
    v = Vault()
    out = v.deidentify({"dx_code": "E11.9", "allowed_amount": 142.0, "outcome": 1})
    assert out["dx_code"] == "E11.9"
    assert out["allowed_amount"] == 142.0 and out["outcome"] == 1


def test_unknown_token_detokenizes_to_none():
    assert Vault().detokenize("tok_deadbeef") is None
