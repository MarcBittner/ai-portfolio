# promptguard — Development Plan

**Legend:** `[x]` done · `[ ]` pending

## Phase 0: Core ✅
- [x] `rules.py` — ~18 rules across injection/jailbreak/exfiltration/secret/pii
      with category, severity, direction, and a redact flag
- [x] `scan.py` — direction-scoped scanning, findings with spans, masked
      snippets for secret/PII, verdict (allow/flag/block) + risk score

## Phase 1: Service + UI ✅
- [x] FastAPI `api.py` — `/scan`, `/rules`, `/health`; serves the UI at `/`;
      response never contains a detected secret value
- [x] Static single-page UI — paste text, pick direction, verdict badge +
      highlighted findings by category + detections table (no build step)
- [x] `Makefile` (setup/test/lint/serve/demo), `pyproject.toml`, MIT LICENSE,
      README, this spec

## Phase 2: Tests ✅
- [x] `test_scan.py` — injection/jailbreak block, benign allow, secret/PII
      detection + non-leakage, direction scoping, spans
- [x] `test_api.py` — endpoints, verdicts, secret-not-echoed, 422, UI served
      (15 tests, ruff clean; secret fixtures split so none sit in source)

## Roadmap
- [ ] Classifier augmentation (semantic injection, toxicity) behind the finding
      contract (opt-in; breaks the offline guarantee)
- [ ] Allow/deny lists and per-deployment severity tuning via config
- [ ] More secret providers + entropy gating to cut false positives
- [ ] Streaming/output-token scanning for live response filtering
- [ ] Containerfile + Argo manifest (mirror pii-redactor) for a live demo

---

**Status:** v0.1.0 — complete and tested; not yet deployed.
