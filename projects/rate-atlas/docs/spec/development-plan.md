# rate-atlas — Development Plan

**Legend:** `[x]` complete · `[>]` in progress · `[ ]` pending

## Phase 0 — MVP (v0.1.0) ✅

- [x] Scaffold (pyproject, run.sh w/ smoke, Dockerfile, LICENSE)
- [x] 3 synthetic MRFs in 3 shapes (CMS nested JSON / flat JSON / pipe CSV)
- [x] Schema-detecting normalizer → canonical model (adapter per shape)
- [x] SQLite store (load + index) with the compare query + stats
- [x] Per-code rate-outlier detection (z-score)
- [x] FastAPI (`/sources`, `/procedures`, `/compare/{code}`, `/outliers`,
      `/search`) + comparison UI with spread visualization
- [x] Tests: normalize / store / outliers / api + local+remote smoke
- [x] ruff clean, `./run.sh demo` offline, smoke green

## Roadmap

- [ ] Swap SQLite → Postgres (same schema/queries) + Terraform/EKS platform path
- [ ] More MRF shapes (XML, tall CSV, gzip/streaming for large files)
- [ ] Code crosswalks (CPT ↔ HCPCS ↔ DRG) for apples-to-apples comparison
- [ ] Rate trend tracking across file versions (diff over time)
- [ ] Deploy live on Render (free) + add to the portfolio "Live demos" table
