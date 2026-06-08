# Observability

persona-twin exposes Prometheus metrics and ships a Grafana dashboard, so
the behavior the rest of the system already records — routing, latency,
cache, circuit breaker — becomes visible over time rather than only in a
single request's debug payload.

## `/metrics`

`GET /metrics` returns the Prometheus text exposition format (0.0.4). The
metrics layer (`src/persona_twin/observability/metrics.py`) is
**dependency-free** — a small hand-rolled counter / gauge / histogram, in
the same spirit as the project's own BM25, circuit breaker, and redactor.
No client library, no background threads; collection is in-process and
rendering is pull-based at scrape time.

| Metric | Type | Labels | Source |
|---|---|---|---|
| `persona_twin_llm_latency_ms` | histogram | provider, model, task | router, on every completion |
| `persona_twin_llm_requests_total` | counter | provider, model, task | router |
| `persona_twin_requests_total` | counter | endpoint, status | API handlers |
| `persona_twin_circuit_opens_total` | counter | target | circuit breaker |
| `persona_twin_cache_events_total` | counter | kind, result | cache stats (scrape-time) |
| `persona_twin_circuit_cooldown_seconds` | gauge | target | breaker state (scrape-time) |
| `persona_twin_chunks_indexed` | gauge | — | vector store (scrape-time) |
| `persona_twin_personas` | gauge | — | loaded corpus (scrape-time) |
| `persona_twin_build_info` | gauge | version | `__version__` |

Accumulated series (LLM, requests, circuit opens) build up across
requests; the gauges are sampled fresh on each scrape.

## Prometheus + Grafana

`deploy/k8s/observability.yaml` deploys both into the `persona-twin`
namespace, synced by the same Argo Application as the app:

- **Prometheus** scrapes `persona-twin:80/metrics` every 15s (config in a
  ConfigMap; `emptyDir` storage with 6h retention — demo-grade).
- **Grafana** auto-provisions the Prometheus datasource and a committed
  dashboard (`grafana-dashboard-persona-twin` ConfigMap). Anonymous
  viewer access is on, so no login is needed to see the dashboard.

The dashboard panels: LLM p95 latency by provider, LLM request rate by
provider/model, answer cache hit ratio, circuit opens by target, and
chunks-indexed / persona-count stats.

Images (`prom/prometheus`, `grafana/grafana`) are side-loaded into the
kind node like the app image (`imagePullPolicy: Never`).

## Viewing

In the live local setup the gateway relay publishes Grafana at
**http://localhost:9082** (Prometheus at **9083**), alongside the demo
(9081) and Argo (9080). Out of cluster, `kubectl -n persona-twin
port-forward svc/grafana 3000:3000` works too.
