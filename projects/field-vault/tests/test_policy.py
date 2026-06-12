from field_vault.policy import decide


def test_analyst_reads_clinical_but_cannot_reidentify():
    assert decide("analyst", "dx_code", "read_deid")[0] is True
    ok, reason = decide("analyst", "member_name", "reidentify")
    assert ok is False and "re-identify" in reason


def test_care_coordinator_reidentifies_only_with_purpose():
    assert decide("care_coordinator", "member_name", "reidentify", "treatment")[0] is True
    assert decide("care_coordinator", "member_name", "reidentify")[0] is False
    # analytics is not a care purpose → denied
    bad = decide("care_coordinator", "member_name", "reidentify", "analytics")
    assert bad[0] is False


def test_auditor_cannot_read_claim_fields():
    assert decide("auditor", "dx_code", "read_deid")[0] is False


def test_reidentify_only_applies_to_direct_identifiers():
    ok, reason = decide("care_coordinator", "dx_code", "reidentify", "treatment")
    assert ok is False and "direct" in reason


def test_unknown_role_and_field_denied():
    assert decide("nobody", "dx_code", "read_deid")[0] is False
    assert decide("analyst", "no_such_field", "read_deid")[0] is False
