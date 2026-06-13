# Observability — SLIs / SLOs (illustrative)

> This is the platform wrapper a Platform Ops role would own around rate-atlas —
> **what I'd build**, not what the free-tier live demo runs today. The demo
> exposes `/health` and is deterministic; the SLIs/SLOs/alerts below describe the
> production envelope.

rate-atlas is two things to monitor: an **ingest pipeline** (heterogeneous price
files → one canonical store) and a **read API** (`/compare`, `/outliers`). They
fail differently, so they get different SLIs.

## SLIs / SLOs

| SLI | definition | SLO | why it matters |
|---|---|---|---|
| **Ingest freshness** | age of the newest successfully-ingested MRF per source | < 7 days for 95% of active sources | a stale source silently drops out of the cross-payer comparison |
| **Ingest success rate** | successful normalizations ÷ attempted, per source | ≥ 99% over 30d | a shape that stops parsing is a source that disappears from `/compare` |
| **Data-quality pass rate** | rows passing canonical-schema validation (7 fields, `rate` numeric & > 0, known `code_type`) ÷ ingested rows | ≥ 99.5% | the comparison is only as trustworthy as the rows behind it |
| **Assisted-mapping coverage** | source columns mapped to a canonical field ÷ total, for unknown-format files | ≥ 90% (track LLM vs. offline split) | the column-mapping eval's recall metric, in production |
| **`/compare` availability** | non-5xx ÷ total requests | 99.9% over 30d | the read path is the product surface |
| **`/compare` latency** | server-side p99 | < 250 ms | a code-indexed `SELECT`; a p99 regression usually means a missing/!used index |

## Metrics to emit

Prometheus, scraped from a `/metrics` endpoint (the same dependency-free pattern
the other portfolio demos use):

| metric | type | labels |
|---|---|---|
| `rate_atlas_ingest_rows_total` | counter | `source`, `shape`, `result` |
| `rate_atlas_ingest_freshness_seconds` | gauge | `source` |
| `rate_atlas_dq_failures_total` | counter | `source`, `reason` |
| `rate_atlas_assist_columns_mapped` | histogram | `provider` |
| `rate_atlas_llm_requests_total` | counter | `provider`, `model` |
| `rate_atlas_request_duration_seconds` | histogram | `endpoint`, `status` |

## Alerting — multi-window burn-rate on the SLOs

Page on **burn rate**, not on a single bad request — the
[SRE workbook](https://sre.google/workbook/alerting-on-slos/) two-window approach:

- **Fast burn** — 2% of the 30d error budget in 1h (≈ 14.4× burn) on `/compare`
  availability **and** confirmed over a 5m window → **page**.
- **Slow burn** — 5% of budget in 6h (≈ 6× burn) → **ticket**, not a page.
- **Ingest freshness** — any active source past 7 days → ticket; past 14 days →
  page (the source has effectively left the comparison).
- **Data-quality** — pass rate < 99.5% over 1h → ticket with the top
  `dq_failures_total{reason}` so the failing shape is named.

Dashboards (Datadog or Grafana): one ingest board (freshness + success +
DQ by source) and one API board (`/compare` RED metrics, LLM provider mix for
the assisted path, offline-fallback ratio).
