"""Generate reproducible synthetic rows from a field schema, plus presets.

Given the same ``(fields, n, seed)`` the output is identical (seeded Mersenne
Twister), so datasets are reproducible and diffable. Presets are ready-made
schemas; custom schemas are just a list of ``{name, type, ...constraints}``.
"""

import csv
import io
import random

from synth_data.generators import TYPE_NAMES, TYPES

MAX_ROWS = 1000

PRESETS: dict[str, list[dict]] = {
    "users": [
        {"name": "id", "type": "id"},
        {"name": "name", "type": "name"},
        {"name": "email", "type": "email"},
        {"name": "phone", "type": "phone"},
        {"name": "age", "type": "integer", "min": 18, "max": 80},
        {"name": "city", "type": "city"},
        {"name": "signed_up", "type": "date", "start": "2024-01-01",
         "end": "2026-06-01"},
        {"name": "active", "type": "bool"},
    ],
    "transactions": [
        {"name": "id", "type": "uuid"},
        {"name": "user_id", "type": "integer", "min": 1, "max": 500},
        {"name": "amount", "type": "float", "min": 1.0, "max": 999.0,
         "decimals": 2},
        {"name": "currency", "type": "choice", "choices": ["USD", "EUR", "GBP"]},
        {"name": "status", "type": "choice",
         "choices": ["pending", "settled", "refunded"]},
        {"name": "date", "type": "date", "start": "2026-01-01",
         "end": "2026-12-31"},
    ],
    "support_tickets": [
        {"name": "id", "type": "id"},
        {"name": "requester", "type": "name"},
        {"name": "subject", "type": "sentence", "words": 6},
        {"name": "priority", "type": "choice",
         "choices": ["low", "medium", "high", "urgent"]},
        {"name": "status", "type": "choice", "choices": ["open", "pending", "closed"]},
        {"name": "created", "type": "date", "start": "2026-01-01",
         "end": "2026-06-30"},
    ],
}
PRESET_NAMES = list(PRESETS)


def generate(fields: list[dict], n: int, seed: int = 42) -> list[dict]:
    """Generate ``n`` rows from ``fields`` deterministically given ``seed``."""
    if not fields:
        raise ValueError("at least one field is required")
    seen: set[str] = set()
    for f in fields:
        if "name" not in f or "type" not in f:
            raise ValueError("each field needs a name and a type")
        if f["type"] not in TYPES:
            raise ValueError(f"unknown type {f['type']!r}; valid: {TYPE_NAMES}")
        if f["name"] in seen:
            raise ValueError(f"duplicate field name {f['name']!r}")
        seen.add(f["name"])
    n = max(1, min(int(n), MAX_ROWS))
    rng = random.Random(seed)
    return [
        {f["name"]: TYPES[f["type"]](rng, f, i) for f in fields}
        for i in range(n)
    ]


def to_csv(rows: list[dict]) -> str:
    if not rows:
        return ""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue()
