# baseplate — development plan

A staged build; each stage is independently runnable and offline.

1. **Template + skeleton.** Copy `llm.py` verbatim; mirror field-vault's
   `pyproject.toml`, `run.sh`, `Dockerfile`, `.env.example`, `LICENSE`. Package
   `baseplate`, port 8024.
2. **Scaffolder core.** `templates.py` (deterministic paved-road file
   generators) + `scaffold.py` (`ServiceSpec`, the LLM extraction, the
   deterministic offline parser with negation handling).
3. **Example workload.** `ingest.py` — synthetic machine-readable rate file,
   row validation, data-quality pass-rate SLI.
4. **Catalog + SLOs.** `catalog.py` (services on the road) and `slo.py` (SLO
   view with the data-quality SLI plugged in, error budgets, burn-rate table).
5. **API + console.** `api.py` (`/health`, `/scaffold`, `/catalog`, `/ingest`,
   `/quality`, `/slo`, `/evals`, `/llm`) + `static/index.html`.
6. **Paved-road artifacts.** `deploy/terraform` (foundation + reusable `service`
   module), `deploy/k8s/base`, `deploy/argocd` (ApplicationSet),
   `deploy/github-actions` (golden CI). Docs: `platform.md`, `observability.md`.
7. **Eval + demo + tests.** `evaluate.py` (scaffolder over labeled specs: spec
   match + files present + k8s parses + invariants; data-quality SLI) →
   `eval-report.md`; `demo.py`; tests (`test_llm`, `test_scaffold`,
   `test_ingest`, `test_api`, opt-in `test_live_smoke`).

## Conventions

Offline-first, deterministic core, no secrets, synthetic data, ruff-clean,
company-neutral. No HIPAA claim. Same routing layer and run.sh shape as the rest
of the portfolio.
