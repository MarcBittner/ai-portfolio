# perimeter — Development Plan

**Legend:** `[x]` complete · `[>]` in progress · `[ ]` pending

## Phase 0 — MVP (v0.1.0) ✅

- [x] Scaffold (pyproject, run.sh w/ smoke + eval, Dockerfile, LICENSE, .env.example)
- [x] Synthetic internet-intelligence inventory (hosts/services/TLS/ASN, RFC 5737 IPs)
- [x] Structural detectors → findings (datastore/admin exposure, TLS, EOL software)
- [x] 5-framework control catalog + crosswalk (SOC 2 / ISO / NIST 800-53 / 800-171 / CMMC)
- [x] Per-control + per-framework roll-up
- [x] Severity-weighted saturating posture + grade; remediation diff (posture over time)
- [x] LLM board/exec risk report (posture, top risks, remediation, residual) + offline template
- [x] Auditor evidence export (per-control bundle + crosswalk, JSON/CSV)
- [x] CI gate(); FastAPI surface + GRC console UI
- [x] Tests: fingerprint / risk / controls / api / llm + opt-in live smoke
- [x] Reproducible eval → eval-report.md
- [x] ruff clean, `./run.sh demo` offline, smoke green

## Roadmap

- [ ] Ingest a real internet-scan export (read a platform's host JSON in-place)
- [ ] Exposure drift over time (diff successive scans → newly-introduced exposure)
- [ ] More frameworks (NIST CSF, CIS, PCI-DSS) with a cross-framework crosswalk view
- [ ] Ticket creation per finding + SLA tracking against severity
- [ ] Deploy live on Render (free) + add to the portfolio "Live demos" table
