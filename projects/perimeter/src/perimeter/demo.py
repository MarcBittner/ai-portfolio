"""Offline end-to-end demo: ingest the internet-intelligence inventory and print
the governed posture, the multi-framework control roll-up, the remediation diff,
and the LLM board/exec risk report.

Run: python -m perimeter.demo   (no network required)
"""

from perimeter import evidence, narrative
from perimeter.scan import remediation_diff, scan


def main() -> None:
    r = scan()
    p = r["posture"]
    inv = r["inventory"]

    print(f"Internet-exposure posture — {r['estate']} (as of {r['scan_date']})")
    print(f"  inventory: {inv['hosts']} hosts · {inv['services']} services · "
          f"{inv['internet_open_services']} internet-open · {inv['tls_services']} TLS "
          f"· {len(inv['asns'])} ASNs across {len(inv['countries'])} countries")
    print(f"  posture: {p['score']}/100 grade {p['grade']} · "
          f"{p['controls_failing']}/{p['controls_total']} controls failing · "
          f"{p['frameworks_failing']}/{p['frameworks_total']} frameworks failing")
    sc = r["severity_counts"]
    print(f"  exposures: {sc['critical']} critical, {sc['high']} high, "
          f"{sc['medium']} medium, {sc['low']} low\n")

    print("  Exposure findings → controls:")
    for f in r["findings"]:
        print(f"    [{f['severity']:<8}] {f['title']:<46} {f['asset']}")
        print(f"               → {', '.join(f['controls'])}")

    print("\n  Multi-framework roll-up:")
    for fw in r["framework_rollup"]:
        flag = "FAIL" if fw["status"] == "fail" else "pass"
        ids = ", ".join(fw["failing_control_ids"]) or "—"
        print(f"    {fw['framework']:<14} {flag:<4} "
              f"{fw['controls_failing']}/{fw['controls_total']} failing  ({ids})")

    # --- Remediation diff: posture over time -------------------------------
    d = remediation_diff()
    b, a = d["before"]["posture"], d["after"]["posture"]
    print("\n  Remediation diff (fixing the top exposures):")
    print(f"    fixed: {', '.join(d['fixed_findings'])}")
    print(f"    posture: {b['grade']} ({b['score']}/100) → {a['grade']} "
          f"({a['score']}/100)   +{d['score_delta']} points")
    print(f"    controls remediated: {', '.join(d['controls_remediated'])}")
    print(f"    frameworks cleared: {', '.join(d['frameworks_cleared']) or 'none'}")

    # --- LLM board / exec risk report --------------------------------------
    narr = narrative.generate(scan())
    print(f"\n  Board / exec risk report  (via {narr['provider']}):")
    for line in _wrap(narr["summary"], 72):
        print(f"    {line}")
    print("\n  Top risks:")
    for risk in narr["top_risks"]:
        print(f"    • [{risk['rule_id']}] {risk['risk']}")
        for line in _wrap(risk["impact"], 68):
            print(f"        {line}")
    print("\n  What remediation buys:")
    for line in _wrap(narr["remediation"], 72):
        print(f"    {line}")
    print("\n  Residual risk:")
    for line in _wrap(narr["residual_risk"], 72):
        print(f"    {line}")

    # --- Evidence export sample --------------------------------------------
    b6 = evidence.bundle("CC6.6")["controls"][0]
    print(f"\n  Evidence export (control CC6.6 — {b6['title']}):")
    crosswalk = " · ".join(f"{k} {v}" for k, v in b6["frameworks"].items())
    print(f"    crosswalk: {crosswalk}")
    print(f"    status: {b6['status']} · {b6['finding_count']} findings "
          f"({', '.join(e['asset'] for e in b6['evidence'])})")
    print("    (full per-control JSON/CSV via GET /evidence?control=&format=)")


def _wrap(text: str, width: int) -> list[str]:
    out, line = [], ""
    for word in text.split():
        if len(line) + len(word) + 1 > width and line:
            out.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    if line:
        out.append(line)
    return out


if __name__ == "__main__":
    main()
