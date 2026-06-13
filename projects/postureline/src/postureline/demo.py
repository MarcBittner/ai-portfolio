"""Offline end-to-end demo: run BOTH surfaces through the one shared engine.

Run: python -m postureline.demo   (no network or keys required)

Warehouse: classify → masking-policy-as-code + k-anon + CI gate → posture.
Exposure:  inventory → fingerprint → multi-framework crosswalk → remediation diff
           → board narrative. Both go through the identical controls/posture core.
"""

from postureline import controls, data, scan


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


def _posture_line(p: dict) -> str:
    return (f"posture {p['score']}/100 grade {p['grade']} · "
            f"{p['controls_failing']}/{p['controls_total']} controls · "
            f"{p['frameworks_failing']}/{p['frameworks_total']} frameworks failing")


def warehouse_surface() -> None:
    r = scan.run("warehouse", include_narrative=True)
    x = r["extras"]
    print("=" * 72)
    print("SURFACE: warehouse  —  data-access governance + masking-policy-as-code")
    print("=" * 72)
    print(f"  warehouse {x['warehouse']} ({x['engine']}) · "
          f"{len(x['classified'])} columns, {len(x['sensitive'])} sensitive")
    print(f"  {_posture_line(r['posture'])}\n")

    print("  Sensitive columns (name/type heuristics + LLM for free-text PHI):")
    for c in x["sensitive"]:
        via = "LLM" if c["method"] == "llm" else "rule"
        phi = f"  phi={c['phi_types']}" if c["phi_types"] else ""
        print(f"    {c['table']}.{c['column']:16} → {c['class']:10} ({via}){phi}")

    print("\n  Generated Snowflake masking + row-access DDL (excerpt):")
    for line in x["policy"]["snowflake_ddl"].splitlines()[6:15]:
        print(f"    {line}")
    print("    …")
    print("  Generated Terraform (snowflake provider, excerpt):")
    tf = x["policy"]["terraform"].splitlines()
    start = next(i for i, ln in enumerate(tf)
                 if ln.startswith('resource "snowflake_masking_policy"'))
    for line in tf[start:start + 6]:
        print(f"    {line}")
    print("    …")

    g = x["gate"]
    verdict = "PASS" if g["pass"] else f"FAIL (exit {g['exit_code']})"
    print(f"\n  CI gate: {verdict} — {g['reason']}")

    k = x["kanon"]
    print("\n  Re-identification risk (k-anonymity over quasi-identifiers):")
    print(f"    quasi {k['quasi_identifiers']} → k_min={k['k_min']}; "
          f"{k['singleton_count']}/{k['records']} singletons "
          f"(threshold k≥{k['k_threshold']})")
    for row in x["sweep"]:
        print(f"      {row['generalization']:24} k_min={row['k_min']:>2} "
              f"singletons={row['singletons']:>2}")

    print("\n  Findings → controls:")
    for f in r["findings"]:
        print(f"    [{f['severity']:<8}] {f['title']:<46} {f['resource']}")
        print(f"               → {', '.join(f['control_ids'])}")

    n = r["narrative"]
    print(f"\n  Exec risk report (via {n['provider']}):")
    for line in _wrap(n["summary"], 70):
        print(f"    {line}")

    d = scan.diff("warehouse")
    b, a = d["before"]["posture"], d["after"]["posture"]
    print("\n  Remediation diff (mask the PHI column + clear k threshold):")
    print(f"    {b['grade']} ({b['score']}/100) → {a['grade']} ({a['score']}/100) "
          f"  +{d['score_delta']} pts · remediates {', '.join(d['controls_remediated'])}")


def exposure_surface() -> None:
    r = scan.run("exposure", include_narrative=True)
    x = r["extras"]
    inv = x["inventory"]
    print("\n" + "=" * 72)
    print("SURFACE: exposure  —  internet-intelligence → multi-framework GRC posture")
    print("=" * 72)
    print(f"  estate {x['estate']} (as of {x['scan_date']}) · "
          f"{inv['hosts']} hosts · {inv['services']} services · "
          f"{inv['internet_open_services']} internet-open · {len(inv['asns'])} ASNs")
    print(f"  {_posture_line(r['posture'])}\n")

    print("  Findings → controls:")
    for f in r["findings"]:
        print(f"    [{f['severity']:<8}] {f['title']:<46} {f['resource']}")
        print(f"               → {', '.join(f['control_ids'])}")

    print("\n  Multi-framework roll-up (one finding → six frameworks):")
    for fw in r["framework_rollup"]:
        flag = "FAIL" if fw["status"] == "fail" else "pass"
        ids = ", ".join(fw["failing_control_ids"]) or "—"
        print(f"    {fw['framework']:<14} {flag:<4} "
              f"{fw['controls_failing']}/{fw['controls_total']} failing  ({ids})")

    d = scan.diff("exposure")
    b, a = d["before"]["posture"], d["after"]["posture"]
    print("\n  Remediation diff (close the top exposures):")
    print(f"    fixed: {', '.join(d['fixed_findings'])}")
    print(f"    {b['grade']} ({b['score']}/100) → {a['grade']} ({a['score']}/100) "
          f"  +{d['score_delta']} pts")
    print(f"    controls remediated: {', '.join(d['controls_remediated'])}")

    n = r["narrative"]
    print(f"\n  Board / exec risk report (via {n['provider']}):")
    for line in _wrap(n["summary"], 70):
        print(f"    {line}")
    print("  Top risks:")
    for risk in n["top_risks"][:5]:
        print(f"    • [{risk['id']}] {risk['risk']}")


def main() -> None:
    data.reset()
    print(f"postureline — one posture/compliance engine, "
          f"{len(controls.frameworks())} frameworks, two surfaces\n")
    warehouse_surface()
    exposure_surface()


if __name__ == "__main__":
    main()
