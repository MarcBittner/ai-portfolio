# field-vault — Development Plan

**Legend:** `[x]` complete · `[>]` in progress · `[ ]` pending

## Phase 0 — MVP (v0.1.0) ✅

- [x] Scaffold (pyproject, run.sh w/ smoke, Dockerfile, LICENSE)
- [x] Synthetic claims + field classification (direct/quasi/clinical/financial)
- [x] De-identification: keyed tokenization (reversible via vault) + one-way
      generalization
- [x] Least-privilege field access policy (role × class × action × purpose)
- [x] Tamper-evident, hash-chained access audit (verify + demo-tamper)
- [x] Access layer (ingest → policy-gated, audited field reads + re-identification)
- [x] De-identified provider outcome score (no PHI)
- [x] FastAPI + console UI (de-identified surface, access decision, score, audit)
- [x] Tests: deid / policy / audit / store / api + local+remote smoke
- [x] ruff clean, `./run.sh demo` offline, smoke green

## Phase 1 — PHI in free text + privacy + polish (v0.2.0) ✅

- [x] LLM PHI-span detection in clinical notes (`/notes/detect`); deterministic
      redaction + value-free audit entry (model reads, code decides)
- [x] Multi-provider routing: paid → local Ollama → free → deterministic offline,
      with browser→host Ollama so the cloud demo runs a real local model
- [x] Detection eval (`/evals`, `./run.sh eval`): precision/recall/F1; recall = leak metric
- [x] k-anonymity view (`/privacy`, `/privacy/sweep`): k_min, singletons, generalization sweep
- [x] Console polish: guided demo path, real dark/light theme, settings (role/purpose,
      theme, routing mode), served-by indicator, help/About, project launcher
- [x] Engine diagnostics: resolved provider/model/latency + active chain + a
      cross-mode benchmark (offline/paid/free server-side; local browser→host),
      benchmark runs pass `audit_log=false` so they never touch the chain
- [x] Deployed live on Render (free); added to the portfolio catalog

## Roadmap

- [ ] Persisted vault + audit (KMS-wrapped keys, WORM store)
- [ ] l-diversity / t-closeness in addition to k-anonymity
- [ ] Break-glass access with mandatory justification + alerting
- [ ] Per-field encryption-at-rest + key rotation
- [ ] Crosswalk controls to SOC 2 / ISO 27001 / NIST (de-id + audit + least-privilege)
