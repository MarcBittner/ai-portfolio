from field_vault import audit, store


def test_records_are_deidentified():
    store.reset()
    for r in store.records():
        assert r["member_id"].startswith("tok_")
        assert r["member_name"].startswith("tok_")
        assert len(r["dob"]) == 4            # generalized to birth year
        assert r["zip"].endswith("**")


def test_analyst_reads_clinical_value():
    store.reset()
    r = store.access_field("analyst", "rec-0001", "dx_code")
    assert r["allowed"] is True and r["value"] == "E11.9"


def test_analyst_cannot_reidentify():
    store.reset()
    r = store.access_field("analyst", "rec-0001", "member_name", reidentify=True)
    assert r["allowed"] is False and "value" not in r


def test_care_coordinator_reidentifies_with_purpose():
    store.reset()
    r = store.access_field("care_coordinator", "rec-0001", "member_name",
                           purpose="treatment", reidentify=True)
    assert r["allowed"] is True
    assert r["value"] == "Ada Quill" and not r["value"].startswith("tok_")


def test_unknown_record_404():
    store.reset()
    assert store.access_field("analyst", "rec-9999", "dx_code")["status"] == 404


def test_every_access_is_audited():
    store.reset()
    before = len(audit.log)
    store.access_field("analyst", "rec-0001", "dx_code")
    store.access_field("auditor", "rec-0001", "dx_code")   # denied, still logged
    assert len(audit.log) == before + 2
