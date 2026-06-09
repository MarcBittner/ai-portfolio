"""Extraction: label-anchoring, validation/normalization, provenance."""

import pytest

from doc_extract.extract import extract

INVOICE = (
    "ACME Supplies Co.\nInvoice #: INV-2026-0042\nInvoice date: 2026-03-14\n"
    "Due date: 04/13/2026\nTotal due: $1,284.50\n"
    "email: billing@acme.example or phone (415) 555-0148."
)


def _by_name(results):
    return {r.name: r for r in results}


def test_invoice_fields_extracted():
    _schema, results = extract(INVOICE, "invoice")
    f = _by_name(results)
    assert f["invoice_number"].value == "INV-2026-0042"
    assert f["invoice_number"].method == "label"
    assert f["total"].value == "$1,284.50"
    assert f["vendor_email"].value == "billing@acme.example"
    assert f["vendor_phone"].value == "(415) 555-0148"
    assert all(f[k].found for k in
               ("invoice_number", "invoice_date", "due_date", "total",
                "vendor_email", "vendor_phone"))


def test_date_and_money_normalization():
    _schema, results = extract(INVOICE, "invoice")
    f = _by_name(results)
    assert f["invoice_date"].normalized == "2026-03-14"
    assert f["due_date"].normalized == "2026-04-13"   # 04/13/2026 -> ISO
    assert f["total"].normalized == "1284.50"          # $1,284.50 -> number
    assert f["invoice_date"].valid and f["total"].valid


def test_provenance_spans_point_at_the_value():
    _schema, results = extract(INVOICE, "invoice")
    for r in results:
        if r.found:
            assert INVOICE[r.start:r.end] == r.value


def test_label_anchored_beats_global_confidence():
    _schema, results = extract(INVOICE, "invoice")
    f = _by_name(results)
    # everything here is label-anchored (>=0.85), not a bare global match
    assert f["vendor_email"].confidence >= 0.85
    assert f["vendor_email"].method == "label"


def test_global_pattern_fallback_lower_confidence():
    # no labels, just a bare email in free text -> pattern method, lower conf
    _schema, results = extract("reach me sometime at jo@example.com thanks", "contact")
    f = _by_name(results)
    assert f["email"].found and f["email"].method == "pattern"
    assert f["email"].value == "jo@example.com"
    assert f["email"].confidence < 0.85


def test_missing_field_marked_not_found():
    _schema, results = extract("just some prose with no fields", "invoice")
    assert all(not r.found for r in results)


def test_invalid_date_validation_flag():
    # matches the date pattern but isn't a real calendar date
    _schema, results = extract("Invoice date: 13/45/2026", "invoice")
    f = _by_name(results)
    assert f["invoice_date"].found
    assert f["invoice_date"].valid is False
    assert f["invoice_date"].normalized is None


def test_unknown_schema_raises():
    with pytest.raises(ValueError):
        extract("x", "nope")
