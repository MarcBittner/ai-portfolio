"""Offline demo: run the fixture scan and print the control-mapped exposure
report, the LLM exec narrative + remediation guidance, and the remediation diff.

Run: python -m attack_surface.demo   (no network required)
"""

from attack_surface import narrative
from attack_surface.scanner import remediation_diff, scan, scan_fixture


def main() -> None:
    r = scan()
    p = r["posture"]
    print(f"Exposure report — {r['domain']} ({r['mode']} mode)")
    print(f"  posture: {p['score']}/100 grade {p['grade']} · "
          f"{p['controls_failing']}/{p['controls_total']} controls failing")
    sc = r["severity_counts"]
    print(f"  findings: {sc['critical']} critical, {sc['high']} high, "
          f"{sc['medium']} medium, {sc['low']} low "
          f"(across {len(r['assets']['subdomains'])} subdomains)\n")

    print("  Findings → controls:")
    for f in r["findings"]:
        print(f"    [{f['severity']:<8}] {f['title']:<42} {f['asset']}")
        print(f"               → {', '.join(f['controls'])}")

    print("\n  Failing controls:")
    for c in r["controls"]:
        if c["status"] == "fail":
            print(f"    {c['id']:<12} {c['title']:<42} ({c['finding_count']} findings)")

    # --- LLM exec narrative + remediation guidance --------------------------
    narr = narrative.generate(scan_fixture())
    print(f"\n  Executive risk narrative  (via {narr['provider']}):")
    for line in _wrap(narr["summary"], 72):
        print(f"    {line}")
    print("\n  Remediation guidance (top findings):")
    for rem in narr["remediations"]:
        print(f"    • [{rem['rule_id']}] {rem['finding']}")
        for line in _wrap(rem["steps"], 68):
            print(f"        {line}")

    # --- Remediation diff: before/after fixing the two criticals ------------
    d = remediation_diff()
    b, a = d["before"]["posture"], d["after"]["posture"]
    print("\n  Remediation diff (fixing the two critical findings):")
    print(f"    fixed: {', '.join(d['fixed_findings'])}")
    print(f"    posture: {b['grade']} ({b['score']}/100) → {a['grade']} "
          f"({a['score']}/100)   +{d['score_delta']} points")
    print(f"    controls failing: {b['controls_failing']}/{b['controls_total']} → "
          f"{a['controls_failing']}/{a['controls_total']}")
    print(f"    controls remediated: {', '.join(d['controls_remediated'])}")


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
