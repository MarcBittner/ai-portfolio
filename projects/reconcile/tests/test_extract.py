from reconcile.data import SAMPLES
from reconcile.extract import extract_line_items, parse_table


def test_parses_all_table_rows():
    items = parse_table(SAMPLES["change-order-overcharged"])
    assert len(items) == 4
    by_csi = {it.csi: it for it in items}
    assert by_csi["03 30 00"].unit_cost == 245.0
    assert by_csi["03 30 00"].quantity == 120.0
    assert by_csi["04 20 00"].total == 124800.0
    assert all(it.method == "table" for it in items)


def test_provenance_spans_point_at_the_row():
    text = SAMPLES["change-order-clean"]
    for it in parse_table(text):
        assert it.start is not None and it.end is not None
        assert it.csi in text[it.start:it.end]


def test_confidence_drops_when_total_inconsistent():
    # qty*unit_cost = 200 but total stated as 999 → low confidence
    doc = "Line:\n03 30 00 | Concrete | 10 CY | $20.00 | $999.00\n"
    [it] = parse_table(doc)
    assert it.confidence < 0.7


def test_prose_line_is_not_picked_up_by_table_parser():
    # the ambiguous doc hides one item in prose; the strict parser sees 4 rows
    items = parse_table(SAMPLES["change-order-ambiguous"])
    assert {it.csi for it in items} == {"31 23 16", "32 13 13", "07 21 00", "09 99 99"}


def test_offline_extract_uses_table_path_without_model():
    items, routing, method = extract_line_items(
        SAMPLES["change-order-clean"], use_llm=False
    )
    assert method == "table" and routing is None and len(items) == 3
