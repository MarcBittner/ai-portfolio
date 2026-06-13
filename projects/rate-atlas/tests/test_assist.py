"""LLM-assisted column → canonical mapping (deterministic offline matcher)."""

import json

from rate_atlas import assist, store
from rate_atlas.data import UNKNOWN_HOSPITAL, UNKNOWN_SAMPLE


def test_offline_matcher_maps_known_synonyms():
    # canonical synonyms map to the right field; an unrelated column stays None
    cols = ["billing_cpt", "insurer", "allowed_amt", "facility", "row_id"]
    out = json.loads(assist.offline_map("", f"Source columns: {', '.join(cols)}"))
    m = out["mapping"]
    assert m["billing_cpt"] == "code"
    assert m["insurer"] == "payer"
    assert m["allowed_amt"] == "rate"
    assert m["facility"] == "hospital"
    assert m["row_id"] is None


def test_match_one_specificity():
    # longer/more-specific synonym wins over a generic substring
    assert assist._match_one("billing_code") == "code"
    assert assist._match_one("negotiated_rate") == "rate"
    assert assist._match_one("payor") == "payer"
    assert assist._match_one("") is None


def test_unknown_format_normalizes_via_mapping():
    a = assist.assist(UNKNOWN_HOSPITAL, UNKNOWN_SAMPLE, mode="offline")
    assert a["provider"] == "offline"
    assert a["rows_mapped"] == a["rows_in"] > 0
    canon = ("hospital", "code", "code_type", "description", "payer", "plan", "rate")
    for r in a["records"]:
        assert tuple(r) == canon            # every record is the 7-field schema
        assert isinstance(r["rate"], float)
        assert r["hospital"] == UNKNOWN_HOSPITAL


def test_assisted_records_ingest_and_compare():
    store.ingest()
    before = len(store.compare("70450")["quotes"])
    a = assist.assist(UNKNOWN_HOSPITAL, UNKNOWN_SAMPLE, mode="offline")
    store.ingest_records("delta-regional-hospital", UNKNOWN_HOSPITAL, a["records"])
    after = store.compare("70450")["quotes"]
    assert len(after) == before + 1        # the unknown file joined the comparison
    assert UNKNOWN_HOSPITAL in {q["hospital"] for q in after}


def test_apply_mapping_skips_rows_missing_code_or_rate():
    mapping = {"cpt": "code", "amt": "rate", "payor": "payer"}
    rows = [{"cpt": "99213", "amt": "100", "payor": "X"},
            {"cpt": "", "amt": "100", "payor": "X"},        # no code → skip
            {"cpt": "70450", "amt": "", "payor": "X"}]      # no rate → skip
    recs = assist.apply_mapping("H", rows, mapping)
    assert len(recs) == 1
    assert recs[0]["code"] == "99213" and recs[0]["rate"] == 100.0


def test_eval_recall_is_sane_offline():
    ev = assist.evaluate(mode="offline")
    # the synonym table is exact on the labeled set; recall is the coverage bar
    assert ev["recall"] == 1.0
    assert ev["precision"] == 1.0
    assert ev["false_negatives"] == 0
    assert ev["providers_used"] == ["offline"]
