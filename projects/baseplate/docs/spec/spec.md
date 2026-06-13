# baseplate — spec

## Problem

The first platform-engineering hire at a fast-growing company has to build the
**paved road** the whole org ships on: infrastructure-as-code, a golden CI/CD
pipeline, GitOps, SLOs, and self-service tooling — so product teams ship
production-grade services without re-deriving infrastructure each time. baseplate
is a compact, reviewable reference for that road plus the self-service tool that
puts services on it, with a small price-transparency ingest service as the
example workload.

## Goals

1. Show the **reusable IaC** a platform provides: a `service` Terraform module
   (ECR/IRSA/namespace/RDS) plus the VPC/EKS/remote-state foundation.
2. Show the **k8s base contract** (non-root, probes, HPA, PDB) and **GitOps**
   onboarding via an Argo CD ApplicationSet (app-of-apps).
3. Show a **golden CI/CD** pipeline: OIDC keyless → build → test → scan →
   deploy → post-deploy smoke gate with rollback.
4. Provide a **self-service scaffolder**: free-text service description → an
   LLM-extracted `ServiceSpec` → deterministically generated paved-road files.
5. Define **observability**: SLIs/SLOs incl. **data-quality-as-an-SLI**, error
   budgets, and burn-rate alerts.
6. Run **fully offline**, deterministically, with no secrets and synthetic data.

## Non-goals / boundaries

- Not a price-transparency **normalizer** — that's the sibling `rate-atlas`
  demo. Here the ingest service is just the example workload; the platform
  tooling is the focus.
- The Terraform/Kubernetes are **illustrative** ("what the platform provides"),
  not applied; the live demo runs the FastAPI console on Render.
- **No HIPAA claim.** All hospitals, payers, codes, and rates are synthetic and
  clearly fictional.

## The LLM feature

The scaffolder's free-text → `ServiceSpec` step routes through the standard chain
(Anthropic/OpenAI → Ollama → OpenRouter → a deterministic offline parser). The
model only *extracts the structured spec*; every generated file is deterministic
templating, so output is reviewable and reproducible, and the whole flow works
with zero keys via the offline parser.

## Invariants

- Same `ServiceSpec` in → byte-identical generated files out.
- Every generated k8s manifest parses as YAML and carries the base contract
  (non-root, probes when HTTP, a PodDisruptionBudget).
- The data-quality pass rate is in [0, 1].
- `/health` and the offline path expose no secrets.
