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
- [x] `Makefile` (setup/test/lint/serve/demo), `pyproject.toml`, proprietary LICENSE,
      README, this spec

## Phase 2: Tests ✅
- [x] `test_scan.py` — injection/jailbreak block, benign allow, secret/PII
      detection + non-leakage, direction scoping, spans
- [x] `test_api.py` — endpoints, verdicts, secret-not-echoed, 422, UI served
      (15 tests, ruff clean; secret fixtures split so none sit in source)


## Shipped since v0.1.0 ✅

- [x] Multi-provider LLM routing — vendored stdlib router
      (`ollama → openrouter → openai → mock`, deterministic terminal fallback)
- [x] LLM semantic injection classifier folded into the verdict
- [x] In-UI routing config + `GET /providers`; `run.sh` replaces `make`
      (deps/version checks, `--flag` options, `doctor`); CI matrix + README badges

## Toward v0.2.0

- [ ] Allow/deny lists + per-deployment severity tuning via config
- [ ] Entropy-gated secret detection to cut false positives
- [ ] Streaming/output-token scanning for live response filtering
- [x] Containerize + deploy to Argo (Dockerfile + `deploy/k8s` + `deploy/argocd`) ✅ deployed

---

**Status:** v0.1.x — LLM routing + run.sh + CI shipped; v0.2.0 planned.
