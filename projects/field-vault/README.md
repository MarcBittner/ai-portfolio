# field-vault

Field-level **de-identification + least-privilege access + a tamper-evident audit
trail** for regulated records — the data-handling discipline you need to run
analytics on sensitive data (medical claims here) without exposing identities.

Records are de-identified **at ingest**: direct identifiers (name, member id) are
**keyed-tokenized** (reversible only via a vault, under policy), quasi-identifiers
(dob, zip, dates) are **generalized** (one-way). Every field read is **policy-
checked and audited**; recovering an identity is a separate, stricter action
gated on role **and** purpose-of-use. Analytics — a **de-identified provider
outcome score** — runs entirely on the safe surface.

> Offline, deterministic, no secrets. All claims are synthetic and clearly
> fictional — no real PHI ever touches it. The audit log records *who/what/why/
> decision*, **never a field value**.

## The model

| Field class | Example | Treatment |
|---|---|---|
| **direct** | member name, member id | keyed token `tok_…` (reversible only via vault + policy) |
| **quasi** | dob, zip, service date | generalized (birth year, `941**`, year-month) |
| **clinical** | provider, dx/procedure, outcome | kept (the analytics surface) |
| **financial** | allowed amount | kept |

**Roles:** `analyst` (reads the de-identified surface, **cannot** re-identify) ·
`care_coordinator` (**may** re-identify, but only with a care purpose) ·
`auditor` (reads the audit trail, never the claims).

```
ingest → de-identify → store (de-identified)
read field ──▶ policy.decide(role, field, action, purpose) ──▶ audit.append ──▶ value | denial
                              (read_deid vs reidentify)        (hash-chained)
de-id provider score ── computed only from clinical/financial fields (no PHI)
```

## Quickstart

```sh
cd projects/field-vault
./run.sh setup
./run.sh demo            # offline: de-id + policy decisions + audit verify + score
./run.sh serve           # console at http://127.0.0.1:8012
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, record/role/audit counts |
| GET | `/roles` | role permissions (read classes, re-id, purposes) |
| GET | `/records` | the de-identified surface |
| GET | `/records/{id}` | one de-identified record |
| POST | `/access` | policy-checked, audited field read (`reidentify` to recover an identity) |
| GET | `/scores` | de-identified provider outcome score |
| GET | `/audit` · `/audit/verify` | the access trail + chain integrity |

`POST /access` body: `{ "role": "care_coordinator", "record_id": "rec-0001",
"field": "member_name", "purpose": "treatment", "reidentify": true }`.

Proprietary, offline-first, no secrets — conforms to the portfolio conventions
(CONV-1…5).
