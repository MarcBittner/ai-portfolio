from txn_ledger.generate import COMMITTEES, CYCLES, generate


def test_deterministic_for_a_seed():
    assert generate(500, seed=7) == generate(500, seed=7)
    assert generate(500, seed=7) != generate(500, seed=8)


def test_row_shape_and_domains():
    rows = generate(2000, seed=1)
    assert len(rows) == 2000
    ids = [r[0] for r in rows]
    assert ids == list(range(1, 2001))                 # sequential ids
    for _id, donor, committee, cycle, amount, ts in rows[:50]:
        assert donor.startswith("D-")
        assert committee in COMMITTEES
        assert cycle in CYCLES
        assert isinstance(amount, float) and amount > 0
        assert ts.startswith(str(cycle))


def test_amount_skews_to_small_unitemized():
    rows = generate(5000, seed=3)
    small = sum(1 for r in rows if r[4] <= 200)
    assert small / len(rows) > 0.5                     # most gifts are unitemized
