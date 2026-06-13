# postureline — Specification

## Overview

`postureline` is **one security-posture & compliance engine with two pluggable
exposure surfaces**. Both surfaces share the identical pipeline —
`scan → findings → control crosswalk → severity posture → LLM narrative →
remediation diff` — and differ only in what they scan:

- **warehouse** — data-access governance on a regulated analytics warehouse
  (DuckDB driven with Snowflake-compatible SQL): column classification (name/type
  heuristics + an LLM for free-text PHI), masking-policy-as-code (Snowflake DDL +
  Terraform), k-anonymity re-identification risk, and a CI gate.
- **exposure** — internet-intelligence inventory (hosts/services/TLS/ASN) →
  structural exposure detectors.

A scanner registry (`scanners/`) maps each surface to a scanner that reduces its
native artifacts to the **canonical `Finding`** the shared core consumes. The
control catalog is a single **six-framework** crosswalk (SOC 2 / HIPAA / ISO 27001
/ NIST 800-53 / NIST 800-171 / CMMC). Runs fully offline on synthetic data.

## Functional requirements

- **FR-1 Canonical findings.** One `Finding` model both scanners emit:
  `{id, surface, severity, resource, evidence, control_ids, remediation, title}`,
  `surface ∈ {warehouse, exposure}`. Every finding maps to ≥ 1 control.
- **FR-2 Scanner registry.** `{warehouse, exposure}` → scanner callable; adding a
  surface is one registry entry plus a module that emits `Finding`s.
- **FR-3 Warehouse scanner.** DuckDB/Snowflake-style claims warehouse + column
  classification (LLM for free-text PHI) → findings; keeps masking-policy-as-code
  (`warehouse_policy.py`: Snowflake DDL + Terraform), k-anonymity (`kanon.py`), and
  the CI gate (unmasked sensitive column ⇒ fail).
- **FR-4 Exposure scanner.** Internet-intelligence inventory + structural
  fingerprinting → findings.
- **FR-5 Unified multi-framework controls.** One catalog crosswalking six
  frameworks; per-control roll-up (fail iff any finding maps) + per-framework
  aggregation.
- **FR-6 Posture.** Severity-weighted, saturating 0–100 score + grade (shared).
- **FR-7 Remediation diff.** A `--remediated` 'after' state + before/after diff
  (score lift + controls/frameworks flipped) for either surface.
- **FR-8 Narrative.** An LLM exec/board risk report over the *computed* posture,
  parameterized by surface; deterministic offline template; never re-derives.
- **FR-9 Evidence export.** Per-control finding bundle + six-framework crosswalk as
  JSON/CSV, per surface.
- **FR-10 API + UI.** FastAPI exposing both surfaces (`/scan/{surface}`,
  `/controls`, `/posture`, `/diff`, `/report`, `/evidence`, warehouse-only
  `/policy`·`/privacy`·`/gate`, `/evals`, `/llm`, `/health`) + a two-tab console.
- **FR-11 Evals.** Reproducible eval over BOTH surfaces → `eval-report.md`.
- **FR-12 Offline + safe.** Default mode needs no network; no secrets; synthetic
  data only (reserved IPs / `.test` names; fictional claims; no real PHI).

## Non-functional

- Stdlib-only LLM routing (`llm.py`, identical to the sibling demos); offline path
  always terminal.
- Deterministic core: classification (offline), policy, coverage, k-anon,
  fingerprint, posture, crosswalk reproduce to the digit with zero keys.
- ruff clean; pytest green; proprietary, offline-first, no secrets.

## Surfaces vs. controls

| Finding (surface) | control_ids | crosswalks to |
|---|---|---|
| `UNMASKED_PHI` (warehouse) | CC6.1 | HIPAA 164.312(a)(1), ISO A.8.3, AC-3, 3.1.1, AC.L2-3.1.1 |
| `REID_RISK` (warehouse) | GV1.1 | HIPAA 164.514(b), ISO A.8.11, SI-19, 3.1.3, AC.L2-3.1.3 |
| `DB_EXPOSED` (exposure) | CC6.6, CC7.2 | HIPAA 164.312(e)(1)/308…, ISO A.8.20/A.8.16, SC-7/SI-4, … |
| `TLS_*` (exposure) | CC6.7 | HIPAA 164.312(e)(2)(ii), ISO A.8.24, SC-8, 3.13.11, … |
| `EOL_SOFTWARE` (exposure) | CC6.8, CC7.1 | HIPAA 164.308…, ISO A.8.8, SI-2/RA-5, … |
