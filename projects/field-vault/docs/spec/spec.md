# field-vault — Specification

## Overview

A regulated-data handling reference: ingest sensitive records (synthetic medical
claims), de-identify them field-by-field, serve **least-privilege, audited** field
access, recover identities only under role + purpose-of-use, and compute analytics
(a provider outcome score) entirely on the de-identified surface. Offline,
deterministic, no real PHI.

## Functional requirements

- **FR-1 De-identification at ingest.** Direct identifiers → keyed tokenization
  (HMAC; stable so de-identified data still joins; reversible only via the vault).
  Quasi-identifiers → one-way generalization. Clinical/financial → kept.
- **FR-2 Least-privilege access.** A role may read fields by classification;
  reading the de-identified form and re-identifying are distinct actions.
- **FR-3 Purpose-of-use.** Re-identifying a direct identifier requires a role
  permitted to re-identify AND a valid purpose; otherwise denied.
- **FR-4 Tamper-evident audit.** Every access (allowed or denied) appends to a
  hash-chained log storing who/what/why/decision — never the value; `verify`
  reports the first broken entry.
- **FR-5 Identities stay in the vault.** Originals are reachable only through the
  audited, policy-gated access layer.
- **FR-6 De-identified analytics.** A provider outcome score computed only from
  non-identifying fields — analytics works without touching PHI.
- **FR-7 API + UI.** FastAPI (`/records`, `/access`, `/scores`, `/roles`,
  `/audit[/verify]`) + a console showing the de-identified surface, the access
  decision, the score, and the audit chain.
- **FR-8 Offline + safe.** No model, no network, no secrets; synthetic data only.

## Architecture

```
data.py (synthetic claims + FIELD_CLASS)
   └─ deid.py  (keyed tokenization + generalization + vault)
store.py: ingest → de-identify → access_field(role, rec, field, purpose, reidentify)
   ├─ policy.py  (role × class × action × purpose → allow/deny)
   ├─ audit.py   (hash-chained access log + verify)
   └─ score.py   (de-identified provider outcome score)
```

## Conventions

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio's CONV-1…5.
