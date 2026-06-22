# rate-atlas — Development Plan

**Legend:** `[x]` complete · `[>]` in progress · `[ ]` pending

## Phase 0 — Normalization MVP (v0.1.0) ✅

- [x] Scaffold (pyproject, run.sh w/ smoke, Dockerfile, LICENSE)
- [x] 3 synthetic MRFs in 3 shapes (CMS nested JSON / flat JSON / pipe CSV)
- [x] Schema-detecting normalizer → canonical model (one adapter per shape)
- [x] SQLite store (load + `idx_code`) with the `compare` query + stats
- [x] Per-code rate-outlier detection (z-score) on the canonical surface
- [x] FastAPI (`/sources`, `/procedures`, `/compare/{code}`, `/outliers`, `/search`)
      + comparison UI with spread visualization
- [x] Tests: normalize / store / outliers / api + local+remote smoke
- [x] ruff clean, `./run.sh demo` offline, smoke green

## Phase 1 — LLM-assisted ingest + routing ✅

- [x] `assist.py`: column → canonical crosswalk for **unknown** file shapes
      (structural sniff → propose mapping → deterministic apply → ingest)
- [x] `llm.py`: portfolio-standard router — paid → local (Ollama) → free →
      deterministic offline matcher; provider self-selects from the environment
- [x] `POST /normalize/assist` (+ `ingest` flag), `GET /evals`, `GET /llm`
- [x] Column-mapping precision/recall eval → `eval-report.md` (`./run.sh eval`)
- [x] Tests: assist (offline matcher, specificity, ingest, eval) + llm

## Phase 2 — Demo polish (interview bar) ✅

- [x] **Guided demo path** — a numbered top strip + step badges so a first-time
      visitor has an obvious flow (compare → outliers → assisted ingest → diagnostics)
- [x] **Dark / light theme** — no-flash bootstrap, persisted, system-aware, segmented
      control in Settings, both palettes polished
- [x] **Settings drawer** — outlier threshold, theme, routing mode, model override,
      live provider-status rows, and the resolved fallback chain
- [x] **Browser→host Ollama bridge** — JS client mirrors `assist.py`'s prompt + parsing
      so the cloud demo can map columns on the visitor's local model (`client_mapping`)
- [x] **"Served by" indicator** — the assist panel badge names the provider that ran
      the last mapping (honest provider labels)
- [x] **Engine diagnostics view** — resolved provider/model/latency/cost, active routing
      chain, and a **benchmark across every routing mode** (offline/paid/free server-side;
      local exercised in-browser via the bridge)
- [x] **About** — grouped stack (core engine · AI/LLM · platform envelope · hosting/CI)
      + design principles + how the LLM is used, in the Help drawer
- [x] Docs refresh: `spec.md`, this plan, and the root `README.md`
- [x] Live on Render (free); `./run.sh smoke --url <deploy>` green

## Roadmap

- [ ] Swap SQLite → Postgres (same schema/queries) on the Terraform/EKS platform path
- [ ] More MRF shapes (XML, tall CSV, gzip/streaming for large files)
- [ ] Code crosswalks (CPT ↔ HCPCS ↔ DRG) for apples-to-apples comparison
- [ ] Rate trend tracking across file versions (diff over time)
- [ ] Persist a real request-trace/event log for Diagnostics (today: live per-run telemetry)
```
