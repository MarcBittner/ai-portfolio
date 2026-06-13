# field-vault

[![CI](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml/badge.svg)](https://github.com/MarcBittner/ai-portfolio/actions/workflows/projects-ci.yml)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org)
[![Ruff](https://img.shields.io/badge/lint-ruff-261230.svg)](https://github.com/astral-sh/ruff)
[![FastAPI](https://img.shields.io/badge/api-FastAPI-009688.svg)](https://fastapi.tiangolo.com)

![field-vault console](docs/screenshot.png)

**[▶ Live demo](https://field-vault.onrender.com)**

Field-level **de-identification + least-privilege access + a tamper-evident audit
trail** for regulated records. It is a reference for the data-handling discipline
that lets you run analytics on sensitive records (synthetic medical claims here)
without exposing identities: records are de-identified the moment they land,
every field read is policy-checked and logged, recovering an identity is a
separate and stricter action, and the analytics the business actually wants runs
entirely on the safe surface.

Two things structured de-identification alone can't do, and where this demo earns
its keep:

- **PHI hides in free text.** Column rules can't reach a name, DOB, or SSN buried
  in a clinical note. An **LLM reads the note and returns the PHI spans**, then
  deterministic code redacts them and the audit logs the scrub — the model does
  the fuzzy reading, trust-critical de-identification stays deterministic. The LLM
  routes **Anthropic/OpenAI → local Ollama → free (OpenRouter) → a deterministic
  detector**, so it runs (and the eval reproduces) with zero keys.
- **Tokenizing identifiers isn't de-identification.** A **k-anonymity** view shows
  that even with every direct identifier tokenized, rows are still re-identifiable
  by *linkage* on quasi-identifiers — and that coarser generalization is the lever
  that fixes it.

> All claims are **synthetic and clearly fictional** — members, providers, names,
> codes, and amounts are invented for this portfolio; **no real PHI** ever touches
> it. No secrets; runs fully offline (the LLM chain falls back to a deterministic
> detector). The audit log records *who/what/why/decision*, **never a field
> value**.

## Architecture

A small pipeline. `data.py` defines synthetic claims and the per-field
classification that drives everything downstream; `deid.py` turns a raw claim
into a de-identified record plus a vault entry; `store.py` is the only door to
the data and routes each access through `policy.py` and `audit.py`; `score.py`
computes analytics on the de-identified surface only.

| Module | Responsibility |
|---|---|
| `data.py` | 20 synthetic claims + `FIELD_CLASS` (each field → direct/quasi/clinical/financial) |
| `deid.py` | direct → keyed HMAC token, quasi → one-way generalization; `Vault` holds token→original |
| `policy.py` | least-privilege decision: role × field-class × action × purpose → `(allowed, reason)` |
| `audit.py` | append-only, hash-chained access log; `verify` + `demo_tamper`; value-free |
| `store.py` | ingest → de-identify → policy-gated, audited field reads + re-identification |
| `score.py` | de-identified provider outcome score from non-identifying fields only |
| `notes.py` | LLM-assisted PHI detection + redaction of free-text notes; precision/recall eval |
| `privacy.py` | k-anonymity over quasi-identifiers; generalization sweep (the privacy/utility lever) |
| `llm.py` | multi-provider routing (paid → local → free → deterministic offline) |
| `evaluate.py` | reproducible eval → `eval-report.md` (`./run.sh eval`) |
| `api.py` | FastAPI service (port 8012); `demo.py` offline walkthrough; `models.py` request models |

### Field classification → treatment

Classification is assigned once, in `FIELD_CLASS`, and decides both how a field is
stored and who may read or re-identify it.

| Class | Fields | Treatment at ingest |
|---|---|---|
| **direct** | `member_id`, `member_name` | keyed token `tok_…` = `HMAC-SHA256(key, value)[:12]`; stable for joins, reversible only via the vault under policy |
| **quasi** | `dob`, `zip`, `service_date` | one-way generalization: dob→birth year, zip→3-digit prefix (`941**`), date→year-month |
| **clinical** | `provider_id`, `dx_code`, `procedure_code`, `outcome` | kept as-is — the safe analytics surface |
| **financial** | `allowed_amount` | kept as-is |

### Flow

```
ingest:  claims() ──▶ Vault.deidentify(claim) ──▶ _records[rec-NNNN]
                        direct → tok_…   (original parked in the vault)
                        quasi  → generalized
                        clinical/financial → unchanged

read:    POST /access ──▶ store.access_field(role, rec, field, purpose, reidentify)
            │
            ├─ policy.decide(role, field, action, purpose) ─▶ (allowed, reason)
            │       action = reidentify if reidentify else read_deid
            ├─ audit.log.append({who, what, why, decision})  ─▶ hash-chained entry
            └─ allowed ?  value (deid surface | vault detokenize)  :  denial
```

### Walkthrough of a `POST /access`

The request body is `{role, record_id, field, purpose, reidentify}`.
`store.access_field` first resolves the record; an unknown id returns
`{allowed: false, status: 404}` **without** touching the policy or the log. The
action is derived from the boolean flag — `read_deid` when `reidentify` is false,
`reidentify` when true — and handed to `policy.decide`.

**`read_deid` path.** `decide` looks up the field's class and asks whether the
role's `read_classes` includes it. An `analyst` (all classes) reading `dx_code`
is allowed and gets the stored clinical value; reading `member_name` is *also*
allowed but returns the **token**, not the name — reading the de-identified form
is not re-identification. An `auditor` (empty `read_classes`) is denied any claim
field. Either way the decision is logged and the response carries the
`audit_seq`.

**`reidentify` path.** `decide` enforces three gates in order: the field must be a
`direct` identifier (re-identifying a `dx_code` is meaningless and denied), the
role must carry `may_reidentify`, and `purpose` must be in that role's permitted
set. A `care_coordinator` re-identifying `member_name` with
`purpose="treatment"` passes all three; the **same role with no purpose is
denied**, as is an `analyst` (cannot re-identify at all). On success the value is
recovered with `Vault.detokenize(token)` — the only place the original is read
back. Every attempt, allowed or denied, appends one audit entry first; the value
is fetched only after a positive decision.

## LLM-assisted PHI detection (free text)

Field classification de-identifies *structured columns*. But claims carry
free-text notes — `"Member Ada Quill (DOB 1972-03-14), reachable at
415-555-0107 or ada.quill@example.com"` — where PHI sits in prose that no column
rule sees. `POST /notes/detect` runs the note through the routing chain:

```
note ──▶ llm.complete(SYSTEM, note, json_mode)        # detect PHI spans
            Anthropic / OpenAI → Ollama → OpenRouter → deterministic detector
       ──▶ spans [{text, type ∈ NAME|DOB|DATE|PHONE|EMAIL|SSN|MRN|ADDRESS|ZIP}]
       ──▶ notes.redact(note, spans)                  # deterministic [TYPE] masking
       ──▶ audit.append({event: note_scrub, by_type, phi_found})  # value-free
```

The model only ever **reads** — it returns spans, never rewrites the note.
Redaction and the audit entry are deterministic, and the audit records *counts by
type*, never the PHI value. The offline detector (regex for email/phone/SSN/date
+ a name roster) is the last-resort fallback: it is exact on the synthetic set, so
the demo and the eval reproduce with zero keys, while the LLM path is what
generalizes to **unseen names and phrasings** in the wild, where no roster exists.

## Re-identification risk (k-anonymity)

Tokenizing direct identifiers is necessary but **not sufficient**. An attacker who
never sees a name can still single out an individual by *linking* quasi-identifiers
(birth year, ZIP prefix, service month) against an external dataset. `GET /privacy`
measures it: the minimum **k** is the size of the smallest group sharing a
quasi-identifier tuple; `k = 1` means a row is unique and re-identifiable by
linkage even though every direct identifier was tokenized.

On the de-identified surface here, the full quasi tuple yields **k = 1 (every row
a singleton)**. `GET /privacy/sweep` shows the lever — coarsening or dropping
quasi-identifiers raises k:

| generalization | k_min | singletons |
|---|---|---|
| dob + zip3 + service_month | 1 | 20 |
| dob + zip3 | 1 | 20 |
| birth-decade + zip3 | 3 | 0 |
| zip3 only | 20 | 0 |

The takeaway a column-by-column de-identifier misses: generalization must be tuned
to a target k, trading analytic resolution for privacy — it is not a property you
get for free by tokenizing names.

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
| `offline` | deterministic detector only |

`GET /llm` reports which providers are reachable and the active mode. The offline
detector is always terminal, so the service never fails for lack of a key — it
degrades to deterministic, not to an error.

## Evals

`./run.sh eval` (or `GET /evals`) scores PHI detection over the labeled note set
and writes `eval-report.md`. Detection is scored on exact `(value, type)` matches;
**recall is the safety metric** — a missed span is a leak.

| metric | offline detector |
|---|---|
| precision | 1.0 |
| recall | 1.0 |
| F1 | 1.0 |
| false negatives (leaks) | 0 |

The eval also emits the k-anonymity distribution and the generalization sweep, so
the privacy posture is a reproducible number, not a claim. Set provider keys or
`LLM_MODE` to score a live model on the same labeled set.

## Design decisions

- **De-identify at ingest.** `store.ingest()` runs every claim through
  `Vault.deidentify` before it is stored, so `_records` never holds a clear
  direct identifier. There is no "raw" table to leak; the cleartext exists only
  as vault entries reachable through the audited access layer.
- **Keyed tokenization for direct identifiers.** `HMAC-SHA256(key, value)` is
  deterministic, so the same member tokenizes identically across records and the
  de-identified data **still joins** — but the token is not invertible by
  computation. Recovery requires the vault, which lives behind policy + audit.
  The key is a de-identification key, not a secret credential: tokens are useless
  without the vault regardless of who holds the key.
- **Generalization is one-way.** Quasi-identifiers are coarsened (birth year,
  `941**`, year-month) with no reverse mapping. This shrinks re-identification
  risk and is deliberately *not* recoverable — there is nothing to gate because
  there is no original to return.
- **Read vs re-identify are distinct actions.** The policy models `read_deid` and
  `reidentify` separately, so "you may see this surface" and "you may recover the
  identity behind it" are independent grants. A role can read every class yet
  never recover a name.
- **Purpose-of-use on re-identification.** Re-identifying requires both a role
  that `may_reidentify` and a valid `purpose` for that role — encoding *why* the
  identity is needed, not just *who* is asking.
- **The audit never stores values.** Entries record role, record, field,
  field-class, action, purpose, and the allow/deny decision — never the field
  value. An access log that copied the data would become a second, less-guarded
  copy of exactly what it is supposed to protect.
- **Analytics on the safe surface only.** `score.provider_scores` consumes the
  de-identified records and touches only `provider_id`, `outcome`, and
  `allowed_amount`. The provider ranking the business wants is produced without
  any PHI and without a single re-identification.

**What changes for production.** The de-id key would be KMS-wrapped and rotated;
the audit chain would persist to a WORM store rather than memory; quasi
generalization would be tuned against a real **k-anonymity / l-diversity** target
instead of fixed truncation; and re-identification would run through a
**break-glass** workflow (time-boxed grants, approver, alerting) on top of the
purpose check.

## Data model & invariants

The de-identified record is the same shape as the claim with direct fields
replaced by tokens and quasi fields generalized; `record_id` (`rec-NNNN`) is
added. Three cardinal invariants hold by construction:

1. **The de-identified surface exposes no direct identifier in the clear.**
   Anything served from `_records` (records, scores, `read_deid`) shows tokens
   for direct fields — never names or member ids.
2. **Re-identification requires role *and* purpose.** A cleartext direct value is
   returned only via `reidentify`, only for a role with `may_reidentify`, and
   only for a purpose permitted to that role.
3. **The audit is value-free and tamper-evident.** Every access appends one
   hash-chained entry with no field value; any later edit breaks the chain and
   `verify()` reports the first broken `seq` (`demo_tamper` shows this live).

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, record/role/audit counts |
| GET | `/roles` | role permissions (read classes, re-id, purposes) |
| GET | `/records` · `/records/{id}` | the de-identified surface |
| POST | `/access` | policy-checked, audited field read (`reidentify` to recover an identity) |
| GET | `/scores` | de-identified provider outcome score |
| POST | `/notes/detect` | LLM-assisted PHI detection + redaction of a free-text note |
| GET | `/privacy` · `/privacy/sweep` | k-anonymity of the surface + the generalization lever |
| GET | `/evals` | PHI-detection precision/recall/F1 over the labeled set |
| GET | `/llm` | configured/reachable providers + active routing mode |
| GET | `/audit` · `/audit/verify` | the access trail + chain integrity |
| POST | `/audit/_demo_tamper` · `/admin/reset` | demo aids |

`POST /access` body: `{ "role": "care_coordinator", "record_id": "rec-0001",
"field": "member_name", "purpose": "treatment", "reidentify": true }`.
`POST /notes/detect` body: `{ "note": "<free text>" }` or `{ "record_id":
"rec-0004" }` (scrub a record's intake note); optional `"mode"` pins the tier.

## Code map

```
src/field_vault/
  data.py        synthetic claims + FIELD_CLASS; free-text notes with gold PHI labels
  deid.py        Vault: direct → HMAC token, quasi → one-way generalization
  policy.py      role × field-class × action × purpose → (allowed, reason)
  audit.py       append-only hash-chained log; verify() + demo_tamper()
  store.py       the access layer: ingest → de-id → policy-gated, audited reads
  score.py       de-identified provider outcome score
  notes.py       LLM PHI detection + deterministic redaction + precision/recall eval
  privacy.py     k-anonymity + generalization sweep
  llm.py         multi-provider router (paid → local → free → offline), stdlib HTTP
  evaluate.py    ./run.sh eval → eval-report.md
  api.py         FastAPI service; models.py request models; static/ console UI
tests/           unit (deid, policy, audit, store, notes, privacy, llm, api) + live smoke
```

## Env

Runs fully offline with no `.env` (the LLM chain falls back to a deterministic
detector). Set any of these to route PHI detection to a real model; never commit
real keys, and leave them unset on a public host. See `.env.example`.

| var | purpose |
|---|---|
| `LLM_MODE` | `auto` (default) · `paid` · `local` · `free` · `offline` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | paid path (tried first in `auto`) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | paid path |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | local models, autodetected via `/api/tags` |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | free-tier models |
| `FIELD_VAULT_TOKEN_KEY` | HMAC key for direct-identifier tokenization (not a credential) |

## Quickstart

```sh
cd projects/field-vault
./run.sh setup
./run.sh demo            # offline: de-id + policy + audit + PHI scrub + k-anonymity
./run.sh eval            # PHI precision/recall + re-id risk → eval-report.md
./run.sh serve           # console at http://127.0.0.1:8012
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

## Deploy

Containerized (`Dockerfile`, non-root, `PORT` env, `/health` check) and deployed
on Render's free tier — same image runs anywhere. **No provider keys are set on
the public host**, so the live demo runs the deterministic offline path; the LLM
chain activates wherever keys/Ollama are present. Free instances cold-start in
~30–50s.

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio conventions (CONV-1…5). Spec in `docs/spec/`.
