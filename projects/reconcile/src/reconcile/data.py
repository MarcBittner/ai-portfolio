"""Synthetic, fully-fictional fixtures for the reconciliation demo.

Nothing here is real: the project, firms, codes, and rates are invented for this
portfolio. The example domain is a construction change order (CSI MasterFormat
subcodes), but the pipeline is domain-generic — swap the baseline/rate tables and
it reconciles invoices, POs, or any line-itemed document.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class LineSpec:
    description: str
    unit: str
    quantity: float
    unit_cost: float


@dataclass(frozen=True)
class RateBand:
    unit: str
    low: float
    typical: float
    high: float


# Original agreed contract — the baseline every change order is diffed against.
BASELINE: dict[str, LineSpec] = {
    "03 30 00": LineSpec("Cast-in-place concrete", "CY", 100, 180.00),
    "04 20 00": LineSpec("Unit masonry", "SF", 2400, 36.00),
    "07 21 00": LineSpec("Thermal insulation", "SF", 8000, 2.10),
    "09 91 00": LineSpec("Painting", "SF", 5000, 2.50),
    "23 05 00": LineSpec("HVAC common work", "LS", 1, 60000.00),
    "26 05 00": LineSpec("Electrical common work", "LS", 1, 45000.00),
}

# Independent market unit-cost bands (low / typical / high) by CSI subcode.
# Includes codes absent from the baseline, for genuinely-new scope items.
MARKET: dict[str, RateBand] = {
    "03 30 00": RateBand("CY", 165, 182, 200),
    "04 20 00": RateBand("SF", 34, 37, 42),
    "07 21 00": RateBand("SF", 1.80, 2.15, 2.60),
    "09 91 00": RateBand("SF", 2.20, 2.55, 3.10),
    "23 05 00": RateBand("LS", 54000, 61000, 70000),
    "26 05 00": RateBand("LS", 40000, 46000, 54000),
    "31 23 16": RateBand("CY", 18, 23, 30),       # excavation (new scope)
    "32 13 13": RateBand("SF", 7.0, 9.5, 12.0),   # concrete paving (new scope)
}


# --- sample change-order documents (what a GC/owner would upload) --------------

_CLEAN = """\
CHANGE ORDER #CO-021
Project: Cedar Ridge Mixed-Use — Building B
Prepared by: Northgate Builders LLC
Reason: Added balcony slabs and trim painting per owner request.

Line Items:
03 30 00 | Cast-in-place concrete | 30 CY | $184.00 | $5,520.00
09 91 00 | Painting | 800 SF | $2.60 | $2,080.00
04 20 00 | Unit masonry | 300 SF | $37.00 | $11,100.00

Change Order Total: $18,700.00
"""

_OVERCHARGED = """\
CHANGE ORDER #CO-014
Project: Cedar Ridge Mixed-Use — Building B
Prepared by: Northgate Builders LLC
Reason: Structural and mechanical revisions, level 3.

Line Items:
03 30 00 | Cast-in-place concrete | 120 CY | $245.00 | $29,400.00
04 20 00 | Unit masonry | 2,400 SF | $52.00 | $124,800.00
09 91 00 | Painting | 5,000 SF | $2.55 | $12,750.00
23 05 00 | HVAC common work | 1 LS | $86,000.00 | $86,000.00

Change Order Total: $252,950.00
"""

_AMBIGUOUS = """\
CHANGE ORDER #CO-103
Project: Cedar Ridge Mixed-Use — Site
Prepared by: Northgate Builders LLC
Reason: Unforeseen site conditions and added paving.

Line Items:
31 23 16 | Excavation | 400 CY | $24.00 | $9,600.00
32 13 13 | Concrete paving | 1,200 SF | $14.50 | $17,400.00
07 21 00 | Thermal insulation | 8,000 SF | $4.20 | $33,600.00
09 99 99 | Misc allowance | 1 LS | $5,000.00 | $5,000.00

Additional dewatering pump rental: 1 LS at $3,200.00 (CSI 31 23 19).

Change Order Total: $68,800.00
"""

SAMPLES: dict[str, str] = {
    "change-order-clean": _CLEAN,
    "change-order-overcharged": _OVERCHARGED,
    "change-order-ambiguous": _AMBIGUOUS,
}


# --- labeled ground truth for the extraction-accuracy eval --------------------
# Each entry is the set of line items a perfect extractor should return. The
# dewatering line in the ambiguous doc is written as prose (not a table row), so
# the deterministic table parser misses it — that gap is what the recall metric
# is meant to surface (extraction accuracy is measured, not asserted).

GROUND_TRUTH: dict[str, list[dict]] = {
    "change-order-clean": [
        {"csi": "03 30 00", "quantity": 30, "unit": "CY", "unit_cost": 184.00},
        {"csi": "09 91 00", "quantity": 800, "unit": "SF", "unit_cost": 2.60},
        {"csi": "04 20 00", "quantity": 300, "unit": "SF", "unit_cost": 37.00},
    ],
    "change-order-overcharged": [
        {"csi": "03 30 00", "quantity": 120, "unit": "CY", "unit_cost": 245.00},
        {"csi": "04 20 00", "quantity": 2400, "unit": "SF", "unit_cost": 52.00},
        {"csi": "09 91 00", "quantity": 5000, "unit": "SF", "unit_cost": 2.55},
        {"csi": "23 05 00", "quantity": 1, "unit": "LS", "unit_cost": 86000.00},
    ],
    "change-order-ambiguous": [
        {"csi": "31 23 16", "quantity": 400, "unit": "CY", "unit_cost": 24.00},
        {"csi": "32 13 13", "quantity": 1200, "unit": "SF", "unit_cost": 14.50},
        {"csi": "07 21 00", "quantity": 8000, "unit": "SF", "unit_cost": 4.20},
        {"csi": "09 99 99", "quantity": 1, "unit": "LS", "unit_cost": 5000.00},
        {"csi": "31 23 19", "quantity": 1, "unit": "LS", "unit_cost": 3200.00},
    ],
}
