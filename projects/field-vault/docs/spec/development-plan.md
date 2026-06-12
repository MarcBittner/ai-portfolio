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

## Roadmap

- [ ] Persisted vault + audit (KMS-wrapped keys, WORM store)
- [ ] k-anonymity / l-diversity check on the de-identified surface
- [ ] Break-glass access with mandatory justification + alerting
- [ ] Per-field encryption-at-rest + key rotation
- [ ] Deploy live on Render (free) + add to the portfolio "Live demos" table
