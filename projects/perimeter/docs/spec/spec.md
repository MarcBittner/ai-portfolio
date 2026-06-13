# perimeter — Specification

## Overview

`perimeter` ingests **internet-intelligence host records** (the shape an
internet-wide scan platform emits: hosts, open services with port/protocol/software/
version, parsed TLS certificates, ASN/geo) and produces a **governed,
multi-framework GRC posture**: each exposure becomes a finding, every finding maps to
a control crosswalked across SOC 2 / ISO 27001 / NIST 800-53 / NIST 800-171 / CMMC,
and the roll-up yields a severity-weighted posture, a board report, a remediation
diff, and an auditor evidence export. Runs fully offline on a synthetic estate.

## Functional requirements

- **FR-1 Inventory ingest.** Model internet-intelligence host records — IP (RFC
  5737 reserved), ASN/geo, open services (port, transport, protocol, software +
  version), and parsed TLS certificate metadata (issuer, expiry, key type/size,
  signature algorithm, TLS version).
- **FR-2 Structural detectors → findings.** Inspect the records and emit findings
  with severity, evidence, and remediation: internet-open datastore, exposed admin
  panel, expired / expiring / weak-key / weak-signature / self-signed / deprecated
  TLS, end-of-life software.
- **FR-3 Multi-framework control mapping.** Each finding is pre-mapped to a control
  that crosswalks SOC 2 (CC6.x/CC7.x), ISO 27001:2022, NIST 800-53, NIST 800-171,
  and CMMC L2.
- **FR-4 Roll-up.** Roll findings up per control (pass/fail + count) and aggregate to
  a per-framework summary.
- **FR-5 Posture.** Severity-weighted, saturating 0–100 score + letter grade +
  controls/frameworks failing.
- **FR-6 Posture over time.** A remediated 'after' state + a before/after diff that
  reports the lift and which controls/frameworks flip fail → pass.
- **FR-7 Board reporting.** An LLM board/exec risk report (posture, top risks,
  what remediation buys, residual risk) over the *computed* posture; deterministic
  offline template; never re-derives findings/scores.
- **FR-8 Evidence export.** Per-control finding bundle + crosswalk as JSON/CSV.
- **FR-9 API + UI.** FastAPI (`/posture`, `/exposures`, `/controls`, `/diff`,
  `/report`, `/evidence`, `/gate`, `/evals`, `/llm`, `/health`) + a GRC console.
- **FR-10 CI gate.** `gate()` fails the build below a posture threshold or on any
  open critical exposure.
- **FR-11 Offline + safe.** Default mode needs no network; no secrets; synthetic
  data only (RFC 5737 IPs, `.test` names).

## Architecture

```
data.py        (synthetic internet-intelligence inventory + remediated state)
fingerprint.py (structural detectors over host records → findings pre-mapped to controls)
controls.py    (5-framework catalog + crosswalk; per-control + per-framework roll-up)
risk.py        (severity-weighted saturating posture + grade; diff)
scan.py        (inventory → fingerprint → controls → framework roll-up → posture; gate)
narrative.py   (LLM board/exec risk report over the posture)
evidence.py    (auditor evidence export — per-control bundle + crosswalk)
```

## Conventions

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio's CONV-1…5. Company-neutral by design: nothing names a vendor.
