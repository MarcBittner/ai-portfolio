# maskline

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org)
[![Ruff](https://img.shields.io/badge/lint-ruff-261230.svg)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/api-FastAPI-009688.svg)](https://fastapi.tiangolo.com)

**[▶ Live demo](https://maskline.onrender.com)**

Data-access governance + **masking-policy-as-code** for a regulated analytics
warehouse. maskline scans the warehouse (synthetic healthcare claims here),
auto-classifies every column by sensitivity, **generates column-masking +
row-access policy-as-code** (Snowflake DDL **and** Terraform), turns any sensitive
column that has no masking policy into a **CI gate failure**, scores
**re-identification (k-anonymity) risk**, and maps the whole posture to **SOC 2 /
HIPAA** controls with an LLM-written executive summary. It is security-as-enabler:
the same scan that produces the dashboard is the guardrail that blocks an unsafe
merge — a gate that runs in the pipeline, not a policy doc that rots.

Two places this earns its keep beyond a column-name allowlist:

- **PHI hides in free text.** A name, DOB, phone, email, or SSN buried in a
  `CLAIM_NOTE` is invisible to any column-name rule. maskline samples the column
  and an **LLM reads it** for embedded PHI; the deterministic offline detector
  (regex + name heuristics) is the fallback, so classification runs (and the eval
  reproduces) with zero keys. That discovered-but-unmasked column is exactly what
  the **coverage gate** catches.
- **Masking identifiers isn't de-identification.** A **k-anonymity** view shows
  that even with every direct identifier masked, rows are re-identifiable by
  *linkage* on quasi-identifiers — and that coarser generalization is the lever.

> All data is **synthetic and clearly fictional** — members, providers, names,
> codes, and amounts are invented for this portfolio; **no real PHI** ever touches
> it. The warehouse engine is **DuckDB driven with Snowflake-compatible SQL** so
> the demo runs offline with zero infrastructure; point the connector at a real
> **Snowflake** account in prod. The generated `MASKING POLICY` / `ROW ACCESS
> POLICY` DDL and Terraform `snowflake_*` resources target real Snowflake. No
> secrets; runs fully offline (the LLM chain falls back to a deterministic
> classifier).

## Architecture

A small pipeline. `warehouse.py` builds an in-memory DuckDB warehouse with
Snowflake-style DDL and `information_schema`-style introspection; `classify.py`
labels each column; `policy.py` compiles a declarative spec to Snowflake DDL +
Terraform and computes coverage; `risk.py` scores k-anonymity by SQL;
`controls.py` maps to SOC 2 / HIPAA; `scan.py` orchestrates the lot and exposes
the CI `gate()`.

| Module | Responsibility |
|---|---|
| `warehouse.py` | in-memory DuckDB warehouse, Snowflake-style DDL, synthetic claims (incl. free-text `claim_note`), `information_schema` introspection |
| `classify.py` | per-column class (direct/quasi/clinical/financial/non_sensitive) via name+type heuristics; **LLM** for free-text PHI + deterministic regex fallback |
| `policy.py` | declarative masking/row-access spec → `generate_snowflake_ddl()` + `generate_terraform()`; `coverage()` finds the gap |
| `risk.py` | k-anonymity over quasi-identifiers (SQL `GROUP BY`); generalization sweep (the privacy/utility lever) |
| `controls.py` | SOC 2 (CC6.1, CC6.6) + HIPAA (164.312(a), 164.514) mapping; severity-weighted posture score + grade |
| `narrative.py` | LLM executive risk summary (security-as-enabler); deterministic template fallback |
| `scan.py` | orchestrate discover→classify→coverage→risk→controls→posture; `gate()` for CI |
| `llm.py` | multi-provider routing (paid → local → free → deterministic offline), stdlib HTTP |
| `evaluate.py` | reproducible eval → `eval-report.md` (`./run.sh eval`) |
| `api.py` | FastAPI service (port 8020); `demo.py` offline walkthrough; `models.py` request models |

### Column sensitivity → treatment

| Class | Example columns | Treatment in the generated policy |
|---|---|---|
| **direct** | `member_name`, `ssn`, `email`, `phone`, `member_id`, free-text `claim_note` | `MASK_DIRECT_IDENTIFIER` → fully masked outside privileged roles |
| **quasi** | `dob`, `zip`, `gender`, `service_date` | `MASK_QUASI_IDENTIFIER` → generalized (digits redacted); raises k |
| **clinical** | `dx_code`, `procedure_code`, `outcome`, `specialty` | visible to analysts; the **row-access** policy scopes the cohort |
| **financial** | `allowed_amount`, `paid_amount` | visible to analysts; row-access scopes the cohort |
| **non_sensitive** | `claim_id`, `provider_id` | untouched |

### Request lifecycle of `GET /scan`

```
GET /scan
  └─ warehouse.schema()              # discover: tables → columns + types + samples
  └─ classify.classify_all()         # name/type heuristics; free-text → LLM (JSON)
  │      Anthropic/OpenAI → Ollama → OpenRouter → deterministic regex+name detector
  └─ policy.coverage(classified)     # which sensitive columns have NO masking policy
  └─ risk.k_anonymity() + sweep()    # re-identification risk via SQL GROUP BY
  └─ controls.evaluate(...)          # SOC 2 / HIPAA pass-fail + posture score/grade
  └─ scan.gate(coverage)             # CI pass/fail (uncovered sensitive col ⇒ fail)
  └─ narrative.summarize(...)        # (?narrative=1) LLM executive summary
```

The free-text `claim_note` is the keystone: the scan classifies it sensitive via
the LLM, but the name-driven masking-policy set does **not** bind a policy to it,
so it surfaces as the coverage gap that **fails the gate** — the discovered-but-
unmasked PHI a column allowlist would have shipped to production.

## Policy-as-code

`GET /policy` (or `/policy/ddl`, `/policy/terraform` for paste-ready text)
compiles the declarative spec to the real governance artifacts. The masking
policy is role-aware (`CURRENT_ROLE()`) and data-type-matched per Snowflake's
masking-policy signature rules.

**Snowflake DDL** (excerpt):

```sql
CREATE OR REPLACE MASKING POLICY MASK_DIRECT_IDENTIFIER
  AS (val VARCHAR) RETURNS VARCHAR ->
  CASE
    WHEN CURRENT_ROLE() IN ('PHI_STEWARD', 'COMPLIANCE_AUDITOR') THEN val
    ELSE '***MASKED***'
  END;

ALTER TABLE ANALYTICS.CLAIMS.MEMBERS
  MODIFY COLUMN SSN SET MASKING POLICY MASK_DIRECT_IDENTIFIER;

CREATE OR REPLACE ROW ACCESS POLICY RAP_CLAIMS_BY_ROLE
  AS (OUTCOME NUMBER) RETURNS BOOLEAN ->
  CASE
    WHEN CURRENT_ROLE() IN ('PHI_STEWARD', 'COMPLIANCE_AUDITOR') THEN TRUE
    WHEN CURRENT_ROLE() = 'CLAIMS_ANALYST' THEN OUTCOME IS NOT NULL
    ELSE FALSE
  END;
ALTER TABLE ANALYTICS.CLAIMS.CLAIMS ADD ROW ACCESS POLICY RAP_CLAIMS_BY_ROLE ON (OUTCOME);
```

**Terraform** (`Snowflake-Labs/snowflake` provider, excerpt):

```hcl
resource "snowflake_masking_policy" "mask_direct_identifier" {
  name             = "MASK_DIRECT_IDENTIFIER"
  database         = local.database
  schema           = local.schema
  argument { name = "VAL"  type = "VARCHAR" }
  return_data_type = "VARCHAR"
  body = <<-SQL
    CASE WHEN CURRENT_ROLE() IN (${join(', ', formatlist("'%s'", local.unmasked_roles))}) THEN VAL
         ELSE '***MASKED***' END
  SQL
  comment = "direct identifier — fully masked outside privileged roles"
}
```

## Re-identification risk (k-anonymity)

Masking direct identifiers is necessary but **not sufficient**. `GET /risk`
computes k-anonymity over the quasi-identifier columns by SQL `GROUP BY`: the
minimum **k** is the size of the smallest group sharing a quasi-identifier tuple;
`k = 1` means a row is unique and re-identifiable by *linkage* against an external
dataset even with every direct identifier masked. The sweep shows the lever —
coarsening or dropping quasi-identifiers raises k:

| generalization | k_min | singletons |
|---|---|---|
| DOB + ZIP5 + gender | 1 | 12 |
| DOB + ZIP3 + gender | 1 | 12 |
| birth-year + ZIP3 | 1 | 10 |
| birth-decade + gender | 1 | 1 |
| gender only | 5 | 0 |

The takeaway a column allowlist misses: generalization must be tuned to a target
k, trading analytic resolution for privacy. The HIPAA 164.514 control fails until
k clears the threshold.

## Routing

The LLM layer (`llm.py`) is the portfolio-standard chain, identical in shape to
the other demos: a provider is *available* only when its key is set (or, for
Ollama, when a probe to `/api/tags` succeeds), so the chain self-selects from the
environment and `complete()` returns the first success, recording which providers
it fell through.

| mode | order |
|---|---|
| `auto` (default) | Anthropic → OpenAI → Ollama → OpenRouter → offline |
| `paid` | Anthropic → OpenAI → offline |
| `local` | Ollama → offline |
| `free` | OpenRouter → offline |
| `offline` | deterministic classifier / template only |

`GET /llm` reports which providers are reachable and the active mode. The offline
path is always terminal, so the service never fails for lack of a key — it
degrades to deterministic, not to an error. The LLM is used for **free-text PHI
classification** and the **executive summary**; everything trust-critical (policy
generation, coverage, k-anonymity, the gate) is deterministic.

## Evals

`./run.sh eval` (or `GET /evals`) scores column-sensitivity classification over a
labeled column set and writes `eval-report.md`. Classification is scored on the
binary sensitive-vs-not decision; **recall is the safety metric** — a sensitive
column scored non-sensitive is an unmasked-PHI miss.

| metric | offline detector |
|---|---|
| precision | 1.0 |
| recall | 1.0 |
| F1 | 1.0 |
| exact-class accuracy | 1.0 |
| false negatives (missed sensitive) | 0 |

The eval also checks policy coverage and the invariant that **every sensitive
column maps to ≥ 1 SOC 2 / HIPAA control**, and emits the posture score — so the
governance posture is a reproducible number, not a claim. Set provider keys or
`LLM_MODE` to score a live model on free-text classification.

## Code map

```
src/maskline/
  warehouse.py   in-memory DuckDB, Snowflake-style DDL + introspection, synthetic claims
  classify.py    per-column class; LLM free-text PHI + deterministic regex fallback
  policy.py      declarative spec → Snowflake DDL + Terraform; coverage() gap
  risk.py        k-anonymity over quasi-identifiers (SQL) + generalization sweep
  controls.py    SOC 2 / HIPAA mapping + severity-weighted posture score/grade
  narrative.py   LLM executive risk summary + deterministic template fallback
  scan.py        orchestrate discover→classify→coverage→risk→controls; gate() for CI
  llm.py         multi-provider router (paid → local → free → offline), stdlib HTTP
  evaluate.py    ./run.sh eval → eval-report.md
  api.py         FastAPI service; models.py request models; static/ console UI
tests/           unit (llm, warehouse, classify, policy, controls, api) + live smoke
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, table/column/sensitive counts |
| GET | `/warehouse` | introspected schema: tables → columns + types + samples |
| GET | `/classify` | per-column classification (incl. free-text PHI) |
| GET | `/scan` | full governance result (`?narrative=1` for the LLM summary) |
| GET | `/policy` · `/policy/ddl` · `/policy/terraform` | generated Snowflake DDL + Terraform + coverage |
| GET | `/risk` | k-anonymity + generalization sweep |
| GET | `/controls` | SOC 2 / HIPAA pass-fail + posture score/grade |
| GET | `/narrative` | LLM executive risk summary |
| GET | `/gate` | CI pass/fail (uncovered sensitive column ⇒ exit 1) |
| GET | `/evals` | classification precision/recall + coverage + invariants |
| GET | `/llm` | configured/reachable providers + active routing mode |
| POST | `/admin/reset` | rebuild the warehouse (demo aid) |

## Env

Runs fully offline with no `.env` (the LLM chain falls back to a deterministic
classifier). Set any of these to route free-text PHI classification + the
executive summary to a real model; never commit real keys, and leave them unset
on a public host. See `.env.example`.

| var | purpose |
|---|---|
| `LLM_MODE` | `auto` (default) · `paid` · `local` · `free` · `offline` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | paid path (tried first in `auto`) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | paid path |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | local models, autodetected via `/api/tags` |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | free-tier models |
| `MASKLINE_WAREHOUSE` | `duckdb` (default) · `snowflake` (point at a real account) |

## Quickstart

```sh
cd projects/maskline
./run.sh setup
./run.sh demo            # offline: discover + classify + policy + gate + risk + posture
./run.sh eval            # classification precision/recall + coverage → eval-report.md
./run.sh serve           # console at http://127.0.0.1:8020
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

## Deploy

Containerized (`Dockerfile`, non-root, `PORT` env, `/health` check) and deployed
on Render's free tier — the same image runs anywhere. **No provider keys are set
on the public host**, so the live demo runs the deterministic offline path; the
LLM chain activates wherever keys/Ollama are present. Free instances cold-start in
~30–50s.

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio conventions (CONV-1…5). Spec in `docs/spec/`.
