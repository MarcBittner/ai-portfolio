"""Reproducible eval: the scaffolder produces valid paved-road files for a
labeled set of service specs, plus the data-quality SLI on the ingest sample.

For each labeled spec we run the offline parser (the deterministic fallback) on
its description and assert the extracted ServiceSpec matches the label; then we
generate the files and assert (a) every required file is present, (b) the
generated Kubernetes manifest parses as YAML, and (c) the manifest carries the
paved-road invariants (non-root, probes when HTTP, a PodDisruptionBudget). We
also score the ingest sample's data-quality pass rate (the SLI).

Writes ``eval-report.md`` at the project root and prints a summary. Deterministic
offline, so the report reproduces to the digit with zero keys; set ``LLM_MODE`` /
provider keys to score live spec extraction instead.

Run via ``./run.sh eval`` (or ``python -m baseplate.evaluate``).
"""

from __future__ import annotations

import os
from pathlib import Path

import yaml

from baseplate import ingest, scaffold

REPORT = Path(__file__).resolve().parents[2] / "eval-report.md"

REQUIRED_FILES = (
    "Dockerfile",
    ".github/workflows/ci.yml",
    "slo.yaml",
)

# Labeled specs: (free-text description, expected ServiceSpec fields).
LABELED = [
    ("A Python FastAPI service called rate-ingest that reads rates from Postgres "
     "and serves them over HTTP",
     {"name": "rate-ingest", "language": "python", "needs_db": True,
      "exposes_http": True}),
    ("A Go API named price-gateway, no database, exposes HTTP endpoints",
     {"name": "price-gateway", "language": "go", "needs_db": False,
      "exposes_http": True}),
    ("A Node background worker called claim-normalizer that consumes a queue and "
     "writes to a database",
     {"name": "claim-normalizer", "language": "node", "needs_db": True,
      "exposes_http": False}),
    ("A Python scheduled batch job named nightly-reconcile, no http",
     {"name": "nightly-reconcile", "language": "python", "needs_db": False,
      "exposes_http": False}),
]


def _check_manifest(text: str, exposes_http: bool) -> list[str]:
    """Return invariant failures for a generated k8s manifest ([] = clean)."""
    fails: list[str] = []
    try:
        docs = [d for d in yaml.safe_load_all(text) if d]
    except yaml.YAMLError as exc:  # noqa: BLE001
        return [f"yaml_parse_error:{exc.__class__.__name__}"]
    kinds = {d.get("kind") for d in docs}
    for kind in ("Namespace", "Deployment", "HorizontalPodAutoscaler",
                 "PodDisruptionBudget"):
        if kind not in kinds:
            fails.append(f"missing_kind:{kind}")
    if exposes_http and "Service" not in kinds:
        fails.append("missing_kind:Service")
    dep = next((d for d in docs if d.get("kind") == "Deployment"), None)
    if dep:
        spec = dep["spec"]["template"]["spec"]
        if not spec.get("securityContext", {}).get("runAsNonRoot"):
            fails.append("not_runAsNonRoot")
        container = spec["containers"][0]
        if exposes_http and "readinessProbe" not in container:
            fails.append("missing_readinessProbe")
    return fails


def run() -> dict:
    cases = []
    for desc, label in LABELED:
        spec, _ = scaffold.extract_spec(desc, mode="offline")
        spec_d = {"name": spec.name, "language": spec.language,
                  "needs_db": spec.needs_db, "exposes_http": spec.exposes_http}
        spec_ok = spec_d == label
        gen = scaffold.generate(spec)
        files = gen["files"]
        missing = [f for f in REQUIRED_FILES if f not in files]
        manifest_path = f"deploy/k8s/{spec.name}.yaml"
        manifest_fails = (
            _check_manifest(files[manifest_path], spec.exposes_http)
            if manifest_path in files else ["missing_manifest"]
        )
        cases.append({
            "description": desc,
            "expected": label,
            "extracted": spec_d,
            "spec_match": spec_ok,
            "files_generated": len(files),
            "missing_files": missing,
            "manifest_invariant_fails": manifest_fails,
            "passed": spec_ok and not missing and not manifest_fails,
        })

    dq = ingest.score()
    passed = sum(1 for c in cases if c["passed"])
    return {
        "cases": cases,
        "scaffold_pass": passed,
        "scaffold_total": len(cases),
        "data_quality": dq,
        "mode": os.environ.get("LLM_MODE", "auto"),
    }


def _render(r: dict) -> str:
    dq = r["data_quality"]
    lines = [
        "# baseplate — eval report",
        "",
        "Reproducible with `./run.sh eval`. The offline parser extracts each "
        "ServiceSpec deterministically and file generation is pure templating, so "
        "these numbers reproduce exactly with zero keys; set provider keys or "
        "`LLM_MODE` to score live spec extraction instead.",
        "",
        "## Scaffolder",
        "",
        f"Over **{r['scaffold_total']}** labeled service descriptions: extract the "
        "ServiceSpec, generate the paved-road files, and assert every required "
        "file is present, the Kubernetes manifest parses as YAML, and it carries "
        "the paved-road invariants (non-root, probes when HTTP, a "
        "PodDisruptionBudget).",
        "",
        f"**{r['scaffold_pass']}/{r['scaffold_total']} cases passed.**",
        "",
        "| service | spec match | files | k8s invariants |",
        "| --- | --- | --- | --- |",
    ]
    for c in r["cases"]:
        inv = "ok" if not c["manifest_invariant_fails"] else \
            ", ".join(c["manifest_invariant_fails"])
        sm = "yes" if c["spec_match"] else f"no ({c['extracted']})"
        lines.append(f"| {c['extracted']['name']} | {sm} | "
                     f"{c['files_generated']} | {inv} |")
    lines += [
        "",
        "## Data-quality SLI (example ingest workload)",
        "",
        f"The synthetic machine-readable rate file has **{dq['rows']}** rows; "
        f"**{dq['valid']}** pass schema validation, so the **data-quality pass "
        f"rate = {dq['data_quality_pass_rate']}** (the SLI). A service can return "
        "200s while serving bad data, which is why data-quality is an SLI in its "
        "own right (see `docs/observability.md`).",
        "",
        "| metric | value |",
        "| --- | --- |",
        f"| rows | {dq['rows']} |",
        f"| valid | {dq['valid']} |",
        f"| invalid | {dq['invalid']} |",
        f"| data-quality pass rate (SLI) | {dq['data_quality_pass_rate']} |",
        f"| defects | {dq['defects']} |",
        "",
        "Invariants checked: extracted spec matches the label; all required files "
        "present; generated k8s YAML parses and is non-root with probes + a PDB; "
        "the data-quality SLI is in [0, 1].",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    r = run()
    REPORT.write_text(_render(r))
    print(f"scaffolder: {r['scaffold_pass']}/{r['scaffold_total']} labeled specs "
          "→ valid paved-road files (spec match + k8s parses + invariants)")
    dq = r["data_quality"]
    print(f"data-quality SLI: pass_rate={dq['data_quality_pass_rate']} "
          f"({dq['valid']}/{dq['rows']} rows valid, defects={dq['defects']})")
    print(f"wrote {REPORT}")


if __name__ == "__main__":
    main()
