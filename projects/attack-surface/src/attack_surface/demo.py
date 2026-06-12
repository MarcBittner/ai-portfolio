"""Offline demo: run the fixture scan and print the control-mapped exposure report.

Run: python -m attack_surface.demo   (no network required)
"""

from attack_surface.scanner import scan


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


if __name__ == "__main__":
    main()
