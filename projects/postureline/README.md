# postureline

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org)
[![Ruff](https://img.shields.io/badge/lint-ruff-261230.svg)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/api-FastAPI-009688.svg)](https://fastapi.tiangolo.com)

**[▶ Live demo](https://postureline.onrender.com)**

**One security-posture & compliance engine, two exposure surfaces.** `postureline`
runs the *same* pipeline — `scan → findings → control crosswalk → severity posture →
LLM narrative → remediation diff` — over two very different surfaces, which differ
only in what they scan:

- **warehouse** — data-access governance on a regulated analytics warehouse (DuckDB
  driven with **Snowflake-compatible SQL**): every column auto-classified by
  sensitivity (name/type heuristics + an **LLM** for PHI buried in free text),
  **masking-policy-as-code** generated as Snowflake DDL **and** Terraform,
  **k-anonymity** re-identification risk, and a **CI gate** that fails the build on
  any unmasked sensitive column.
- **exposure** — an **internet-intelligence inventory** (hosts, open services, parsed
  TLS certs, ASN/geo) run through structural exposure detectors (datastore open to
  `0.0.0.0/0`, exposed admin panel, expired/weak/deprecated TLS, end-of-life
  software).

Both reduce their native artifacts to **one canonical `Finding`**, which the shared
core maps to a **six-framework** control crosswalk (SOC 2 · HIPAA · ISO 27001 · NIST
800-53 · NIST 800-171 · CMMC), scores into a severity-weighted posture, narrates for
a board, and diffs before/after remediation. The point of the merge: the
compliance/posture engine is surface-agnostic, so a second exposure surface is *new
data*, not a new product.

> All data is **synthetic and clearly fictional**. The warehouse holds invented
> healthcare claims (no real PHI); the estate uses **reserved documentation IP
> ranges** (RFC 5737) and the reserved `.test` TLD. Nothing touches a real network or
> a real account. Runs fully offline (the LLM chain falls back to a deterministic
> generator); no secrets.

## Architecture

A shared core + a scanner registry. The scanner is the *only* surface-specific step;
everything after it is identical for both surfaces.

```
                       scanners/ (registry)
        warehouse_scan ─┐                 ┌─ exposure_scan
   DuckDB/Snowflake     │                 │   internet-intel inventory
   column governance    ▼                 ▼   (hosts/services/TLS/ASN)
                   ┌─────────────────────────┐
                   │  canonical Finding       │  {id, surface, severity,
                   │  (findings.py)           │   resource, evidence,
                   └────────────┬─────────────┘   control_ids, remediation}
                                ▼
            controls.py   six-framework crosswalk + per-control/framework roll-up
                                ▼
            posture.py    severity-weighted, saturating score + grade
                                │
              ┌─────────────────┼──────────────────────┐
              ▼                 ▼                       ▼
     remediation diff    narrative.py (LLM        evidence.py
     (posture over time)  board report, by         (per-control bundle
                          surface)                  + crosswalk, JSON/CSV)
```

| Module | Responsibility |
|---|---|
| `findings.py` | the canonical `Finding` both scanners emit + `ScanResult` (findings + per-surface extras) |
| `scanners/__init__.py` | registry `{warehouse, exposure}` → scanner callable |
| `scanners/warehouse.py` | warehouse governance → findings; keeps policy-as-code + k-anon + gate as extras |
| `scanners/exposure.py` | internet-intelligence inventory + fingerprinting → findings |
| `controls.py` | unified **six-framework** catalog + crosswalk; per-control + per-framework roll-up |
| `posture.py` | severity-weighted saturating score + grade; the remediation `diff` |
| `narrative.py` | LLM exec/board risk report over the computed posture, parameterized by surface |
| `evidence.py` | per-control evidence export (JSON/CSV) for either surface |
| `data.py` | synthetic data for BOTH surfaces (claims warehouse + exposure estate) |
| `classify.py` · `warehouse_policy.py` · `kanon.py` | warehouse-only: column classification, masking-policy-as-code, k-anonymity |
| `fingerprint.py` | exposure-only: structural detectors over host records |
| `scan.py` | orchestrate `run(surface, remediated)`; `diff(surface)`; `gate()` |
| `llm.py` | multi-provider router (paid → local → free → offline), stdlib HTTP (copied verbatim) |
| `evaluate.py` | reproducible eval over BOTH surfaces → `eval-report.md` |
| `api.py` | FastAPI service; `models.py` request models; `static/` two-tab console |

### The `GET /scan/{surface}` lifecycle

```
GET /scan/warehouse                         GET /scan/exposure
  └─ scanners.get("warehouse")                └─ scanners.get("exposure")
  └─ classify columns (LLM for free-text)     └─ inventory → fingerprint detectors
  └─ coverage + k-anon → Findings             └─ host records → Findings
                       │                                      │
                       └──────────────┬───────────────────────┘
                                      ▼   (identical from here)
        controls.evaluate(findings)        # six-framework crosswalk → pass/fail
        controls.framework_rollup(...)     # per-framework aggregation
        posture.posture(...)               # severity-weighted score + grade
        (?narrative=1) narrative.generate  # LLM board report over the computed posture
```

One response shape per surface: `{surface, findings[], severity_counts, controls[],
framework_rollup[], posture, extras}` — each finding already carrying the control ids
it breaks.

## Surfaces

| | **warehouse** | **exposure** |
|---|---|---|
| scans | DuckDB/Snowflake-compatible claims warehouse | internet-intelligence host inventory |
| detect | unmasked sensitive columns; re-identification risk | open datastores/admin panels; TLS & EOL-software exposure |
| findings | `UNMASKED_PHI`, `REID_RISK` | `DB_EXPOSED`, `ADMIN_EXPOSED`, `TLS_*`, `EOL_SOFTWARE` |
| extras | masking-policy-as-code (DDL + Terraform), k-anon sweep, CI gate | inventory summary, evidence export |
| keystone | a free-text `CLAIM_NOTE` the **LLM** catches but a column rule misses → the coverage gap that fails the gate | a MongoDB on `0.0.0.0/0` mapped to one control defensible to every auditor |

The free-text `CLAIM_NOTE` is the warehouse keystone: the scan classifies it
sensitive via the LLM, but the name-driven masking-policy set does **not** bind a
policy to it, so it surfaces as the coverage gap that **fails the gate** — the
discovered-but-unmasked PHI a column allowlist would have shipped to production.

## Policy-as-code

`GET /policy` (or `/policy/ddl`, `/policy/terraform` for paste-ready text) compiles
the warehouse scanner's declarative spec to the real governance artifacts. The
masking policy is role-aware (`CURRENT_ROLE()`) and data-type-matched per Snowflake's
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

`GET /privacy` adds the k-anonymity view: on quasi-identifiers `DOB·ZIP·GENDER` the
minimum **k = 1** (12/12 singletons), below the threshold k ≥ 2 — so the
de-identification control (`GV1.1`) fails until generalization (ZIP→3-digit,
DOB→birth year) clears it. The generalization sweep is the privacy/utility lever.

## Compliance crosswalk

A finding is the unit of governed evidence: a stable `id`, a `severity`, the affected
`resource`, machine-readable `evidence`, a `remediation`, and the **control ids** it
maps to — attached at detection, so the mapping is never an afterthought. `controls`
inverts that into per-control status (**fail** iff any finding maps) and aggregates it
per framework. Every control carries its **six-framework** crosswalk:

| SOC 2 | HIPAA | ISO 27001 | NIST 800-53 | NIST 800-171 | CMMC | covers |
|---|---|---|---|---|---|---|
| CC6.1 | 164.312(a)(1) | A.8.3 | AC-3 | 3.1.1 | AC.L2-3.1.1 | access & data masking |
| CC6.6 | 164.312(e)(1) | A.8.20 | SC-7 | 3.13.1 | SC.L2-3.13.1 | boundary protection |
| CC6.7 | 164.312(e)(2)(ii) | A.8.24 | SC-8 | 3.13.11 | SC.L2-3.13.11 | data-in-transit crypto |
| CC6.8 | 164.308(a)(5)(ii)(B) | A.8.8 | SI-2 | 3.14.1 | SI.L2-3.14.1 | supported software |
| CC7.1 | 164.308(a)(1)(ii)(A) | A.8.8 | RA-5 | 3.11.2 | RA.L2-3.11.2 | vuln/exposure detection |
| CC7.2 | 164.308(a)(1)(ii)(D) | A.8.16 | SI-4 | 3.14.6 | SI.L2-3.14.6 | external-exposure monitoring |
| GV1.1 | 164.514(b) | A.8.11 | SI-19 | 3.1.3 | AC.L2-3.1.3 | de-identification (k-anon) |

So one finding — a MongoDB on `27017` from `0.0.0.0/0`, *or* an unmasked PHI column —
maps to a control that is **simultaneously** a SOC 2 criterion, a HIPAA citation, an
ISO control, two NIST requirements, and a CMMC practice. One piece of evidence,
defensible to every auditor at once. `GET /controls?framework=` filters to one
framework's view; `GET /evidence?surface=&control=&format=csv` exports the per-control
bundle.

The posture score is **severity-weighted** (critical 10, high 6, medium 3, low 1) and
mapped to 0–100 through a **saturating** curve, `score = 100 / (1 + Σpenalty / 30)`
(perimeter's approach, now shared): a real estate carries enough exposure to drive a
linear `100 − Σpenalty` straight to zero, losing all signal; the saturating form stays
monotonic so fixing the top risks always moves the grade. On the fixtures the
**exposure** surface scores **25/100 (F)** and the **warehouse** surface **71/100 (C)**.

### Remediation diff

`GET /diff?surface=` runs the surface as-is and after a `--remediated` wave and reports
the lift — the "if we do X, our grade goes F → D" view:

| surface | before | after | what flips |
|---|---|---|---|
| exposure | 25/100 (F) | 59/100 (D) | +34; remediates CC6.1, CC6.6, CC6.8, CC7.1, CC7.2 |
| warehouse | 71/100 (C) | 100/100 (A) | +29; remediates CC6.1, GV1.1 |

## Routing

The LLM layer (`llm.py`) is the portfolio-standard chain, **byte-identical** to the
sibling demos (it was identical in both merged sources, so it is copied verbatim): a
provider is *available* only when its key is set (or, for Ollama, when a probe to
`/api/tags` succeeds), so the chain self-selects from the environment and `complete()`
returns the first success, recording which providers it fell through.

| mode | order |
|---|---|
| `auto` (default) | Anthropic → OpenAI → Ollama → OpenRouter → offline |
| `paid` | Anthropic → OpenAI → offline |
| `local` | Ollama → offline |
| `free` | OpenRouter → offline |
| `offline` | deterministic generator only |

`GET /llm` reports which providers are reachable and the active mode. The offline path
is always terminal, so the service never fails for lack of a key. The LLM is used only
for **free-text PHI classification** (warehouse) and the **board/exec narratives**;
everything trust-critical (policy, coverage, k-anon, fingerprint, posture, crosswalk)
is deterministic.

## Evals

`./run.sh eval` (or `GET /evals`) evaluates **both** surfaces and writes
`eval-report.md`. Deterministic, so the numbers reproduce exactly with zero keys.

- **warehouse** — column-classification precision/recall (recall is the safety
  metric: a missed sensitive column is unmasked PHI), masking-policy coverage,
  k-anonymity.
- **exposure** — fingerprint → control coverage; the remediation-diff posture delta.
- **cross-surface invariants** (measured facts, not claims):

| invariant | holds |
|---|---|
| every finding maps to ≥ 1 control across the six frameworks | ✓ |
| every failing control traces to ≥ 1 finding | ✓ |
| every mapped control id exists in the catalog | ✓ |
| per-framework roll-up matches the per-control status | ✓ |
| posture = 100 / (1 + Σ severity penalty / K) | ✓ |
| board report covers every critical (and high) finding (both surfaces) | ✓ |

## Code map

```
src/postureline/
  findings.py          canonical Finding both scanners emit + ScanResult
  scanners/
    __init__.py        registry {warehouse, exposure} → scanner callable
    warehouse.py       warehouse governance → findings; policy-as-code + k-anon + gate (extras)
    exposure.py        internet-intel inventory + fingerprinting → findings
  controls.py          unified six-framework catalog + crosswalk; per-control/framework roll-up
  posture.py           severity-weighted saturating score + grade; remediation diff()
  narrative.py         LLM exec/board report over the computed posture, by surface; offline template
  evidence.py          per-control evidence export (JSON/CSV), per surface
  data.py              synthetic data for BOTH surfaces (claims warehouse + exposure estate)
  classify.py          warehouse: column classification; LLM free-text PHI + regex fallback
  warehouse_policy.py  warehouse: declarative spec → Snowflake DDL + Terraform; coverage() gap
  kanon.py             warehouse: k-anonymity over quasi-identifiers (SQL) + generalization sweep
  fingerprint.py       exposure: structural detectors over host records
  scan.py              run(surface, remediated); diff(surface); gate()
  llm.py               multi-provider router (paid → local → free → offline), stdlib HTTP
  evaluate.py          ./run.sh eval → eval-report.md (both surfaces + invariants)
  api.py               FastAPI service; models.py request models; static/ two-tab console UI
  demo.py              offline CLI: runs BOTH surfaces end-to-end
tests/                 llm / findings / controls / warehouse / exposure / api + opt-in live smoke
```

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, surfaces, control + framework counts |
| GET | `/scan/{surface}` | full posture result per surface (`?remediated=`, `?narrative=1`) |
| GET | `/controls?surface=&framework=` | unified six-framework crosswalk; `?framework=` filters |
| GET | `/posture?surface=` | governed posture headline + framework view |
| GET | `/diff?surface=` | remediation delta — before/after, controls/frameworks flipped |
| GET·POST | `/report` | LLM board/exec report (`{surface, remediated, mode}`) |
| GET | `/evidence?surface=&control=&format=` | per-control evidence bundle (JSON/CSV) |
| GET | `/policy` · `/policy/ddl` · `/policy/terraform` | warehouse: Snowflake DDL + Terraform + coverage |
| GET | `/privacy` | warehouse: k-anonymity + generalization sweep |
| GET | `/gate?surface=` | CI gate (warehouse: unmasked column ⇒ fail; exposure: posture/critical) |
| GET | `/evals` | eval over BOTH surfaces + cross-surface invariants |
| GET | `/llm` | configured/reachable providers + active routing mode |

## Env

Runs fully offline with no `.env` (the LLM chain falls back to a deterministic
generator). Set any of these to route the LLM surfaces (free-text PHI classification +
the board narratives) to a real model; never commit real keys, and leave them unset on
a public host. See `.env.example`.

| var | purpose |
|---|---|
| `LLM_MODE` | `auto` (default) · `paid` · `local` · `free` · `offline` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | paid path (tried first in `auto`) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | paid path |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | local models, autodetected via `/api/tags` |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | free-tier models |

```sh
cd projects/postureline
./run.sh setup
./run.sh demo            # offline: BOTH surfaces end-to-end
./run.sh eval            # both surfaces + invariants → eval-report.md
./run.sh serve           # two-tab console at http://127.0.0.1:8025
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

## Deploy

Containerized (`Dockerfile`, non-root, `PORT` env, `/health` check) and deployed on
Render's free tier — the same image runs anywhere. **No provider keys are set on the
public host**, so the live demo runs the deterministic offline path; the LLM chain
activates wherever keys/Ollama are present. Free instances cold-start in ~30–50s.

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio conventions (CONV-1…5). Spec in `docs/spec/`.
