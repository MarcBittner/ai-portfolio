# attack-surface

![attack-surface exposure report](docs/screenshot.png)

**[▶ Live demo](https://attack-surface.onrender.com)**

Attack-surface enumeration that doesn't stop at *"we found an exposure."* It
discovers an org's externally visible assets — subdomains from **Certificate
Transparency**, services and their fingerprints — turns each weakness into a
**finding** with a severity and a remediation, and maps that finding to the
**SOC 2 / ISO 27001 control** it affects. The output is governed, auditable
evidence: not a raw scanner dump, but the bridge from *we found it* to *here is
the control it touches and how we'll prove we handled it.*

## Architecture

Small, single-purpose modules; the data flows one direction through them.

| Module | Responsibility |
|---|---|
| `data.py` | Synthetic CT entries + per-host service fingerprints for the owned fixture domain `example-corp.test` (reserved test TLD; nothing touches a real network). |
| `ct.py` | Certificate-Transparency subdomain enumeration. Fixture mode replays the offline entries; live mode does an opt-in **passive** query of crt.sh (reads published certs). |
| `fingerprint.py` | 8 structure-driven checks over service flags → findings, each pre-mapped to controls with severity + remediation. |
| `controls.py` | SOC 2 (CC6.x/CC7.x) + ISO 27001:2022 (A.5/A.8) catalog, and the per-control roll-up to pass/fail + finding counts. |
| `scanner.py` | Orchestrates enumerate → fingerprint → map → severity-weighted posture score/grade. |
| `api.py` | FastAPI surface (`/scan`, `/controls`, `/health`) + the report UI. |
| `demo.py` | Offline CLI that prints the full fixture report (no network). |

```
                 fixture: data.py            live: crt.sh (passive)
                      │                            │
                      ▼                            ▼
  CT logs ──▶ subdomains ──▶ service fingerprint ──▶ findings
                                                  (severity + remediation
                                                   + control ids)
                                                       │
                          map each finding → SOC 2 / ISO 27001 control
                                                       │
                                                       ▼
                        per-control roll-up (pass/fail) ──▶ posture (score + grade)
```

**`GET /scan` (fixture path).** The default report runs entirely offline on the
owned synthetic domain. `scanner.scan_fixture()` enumerates the CT entries from
`data.py`, runs every service fingerprint through `fingerprint.derive()`, sorts
the findings by severity, rolls them up per control with `controls.evaluate()`,
and computes a severity-weighted posture. The response is one object —
`{assets, findings[], severity_counts, controls[], posture}` — where each finding
already carries the control ids it affects.

**Live / passive path.** `POST /scan {mode:"live", domain:"…"}` calls
`ct.enumerate_live()`, which queries the public crt.sh CT-log mirror for certs
covering the domain and returns the distinct subdomains seen. That is **passive
recon** — reading certificates someone already published — never a probe of the
hosts themselves. Live mode deliberately returns **no findings and no controls**;
it is subdomain discovery only.

**Fixture vs live (responsible defaults).** Full fingerprinting and the complete
control-mapped findings report run **only** on the owned fixture domain, where
every "service" is synthetic and authorized by construction. Against any real
domain the tool restricts itself to passive CT enumeration. The safe behavior is
the default, and the unsafe behavior (active probing of a third party) isn't
implemented at all.

## Findings → controls

A finding is the unit of governed evidence. Each one carries a stable `rule_id`,
a `severity`, the affected `asset` (`host:port`), a human `detail`, a
`remediation`, and the **control ids** it maps to — assembled at the moment the
check fires, so the mapping is never an afterthought. The eight checks:

| Check | Severity | Maps to |
|---|---|---|
| Expired TLS certificate | high | SOC2:CC6.7, ISO:A.8.24 |
| Database port exposed to the internet | critical | SOC2:CC6.6, ISO:A.8.20 |
| Unauthenticated admin interface | critical | SOC2:CC6.1, ISO:A.5.15 |
| Dangling DNS / takeover risk | high | SOC2:CC6.6, ISO:A.5.7 |
| Permissive CORS (wildcard) | medium | SOC2:CC6.1 |
| SMTP without STARTTLS | medium | SOC2:CC6.7, ISO:A.8.24 |
| Missing HSTS | low | SOC2:CC6.7, ISO:A.8.24 |
| Non-prod host on the public edge | medium | SOC2:CC6.6 |

`controls.evaluate()` inverts the relationship: it walks every control in the
catalog, collects the findings mapped to it, and assigns a status — **fail** if
any finding hits the control, **pass** otherwise — with a finding count for the
roll-up. The posture score is **severity-weighted**: each finding subtracts a
penalty (critical 10, high 6, medium 3, low 1) from 100, clamped at 0, and the
score maps to a letter grade (A ≥ 90 … F < 40).

On the fixture this produces a **posture of 57/100, grade D, with 7 of 8 controls
failing** — driven by an unauthenticated admin panel and an internet-exposed
database (critical), a dangling subdomain and an expired cert (high), permissive
CORS / plaintext SMTP / a non-prod host on the public edge (medium), and missing
HSTS (low). Only the detection control (CC7.1) has no finding mapped to it and so
passes.

## Design decisions

- **Findings as governed evidence (the GRC bridge).** A scanner result is noise
  until it's attached to a control with a status and a remediation. Mapping is the
  product, not a report add-on — it's what turns exposure into something an
  auditor can trace.
- **Pre-map each check to controls.** The control ids live next to the check that
  emits the finding, so a new check declares its own evidence value and can't drift
  away from its mapping.
- **Structure-driven checks.** Each check reads explicit fingerprint flags
  (`tls_expired`, `internet_exposed`, `auth_required`, `dangling`, …), so the logic
  is deterministic and reviewable rather than pattern-matching on banners.
- **Passive-only live mode.** The tool never actively scans hosts it doesn't own.
  Live mode reads public CT logs and stops there; active fingerprinting exists only
  for the owned synthetic fixture.
- **Severity-weighted posture.** One number that bumps with the *severity* of what's
  open, not the raw finding count, so two criticals outweigh a pile of low-severity
  noise.

**What changes for production:** authorized **active probing** within owned scopes
(real TLS/port/header inspection behind an explicit allowlist); **scan diffing /
drift** so new exposure since the last run is surfaced; **more frameworks**
(NIST CSF, CIS) with a crosswalk between them; and **evidence export** (per-control
finding bundles) for auditors.

## Invariants

- Every finding maps to **≥ 1 control** (no orphan findings).
- Every **failing control traces back to findings** (the roll-up is derived from
  findings, never asserted independently).
- **Live mode produces no active findings** — passive CT enumeration only.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, control + fixture-finding counts |
| GET | `/controls` | the SOC 2 / ISO 27001 control catalog |
| GET | `/scan` | the fixture exposure report (assets, findings, controls, posture) |
| POST | `/scan` | `{mode:"fixture"}` full report · `{mode:"live","domain":"…"}` passive CT recon |

`GET /scan` → `{ assets, findings[], severity_counts, controls[], posture }` —
each finding carries its mapped control ids and a remediation.

## Quickstart

```sh
cd projects/attack-surface
./run.sh setup
./run.sh demo            # offline: full control-mapped exposure report
./run.sh serve           # report UI at http://127.0.0.1:8015
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

> **Only scan domains you own or are explicitly authorized to assess.** The full
> findings report runs on the owned synthetic fixture (`example-corp.test`); live
> mode is passive CT-log recon only and never actively probes third-party hosts.

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio conventions (CONV-1…5).
