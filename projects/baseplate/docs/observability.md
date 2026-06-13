# Observability & SLOs

SLIs/SLOs for the example workload on the paved road — a price-transparency
service that **ingests** machine-readable rate files and **serves** rate queries
over HTTP. Framed for Datadog (metrics + SLOs + multi-window burn-rate
monitors); the live values come from `GET /slo` and `GET /quality`.

## The headline: data quality is an SLI

A service can be perfectly "up" — 200s, low latency, healthy pods — while
silently serving **wrong data**. For a price-transparency service that's the
failure that actually hurts users. So the **data-quality pass rate** (the
fraction of ingested rate rows that pass schema validation) is a first-class SLI
alongside availability and latency, not a batch-job afterthought.

It is computed deterministically in `src/baseplate/ingest.py`: each row is
validated for required fields (`code · code_type · payer · rate · hospital`), a
known code type, and a positive numeric rate; the pass rate is `valid / total`.

## SLIs and SLOs

| SLI | definition | SLO (30d) | error budget |
|---|---|---|---|
| **Availability** | non-5xx responses / total | 99.5% | ~216 min / 30d |
| **Ingest freshness** | feeds ingested within the freshness window / expected | 99.0% | ~432 min / 30d |
| **API latency** | requests with p99 < 300ms | 99.0% | ~432 min / 30d |
| **Data quality** | rows passing schema validation / ingested | 98.0% | 2% of rows |

Error budget = `(1 − objective) × window`. It's the currency: as long as budget
remains, ship; when it's exhausted, the priority shifts from features to
reliability.

## Burn-rate alerting (multi-window)

Alert on how fast the error budget is being consumed, not on a raw threshold —
this catches real incidents fast while staying quiet on noise. Two windows:

| window | burn-rate threshold | meaning | action |
|---|---|---|---|
| 1h | 14.4× | budget gone in ~2 days at this rate | **page** (fast burn) |
| 6h | 6× | budget gone in ~5 days at this rate | **ticket** (slow burn) |

A monitor fires only when *both* the long and short windows agree, which
suppresses the single-spike false positives a static threshold would page on.

## Datadog wiring (sketch)

```
# Availability SLO from request metrics
service.requests{status:!5xx} / service.requests           -> SLI
SLO: target 99.5% over 30d (metric-based)

# Data-quality SLO from a custom gauge the ingest job emits
baseplate.ingest.rows.valid / baseplate.ingest.rows.total  -> SLI
SLO: target 98% over 30d

# Fast-burn monitor (page)
burn_rate("availability") over 1h > 14.4 AND over 5m > 14.4
```

Each scaffolded service also gets a generated `slo.yaml` stub (availability +
latency, plus data-freshness when it has a database), so a new service starts
with SLOs defined rather than bolted on later.

## Golden signals → where they live

| signal | source on the paved road |
|---|---|
| latency | API request metrics → `api-latency-p99` SLO |
| traffic | request rate per service (HPA also scales on it) |
| errors | 5xx ratio → `availability` SLO + burn-rate monitors |
| saturation | CPU/memory vs. limits; HPA target 65% CPU |
| **correctness** | **data-quality pass rate → `data-quality` SLO** |
