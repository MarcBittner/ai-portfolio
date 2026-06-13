"""Offline governance walkthrough: discover the warehouse, classify columns,
generate masking + row-access policy-as-code, score re-identification risk, map to
SOC 2 / HIPAA controls, and run the CI gate.

Run: python -m maskline.demo   (no network or keys required)
"""

from maskline import classify, controls, llm, narrative, policy, risk, scan, warehouse


def main() -> None:
    warehouse.reset()

    print("Warehouse (Snowflake-compatible SQL on DuckDB):")
    for t in warehouse.schema():
        print(f"   {t['fqn']:28} {len(t['columns'])} columns")

    classified = classify.classify_all()
    sensitive = [c for c in classified if c["sensitive"]]
    print(f"\nColumn classification ({len(classified)} columns, "
          f"{len(sensitive)} sensitive):")
    for c in sensitive:
        via = "LLM" if c["method"] == "llm" else "rule"
        phi = f"  phi={c['phi_types']}" if c["phi_types"] else ""
        print(f"   {c['table']}.{c['column']:16} → {c['class']:10} ({via}){phi}")

    s = llm.status()
    active = next((p for p, ok in s["providers"].items() if ok), "offline")
    print(f"\n   routing mode={s['mode']}  active={active}  "
          "(chain: Anthropic/OpenAI → Ollama → OpenRouter → offline)")

    print("\nGenerated Snowflake masking + row-access DDL (excerpt):")
    ddl = policy.generate_snowflake_ddl(classified)
    for line in ddl.splitlines()[6:16]:
        print(f"   {line}")
    print("   …")

    print("\nGenerated Terraform (snowflake provider, excerpt):")
    tf = policy.generate_terraform(classified)
    start = next(i for i, ln in enumerate(tf.splitlines())
                 if ln.startswith('resource "snowflake_masking_policy"'))
    for line in tf.splitlines()[start:start + 8]:
        print(f"   {line}")
    print("   …")

    cov = policy.coverage(classified)
    print("\nPolicy coverage (the gap a name-rule policy misses):")
    print(f"   {cov['covered_columns']}/{cov['must_mask_columns']} "
          "required columns masked")
    for u in cov["uncovered_columns"]:
        print(f"   UNCOVERED: {u['table']}.{u['column']} ({u['class']}) "
              "— free-text PHI found by the scan, no masking policy")

    g = scan.gate(cov)
    verdict = "PASS" if g["pass"] else f"FAIL (exit {g['exit_code']})"
    print(f"\nCI gate: {verdict} — {g['reason']}")

    k = risk.k_anonymity()
    print("\nRe-identification risk (k-anonymity over quasi-identifiers):")
    print(f"   quasi {k['quasi_identifiers']} → k_min={k['k_min']}; "
          f"{k['singleton_count']}/{k['records']} rows are singletons "
          "(re-identifiable by linkage)")
    print("   coarser generalization raises k (privacy/utility lever):")
    for row in risk.generalization_sweep():
        print(f"     {row['generalization']:24} k_min={row['k_min']:>2} "
              f"singletons={row['singletons']:>2}")

    posture = controls.evaluate(classified, cov, k)
    print(f"\nControl posture: {posture['posture_score']}/100 "
          f"(grade {posture['grade']}), "
          f"{posture['passed']}/{posture['passed'] + posture['failed']} controls pass:")
    for ctl in posture["controls"]:
        mark = "PASS" if ctl["status"] == "pass" else "FAIL"
        print(f"   [{mark}] {ctl['id']:18} {ctl['detail']}")

    summary = scan.scan()["summary"]
    nar = narrative.summarize(summary)
    print(f"\nExecutive risk summary ({nar['provider']}):")
    print(f"   {nar['summary']}")


if __name__ == "__main__":
    main()
