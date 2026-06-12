"""Seeded, reproducible synthetic political-contribution rows — all fictional.

Donors, committees, cycles, and amounts are invented; amounts follow a realistic
skew (mostly small unitemized gifts under the $200 FEC itemization threshold, a
long tail toward the contribution limit). Seeded so the dataset — and therefore
the query plans and load-test numbers — reproduce exactly.
"""

import random

CYCLES = [2020, 2022, 2024, 2026]
_CYCLE_WEIGHTS = [0.15, 0.20, 0.28, 0.37]   # more recent cycles raise more
ITEMIZED_THRESHOLD = 200.0                  # FEC itemization threshold

COMMITTEES = {
    "C-0001": "Harbor Forward PAC",
    "C-0002": "Cedar Valley for Congress",
    "C-0003": "Riverside Victory Fund",
    "C-0004": "Summit State Leadership",
    "C-0005": "Coastline Action Committee",
    "C-0006": "Granite District PAC",
    "C-0007": "Meadowbrook for Senate",
    "C-0008": "Northgate Progress Fund",
    "C-0009": "Lakeshore Citizens PAC",
    "C-0010": "Foothill United",
    "C-0011": "Brightline Future Fund",
    "C-0012": "Old Mill Civic Action",
}
_CIDS = list(COMMITTEES)


def generate(n: int, seed: int = 42) -> list[tuple]:
    """Return ``n`` rows: (id, donor_id, committee_id, cycle, amount, ts)."""
    rng = random.Random(seed)
    n_donors = max(1000, n // 4)            # ~4 contributions per donor on average
    rows: list[tuple] = []
    for i in range(1, n + 1):
        cycle = rng.choices(CYCLES, weights=_CYCLE_WEIGHTS)[0]
        committee = rng.choice(_CIDS)
        donor = f"D-{rng.randrange(n_donors):06d}"
        r = rng.random()
        if r < 0.70:
            amount = round(rng.uniform(5, 200), 2)        # unitemized
        elif r < 0.95:
            amount = round(rng.uniform(200, 1000), 2)
        else:
            amount = round(rng.uniform(1000, 5800), 2)    # near the limit
        ts = f"{cycle}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}"
        rows.append((i, donor, committee, cycle, amount, ts))
    return rows
