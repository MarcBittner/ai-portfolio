# attack-surface — Development Plan

**Legend:** `[x]` complete · `[>]` in progress · `[ ]` pending

## Phase 0 — MVP (v0.1.0) ✅

- [x] Scaffold (pyproject, run.sh w/ smoke, Dockerfile, LICENSE)
- [x] Synthetic CT entries + service fingerprints (owned fixture domain)
- [x] CT enumeration (fixture + opt-in live crt.sh passive)
- [x] Service-fingerprint → findings checks (8 exposure classes, with remediation)
- [x] SOC 2 / ISO 27001 control catalog + per-control roll-up
- [x] Scanner: enumerate → fingerprint → map → severity-weighted posture grade
- [x] FastAPI (`/scan`, `/controls`, `/health`) + exposure-report UI
- [x] Tests: fingerprint / controls / scanner / api + local+remote smoke
- [x] ruff clean, `./run.sh demo` offline, smoke green

## Roadmap

- [ ] Active (authorized) service probing in fixture-equivalent owned scopes
- [ ] Scan diffing over time (drift = newly-introduced exposure)
- [ ] More frameworks (NIST 800-53, CIS) + cross-framework control crosswalk
- [ ] Evidence export (CSV/PDF) for an auditor + ticket creation per finding
- [ ] Deploy live on Render (free) + add to the portfolio "Live demos" table
