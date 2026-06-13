# maskline — Development Plan

**Legend:** `[x]` complete · `[>]` in progress · `[ ]` pending

## Phase 0 — MVP (v0.1.0) ✅

- [x] Scaffold (pyproject, run.sh w/ smoke + eval, Dockerfile, LICENSE, llm.py)
- [x] In-memory DuckDB warehouse with Snowflake-style DDL + synthetic claims
      (members / providers / claims, incl. free-text `claim_note` with PHI)
- [x] Column classification (heuristics + LLM for free-text PHI; offline fallback)
- [x] Masking + row-access policy-as-code → Snowflake DDL + Terraform
- [x] Coverage gap detection + CI gate (unmasked sensitive column ⇒ fail)
- [x] Re-identification risk: k-anonymity + generalization sweep (SQL)
- [x] SOC 2 / HIPAA control mapping + severity-weighted posture score/grade
- [x] LLM executive risk summary (deterministic offline template)
- [x] FastAPI + console UI (sensitive columns, policy-as-code, gate, risk,
      posture, narrative)
- [x] Eval (classification precision/recall + coverage + invariants) → report
- [x] Tests: llm / warehouse / classify / policy / controls / api + live smoke
- [x] ruff clean, `./run.sh demo` offline, eval reproducible

## Roadmap

- [ ] Snowflake connector parity (run the same scan against a live account)
- [ ] Tag-based masking policies + object tagging lineage
- [ ] l-diversity / t-closeness beyond k-anonymity
- [ ] Drift detection: re-scan on schema change, diff the policy plan
- [ ] Deploy live on Render (free) + add to the portfolio "Live demos" table
