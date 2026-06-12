# rate-atlas — Specification

## Overview

A price-transparency data pipeline: ingest hospital machine-readable files (MRFs)
in inconsistent shapes, normalize them to one canonical model in SQLite, and
compare a procedure's negotiated rate across payers/hospitals with outlier
detection. Offline and deterministic; SQLite stands in for Postgres.

## Functional requirements

- **FR-1 Multi-shape ingest.** Detect and parse at least three MRF shapes
  (CMS-style nested JSON, flat JSON array, pipe CSV) by structure, not config.
- **FR-2 Canonical model.** Map every shape to
  `{hospital, code, code_type, description, payer, plan, rate}`; adding a shape is
  one adapter.
- **FR-3 SQL store.** Load canonical rows into SQLite, indexed by billing code.
- **FR-4 Comparison.** `compare(code)` returns rates across payers/hospitals
  (sorted) plus min/median/max/avg/spread/spread-percent.
- **FR-5 Outliers.** Flag rates that are statistical outliers within a code
  (z-score), on the canonical surface.
- **FR-6 Discovery.** List sources (with detected shape), procedures, and search.
- **FR-7 API + UI.** FastAPI (`/sources`, `/procedures`, `/compare/{code}`,
  `/outliers`, `/search`) + a comparison UI with a spread visualization.
- **FR-8 Offline + safe.** No network, no secrets; synthetic data only.

## Architecture

```
data.py (3 synthetic MRFs in 3 shapes, generated from one base)
   └─ normalize.py (detect shape → adapter → canonical records)
store.py (SQLite: load + index; compare/procedures/sources/search)
   └─ outliers.py (per-code z-score outliers)
```

## Conventions

Proprietary, offline-first, no secrets, synthetic data only — conforms to the
portfolio's CONV-1…5. SQLite here; the schema/queries port to Postgres unchanged.
