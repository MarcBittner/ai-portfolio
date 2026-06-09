"""Generation: determinism, constraints, presets, and the PII-free guarantee."""

import re

import pytest

from synth_data.generate import PRESETS, generate, to_csv
from synth_data.generators import TYPE_NAMES


def test_deterministic_given_seed():
    fields = [{"name": "x", "type": "integer", "min": 0, "max": 1_000_000}]
    a = generate(fields, 20, seed=7)
    b = generate(fields, 20, seed=7)
    c = generate(fields, 20, seed=8)
    assert a == b          # same seed -> identical
    assert a != c          # different seed -> different


def test_integer_and_float_constraints():
    rows = generate([
        {"name": "i", "type": "integer", "min": 5, "max": 9},
        {"name": "f", "type": "float", "min": 0.0, "max": 1.0, "decimals": 3},
    ], 50, seed=1)
    assert all(5 <= r["i"] <= 9 for r in rows)
    assert all(0.0 <= r["f"] <= 1.0 for r in rows)


def test_choice_and_id():
    rows = generate([
        {"name": "id", "type": "id"},
        {"name": "c", "type": "choice", "choices": ["x", "y"]},
    ], 4, seed=1)
    assert [r["id"] for r in rows] == [1, 2, 3, 4]
    assert all(r["c"] in {"x", "y"} for r in rows)


def test_pii_free_by_construction():
    rows = generate(PRESETS["users"], 100, seed=3)
    for r in rows:
        # emails only on RFC-2606 reserved domains
        assert re.search(r"@example\.(com|org|net)$", r["email"])
        # phones only in the reserved fictional 555-01xx range
        assert re.search(r"555-01\d\d$", r["phone"])


def test_presets_generate():
    for name, fields in PRESETS.items():
        rows = generate(fields, 3, seed=1)
        assert len(rows) == 3
        assert set(rows[0].keys()) == {f["name"] for f in fields}, name


def test_validation_errors():
    with pytest.raises(ValueError):
        generate([], 5)
    with pytest.raises(ValueError):
        generate([{"name": "a", "type": "nope"}], 5)
    with pytest.raises(ValueError):
        generate([{"name": "a", "type": "id"}, {"name": "a", "type": "id"}], 5)


def test_row_cap():
    assert len(generate([{"name": "x", "type": "id"}], 5000, seed=1)) == 1000


def test_to_csv_roundtrips_columns():
    rows = generate(
        [{"name": "id", "type": "id"}, {"name": "c", "type": "city"}], 2, seed=1
    )
    csv = to_csv(rows)
    assert csv.splitlines()[0] == "id,c"
    assert len(csv.strip().splitlines()) == 3  # header + 2


def test_all_types_callable():
    fields = [{"name": t, "type": t} for t in TYPE_NAMES]
    rows = generate(fields, 2, seed=1)
    assert len(rows) == 2 and len(rows[0]) == len(TYPE_NAMES)
