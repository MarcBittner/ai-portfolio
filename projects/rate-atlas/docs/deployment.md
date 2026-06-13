# Deployment

## Live demo (what actually runs)

The portfolio demo is a single container (FastAPI + the static UI served from one
origin) on **Render's free tier**. No provider keys and no database are set on the
public host, so it runs the **deterministic path end-to-end**: the in-memory
SQLite stand-in for the rate store, and the synonym-table matcher for the
assisted column-mapping. `docker run` with no env is therefore a zero-config smoke
test.

```sh
cd projects/rate-atlas
docker build -t rate-atlas .
docker run --rm -p 8080:8080 rate-atlas
# UI at http://localhost:8080/  ·  API at /health, /compare/70450, /normalize/assist
```

Add a real model for the assisted mapping (the chain still falls back to offline
if the call fails):

```sh
docker run --rm -p 8080:8080 -e OPENROUTER_API_KEY=... rate-atlas
```

## Platform wrapper (illustrative — "what I'd build")

> Everything below is the production envelope a Platform Ops role would own. It is
> **not deployed** anywhere; the artifacts under `deploy/` are skeletons that show
> the shape. See `docs/observability.md` for the SLIs/SLOs that wrap it.

The same container runs unchanged at scale. The only thing that changes is where
the rate store lives — `DATABASE_URL` points the canonical store at managed
Postgres instead of in-memory SQLite (schema, `idx_code` index, and queries are
identical SQL).

- **`deploy/terraform/`** — AWS skeleton: a VPC, an **EKS** cluster for the
  stateless API, and an **RDS Postgres** for the canonical rate store, with IRSA
  so pods assume a scoped role (read the DB secret) and no long-lived keys. Remote
  state in S3 + DynamoDB lock. Module bodies are elided — the topology is the
  point.
- **`deploy/k8s/rate-atlas.yaml`** — `Deployment` (2 replicas, non-root,
  resource requests/limits), `Service`, an `HorizontalPodAutoscaler` (2→8 on CPU),
  and `/health` **readiness + liveness probes**. `DATABASE_URL` /
  `OPENROUTER_API_KEY` come from optional Secrets, so pods start fine without
  them (degrading to the deterministic path).
- **`deploy/argocd/application.yaml`** — GitOps: Argo CD syncs `deploy/k8s` from
  the repo, so the cluster follows `main` (prune + self-heal).

```
git push ─▶ Argo CD ─▶ EKS (Deployment + HPA + probes) ─▶ Service
                                  │
                                  ├─▶ RDS Postgres   (canonical rate store)
                                  └─▶ /metrics ─▶ Prometheus/Datadog ─▶ burn-rate alerts
```

### Why this shape

- **Stateless API, managed state.** The API holds nothing; horizontal scale is an
  HPA and the rate store is RDS. The SQLite→Postgres swap is a connection string,
  by design.
- **Offline-safe by construction.** Missing Secrets (no DB, no provider key) don't
  crash a pod — the app degrades to in-memory SQLite + the deterministic matcher,
  which is also exactly what the free-tier demo runs.
- **GitOps over imperative kubectl.** The repo is the source of truth; drift
  self-heals. Image tags are the deploy unit.
