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

---

## Code review backlog (from `/docs/code-review/attack-surface.md`, 2026-06-18) — NOT YET DONE

Grade **B+**. Prioritized fixes; full detail + `file:line` in the review.

- [ ] **HIGH — land the live-findings UI.** Backend `scanner.scan_live` now returns control-mapped findings/controls/posture, but the console `renderLive()` (`src/attack_surface/static/index.html` ~610–629) renders only subdomains and hard-codes "no findings"; the Settings note, Help text, README, and `spec.md` also still say live mode has no findings. Render the live findings + control crosswalk + posture, and fix the stale copy. (The live-domain example demo is invisible in the browser until this lands.)
- [ ] **MED — look-alike domain match.** `ct.py` `endswith(domain)` accepts e.g. `evilexample.com` for `example.com`; use `endswith("." + domain)` (and an exact-apex case), matching `fingerprint.derive_passive`.
- [ ] **MED — validate the live `domain` input** (`models.py` → CT URL interpolation): restrict to a hostname pattern before building the certspotter/crt.sh URL.
- [ ] **LOW — misleading error label** in `scanner.py` ("crt.sh error:") now that certspotter is the primary source; make the message source-agnostic.
- [ ] **LOW — stale test mock**: the `enumerate_live` mock signature in `tests/` references a removed `retries` param; align with the current signature.
