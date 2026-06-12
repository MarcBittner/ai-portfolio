# attack-surface — Specification

## Overview

Attack-surface enumeration that produces a **control-mapped exposure report**:
discover subdomains (Certificate Transparency) and services, fingerprint them into
findings, and map each finding to SOC 2 / ISO 27001 controls with a status,
remediation, and posture score — findings as governed evidence. Fixture mode
(offline, full report on an owned synthetic domain) is the default; live mode does
passive CT-log recon only.

## Functional requirements

- **FR-1 CT enumeration.** Discover subdomains from Certificate Transparency —
  fixture entries offline; opt-in live query of crt.sh (passive).
- **FR-2 Service fingerprint → findings.** Inspect discovered service flags and
  emit findings (severity, detail, remediation): expired TLS, exposed DB, admin
  without auth, dangling/takeover, permissive CORS, plaintext SMTP, missing HSTS,
  non-prod exposed.
- **FR-3 Control mapping.** Each finding is pre-mapped to SOC 2 (CC6.x/CC7.x) +
  ISO 27001:2022 (A.5/A.8) controls.
- **FR-4 Control coverage.** Roll findings up per control → pass/fail + count.
- **FR-5 Posture.** Severity-weighted score + letter grade + controls-failing.
- **FR-6 Responsible defaults.** Full findings only on the owned fixture; live
  mode is passive CT recon, never active scanning of third-party hosts.
- **FR-7 API + UI.** FastAPI (`/scan`, `/controls`, `/health`) + an exposure-report
  UI (posture, severity, findings→controls, control coverage).
- **FR-8 Offline + safe.** Default mode needs no network; no secrets; synthetic data.

## Architecture

```
data.py (synthetic CT entries + service fingerprints)
ct.py (CT enumeration: fixture | live crt.sh passive)
fingerprint.py (service flags → findings, each pre-mapped to controls)
controls.py (SOC 2 / ISO catalog + per-control roll-up)
scanner.py (enumerate → fingerprint → map → posture)
```

## Conventions

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio's CONV-1…5. Only scan domains you own/are authorized to assess.
