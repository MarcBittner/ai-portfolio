"""Offline demo of the paved road.

Scaffold a new service from a free-text description, show the generated
Terraform/k8s/CI/SLO files, onboard it to the catalog, then run the example
price-transparency ingest workload and show its data-quality SLI.

Run: python -m baseplate.demo   (no network required)
"""

from baseplate import catalog, ingest, llm, scaffold, slo


def _preview(text: str, lines: int = 8) -> str:
    body = text.strip().splitlines()
    out = "\n".join("      " + ln for ln in body[:lines])
    if len(body) > lines:
        out += f"\n      … (+{len(body) - lines} more lines)"
    return out


def main() -> None:
    catalog.reset()

    s = llm.status()
    active = next((p for p, ok in s["providers"].items() if ok), "offline")
    print("Self-service scaffolder — free text → ServiceSpec → paved-road files")
    print(f"   routing mode={s['mode']}  active={active}  "
          "(chain: Anthropic/OpenAI → Ollama → OpenRouter → offline parser)\n")

    desc = ("A Python FastAPI service called rate-ingest that reads rates from "
            "Postgres and serves them over HTTP")
    print(f'   description: "{desc}"')
    spec, routing = scaffold.extract_spec(desc)
    print(f"   extracted ServiceSpec: name={spec.name} language={spec.language} "
          f"needs_db={spec.needs_db} exposes_http={spec.exposes_http}")
    print(f"   (via {routing['provider']}/{routing['model']}, "
          f"fallbacks={routing['fallbacks']})\n")

    gen = scaffold.generate(spec)
    print(f"   generated {len(gen['files'])} paved-road files:")
    for path in sorted(gen["files"]):
        print(f"     - {path}")

    print("\n   Terraform `service` module invocation "
          f"(deploy/terraform/{spec.name}.tf):")
    print(_preview(gen["files"][f"deploy/terraform/{spec.name}.tf"], 10))

    print(f"\n   Kubernetes manifest head (deploy/k8s/{spec.name}.yaml):")
    print(_preview(gen["files"][f"deploy/k8s/{spec.name}.yaml"], 10))

    print("\n   Golden CI pipeline head (.github/workflows/ci.yml):")
    print(_preview(gen["files"][".github/workflows/ci.yml"], 10))

    print("\n   SLO stub (slo.yaml):")
    print(_preview(gen["files"]["slo.yaml"], 8))

    on = catalog.onboard(gen["spec"])
    print(f"\n   onboarded '{on['onboarded']}' → catalog now has {on['count']} "
          "services:")
    for e in catalog.services():
        print(f"     - {e['name']:18} {e['language']:7} db={e['needs_db']!s:5} "
              f"http={e['exposes_http']!s:5} role={e['role']} "
              f"via={e['onboarded_via']}")

    print("\nExample workload: price-transparency ingest + data-quality SLI")
    dq = ingest.score()
    print(f"   loaded {dq['rows']} synthetic rate rows → "
          f"{dq['valid']} valid / {dq['invalid']} invalid")
    print(f"   data-quality pass rate (SLI) = {dq['data_quality_pass_rate']}  "
          f"defects={dq['defects']}")
    for f in dq["sample_failures"]:
        print(f"     row {f['row']}: {', '.join(f['issues'])}")

    print("\nSLOs (Datadog-style; data-quality SLI plugged in):")
    for so in slo.view()["slos"]:
        extra = ""
        if "current_sli_pct" in so:
            meet = "MEETING" if so["meeting_objective"] else "BURNING"
            extra = f"  current={so['current_sli_pct']}% [{meet}]"
        print(f"   {so['name']:18} objective={so['objective_pct']}%  "
              f"budget={so['error_budget_minutes_30d']}min/30d{extra}")


if __name__ == "__main__":
    main()
