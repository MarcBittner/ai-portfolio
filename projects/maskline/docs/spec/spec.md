# maskline — Specification

## Overview

A data-access governance + masking-policy-as-code tool for a regulated analytics
warehouse (synthetic healthcare claims). It introspects the warehouse,
auto-classifies sensitive columns (LLM for free-text PHI), generates
column-masking + row-access **policy-as-code** (Snowflake DDL + Terraform), flags
any sensitive column not covered by a policy as a **CI gate failure**, scores
**re-identification (k-anonymity) risk**, and maps findings to **SOC 2 / HIPAA**
controls with an LLM-written executive summary. Offline, deterministic, no real
PHI. The engine is **DuckDB** driven with **Snowflake-compatible SQL**; the
generated policy artifacts target a real **Snowflake** account in production.

## Functional requirements

- **FR-1 Discover.** Introspect the warehouse (`information_schema`-style) →
  tables, columns, types, sample values.
- **FR-2 Classify.** Each column → `direct` / `quasi` / `clinical` / `financial`
  / `non_sensitive` by name+type heuristics; free-text columns sampled and read
  by the **LLM** (JSON mode) for embedded PHI, with a deterministic regex+name
  fallback of identical shape.
- **FR-3 Policy-as-code.** A declarative spec (per class → masking function; per
  role → row predicate) compiled to Snowflake `CREATE MASKING POLICY` /
  `CREATE ROW ACCESS POLICY` / `ALTER TABLE … SET …` DDL **and** Terraform
  `snowflake_masking_policy` / `snowflake_row_access_policy` resources.
- **FR-4 Coverage gate.** Any sensitive column (direct/quasi) without a masking
  policy is a coverage gap; `gate()` returns pass/fail + exit code for CI.
- **FR-5 Re-identification risk.** k-anonymity over the quasi-identifier columns
  via SQL on the warehouse; a generalization sweep showing coarser → higher k.
- **FR-6 Controls.** Map findings to SOC 2 (CC6.1, CC6.6) + HIPAA (164.312(a),
  164.514); pass/fail rollup + a severity-weighted posture score/grade.
- **FR-7 Narrative.** LLM executive risk summary (security-as-enabler) with a
  deterministic offline template fallback.
- **FR-8 API + UI.** FastAPI (`/warehouse`, `/classify`, `/scan`, `/policy`,
  `/risk`, `/controls`, `/narrative`, `/gate`, `/evals`, `/llm`) + a console.
- **FR-9 Offline + safe.** Runs with zero keys (LLM falls back to deterministic);
  synthetic data only; no secrets.

## Architecture

```
warehouse.py (DuckDB, Snowflake-style DDL + introspection)
   └─ classify.py  (name/type heuristics + LLM free-text PHI)
scan.py: discover → classify → coverage → risk → controls → posture; gate()
   ├─ policy.py     (declarative spec → Snowflake DDL + Terraform; coverage())
   ├─ risk.py       (k-anonymity over quasi-identifiers via SQL)
   ├─ controls.py   (SOC 2 / HIPAA mapping + posture score/grade)
   └─ narrative.py  (LLM executive summary; deterministic fallback)
llm.py (paid → local → free → deterministic offline)
```

## Conventions

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio's CONV-1…5.
