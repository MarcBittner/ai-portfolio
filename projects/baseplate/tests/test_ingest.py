"""The example workload: data-quality scoring on the synthetic rate file."""

from baseplate import ingest


def test_clean_row_passes():
    assert ingest.validate_row(
        {"code": "99213", "code_type": "CPT", "payer": "X", "rate": 10.0,
         "hospital": "H"}) == []


def test_missing_field_flagged():
    issues = ingest.validate_row(
        {"code": "99213", "code_type": "CPT", "payer": "", "rate": 10.0,
         "hospital": "H"})
    assert "missing:payer" in issues


def test_bad_code_type_and_non_positive_rate():
    issues = ingest.validate_row(
        {"code": "1", "code_type": "XYZ", "payer": "X", "rate": -5,
         "hospital": "H"})
    assert "bad_code_type:XYZ" in issues
    assert "non_positive_rate" in issues


def test_non_numeric_rate():
    issues = ingest.validate_row(
        {"code": "1", "code_type": "CPT", "payer": "X", "rate": "n/a",
         "hospital": "H"})
    assert "non_numeric_rate" in issues


def test_score_on_sample_has_known_shape():
    r = ingest.score()
    assert r["rows"] == len(ingest.SAMPLE_ROWS)
    assert r["valid"] + r["invalid"] == r["rows"]
    assert 0.0 <= r["data_quality_pass_rate"] <= 1.0
    # the sample is seeded with 3 defective rows out of 8
    assert r["valid"] == 5
    assert r["invalid"] == 3
    assert r["data_quality_pass_rate"] == round(5 / 8, 4)


def test_score_is_deterministic():
    assert ingest.score() == ingest.score()


def test_score_on_all_clean_rows_is_one():
    rows = [{"code": "1", "code_type": "CPT", "payer": "P", "rate": 1.0,
             "hospital": "H"}]
    assert ingest.score(rows)["data_quality_pass_rate"] == 1.0


def test_defects_histogram_counts():
    r = ingest.score()
    assert sum(r["defects"].values()) >= r["invalid"]
    assert "missing" in r["defects"] or "non_numeric_rate" in r["defects"]
