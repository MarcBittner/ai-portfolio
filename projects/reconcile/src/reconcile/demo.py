"""Offline demo: reconcile the overcharged sample and print the findings + eval.

Run: python -m reconcile.demo   (no model, no network required)
"""

from reconcile.data import SAMPLES
from reconcile.evaluate import run_eval
from reconcile.extract import extract_line_items
from reconcile.review import build_queue
from reconcile.variance import reconcile_items


def main() -> None:
    name = "change-order-overcharged"
    items, _routing, method = extract_line_items(SAMPLES[name], use_llm=False)
    reconciled = reconcile_items(items)
    summary = reconciled["summary"]

    print(f"Document: {name}  (extraction: {method}, {len(items)} line items)\n")
    print(f"{'CSI':<10}{'VERDICT':<11}{'UNIT $':>11}{'Δ%':>8}{'RECOVER $':>13}")
    print("-" * 53)
    for ln in reconciled["lines"]:
        dpct = f"{ln['delta_pct'] * 100:+.0f}%" if ln["delta_pct"] is not None else "—"
        print(f"{ln['csi']:<10}{ln['verdict']:<11}{ln['unit_cost']:>11,.2f}"
              f"{dpct:>8}{ln['recoverable']:>13,.2f}")

    print(f"\nDocument total : ${summary['document_total']:,.2f}")
    print(f"Lines over     : {summary['flagged_over']}")
    print(f"Recoverable    : ${summary['recoverable_total']:,.2f}")

    queue = build_queue(reconciled)
    print(f"\nReview queue ({queue['count']} lines, ${queue['recoverable_total']:,.2f}):")
    for q in queue["queue"]:
        print(f"  • {q['csi']} [{q['reason']}] — {q['rationale']}")

    agg = run_eval()["aggregate"]
    print(f"\nExtraction eval: P={agg['precision']:.2f} R={agg['recall']:.2f} "
          f"F1={agg['f1']:.2f} over {agg['documents']} labeled documents")


if __name__ == "__main__":
    main()
