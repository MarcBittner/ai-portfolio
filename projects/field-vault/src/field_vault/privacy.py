"""Re-identification risk on the *de-identified* surface — k-anonymity.

Tokenizing direct identifiers is not enough: an attacker who never sees a name
can still single out an individual by **linking quasi-identifiers** (birth year,
ZIP prefix, service month) against an external dataset. k-anonymity measures that
exposure — the size of the smallest group sharing the same quasi-identifier
tuple. ``k = 1`` means a row is unique on its quasi-identifiers and is
re-identifiable by linkage even though every direct identifier was tokenized.

This is the healthcare-specific risk a column-by-column de-identifier misses, and
the lever that matters: coarser generalization raises k. All deterministic; runs
on the de-identified store, no PHI.
"""

from __future__ import annotations

from collections import Counter

DEFAULT_QUASI = ("dob", "zip", "service_date")


def _key(record: dict, quasi: tuple[str, ...]) -> tuple:
    return tuple(str(record.get(q)) for q in quasi)


def k_anonymity(records: list[dict], quasi: tuple[str, ...] = DEFAULT_QUASI) -> dict:
    """Equivalence-class sizes over the quasi-identifier tuple.

    Returns the minimum k, the class-size distribution, and the record_ids that
    are singletons (k=1 → re-identifiable by linkage).
    """
    classes: Counter = Counter(_key(r, quasi) for r in records)
    singletons = [r["record_id"] for r in records
                  if classes[_key(r, quasi)] == 1]
    sizes = sorted(classes.values())
    distribution = dict(sorted(Counter(sizes).items()))
    return {
        "quasi_identifiers": list(quasi),
        "k_min": sizes[0] if sizes else 0,
        "records": len(records),
        "equivalence_classes": len(classes),
        "singletons": singletons,
        "singleton_count": len(singletons),
        "class_size_distribution": {str(k): v for k, v in distribution.items()},
        "reidentifiable_by_linkage": len(singletons) > 0,
    }


def generalization_sweep(records: list[dict]) -> list[dict]:
    """Show the lever: dropping/coarsening quasi-identifiers raises k.

    Each row is a quasi-identifier set and the k it yields — the trade-off
    between data utility (more fields) and privacy (higher k).
    """
    configs = [
        ("dob + zip3 + service_month", ("dob", "zip", "service_date")),
        ("dob + zip3", ("dob", "zip")),
        ("birth-decade + zip3", ("_decade", "zip")),
        ("zip3 only", ("zip",)),
    ]
    out = []
    for label, quasi in configs:
        rows = records
        if "_decade" in quasi:
            rows = [{**r, "_decade": str(r["dob"])[:3] + "0s"} for r in records]
        res = k_anonymity(rows, quasi)
        out.append({"generalization": label, "k_min": res["k_min"],
                    "singletons": res["singleton_count"]})
    return out
