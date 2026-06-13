# postureline — Development Plan

**Legend:** `[x]` complete · `[>]` in progress · `[ ]` pending

## Phase 0 — MVP (v0.1.0) ✅

- [x] Scaffold (pyproject, run.sh w/ smoke + eval, Dockerfile, LICENSE, .env.example)
- [x] Shared core: canonical `Finding` model (`findings.py`) both scanners emit
- [x] Scanner registry (`scanners/`): `{warehouse, exposure}` → scanner callable
- [x] Warehouse scanner: DuckDB/Snowflake-style claims + classification (LLM for
      free-text PHI); masking-policy-as-code (Snowflake DDL + Terraform); k-anon; CI gate
- [x] Exposure scanner: internet-intelligence inventory + structural fingerprinting
- [x] Unified six-framework control catalog + crosswalk (SOC 2 / HIPAA / ISO 27001 /
      NIST 800-53 / NIST 800-171 / CMMC); per-control + per-framework roll-up
- [x] Severity-weighted saturating posture + grade; remediation diff (both surfaces)
- [x] LLM exec/board narrative parameterized by surface + deterministic template
- [x] Auditor evidence export (per-control bundle + crosswalk, JSON/CSV)
- [x] FastAPI surface (both surfaces) + two-tab console UI
- [x] Reproducible eval over BOTH surfaces → eval-report.md
- [x] Tests: llm / findings / controls / warehouse / exposure / api + opt-in live smoke
- [x] ruff clean, `./run.sh demo` runs both surfaces offline

## Merge provenance

This project merges two prior demos behind one engine; both retire after review.
- **warehouse surface** ← maskline (classification, masking-policy-as-code, k-anon, gate)
- **exposure surface** ← perimeter (inventory, fingerprint, multi-framework crosswalk,
  posture/diff, board narrative, evidence export)
- `llm.py` was byte-identical between them and is copied verbatim.

## Roadmap

- [ ] Third surface (e.g. IaC / cloud-config scan) — one registry entry + a module
- [ ] Ingest a real internet-scan export / real Snowflake `information_schema`
- [ ] Posture drift over time (diff successive scans per surface)
- [ ] More frameworks (NIST CSF, CIS, PCI-DSS) in the crosswalk
- [ ] Deploy live on Render (free) + add to the portfolio "Live demos" table
