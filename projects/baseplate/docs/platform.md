# The paved road — platform overview

A *paved road* is the supported, opinionated path a platform team builds so the
rest of the org ships fast and safely without re-deriving infrastructure for
every service. baseplate is a compact, reviewable reference for that road and
the self-service tooling that puts services on it.

## What the platform provides

| Layer | Artifact | What a team gets for free |
|---|---|---|
| **IaC foundation** | `deploy/terraform/main.tf` | Remote state (S3 + DynamoDB lock), a VPC, an EKS cluster — the shared substrate. |
| **Reusable `service` module** | `deploy/terraform/modules/service/` | One `module` block per service → ECR (scan-on-push, immutable tags), scoped IRSA (keyless pod identity), a namespace, and an optional RDS Postgres whose password lives in Secrets Manager, never in state. |
| **k8s base** | `deploy/k8s/base/` | Non-root pods, resource limits, readiness/liveness probes on `/health`, an HPA, and a PodDisruptionBudget — the production contract every workload inherits. |
| **GitOps** | `deploy/argocd/applicationset.yaml` | An ApplicationSet whose git generator turns each `services/*/deploy/k8s` directory into an Argo CD Application. Onboard by adding a directory and opening a PR — no Argo CD changes, no ticket. |
| **Golden CI/CD** | `deploy/github-actions/golden-ci.yml` | OIDC keyless auth → build → test → image scan (fail on HIGH/CRITICAL) → GitOps tag bump → post-deploy smoke gate with rollback. |
| **Observability** | `docs/observability.md`, generated `slo.yaml` | SLI/SLO definitions, error budgets, and multi-window burn-rate alerts in a Datadog-style framing. |
| **Self-service** | `src/baseplate/scaffold.py`, `POST /scaffold` | Describe a service in plain English; get all of the above generated for it. |

## How a service gets on the road

```
describe the service  ──►  scaffolder  ──►  generated files          ──►  PR
("a Python API that         (LLM/offline   (Dockerfile, k8s manifest,       │
  reads rates from           parser →       service.tf, golden CI,          │
  Postgres over HTTP")       ServiceSpec)    slo.yaml)                       ▼
                                                                    ApplicationSet
                                                                    sees the new
                                                                    services/<name>/
                                                                    dir and creates
                                                                    an Argo CD app
                                                                          │
                                                                          ▼
                                                              cluster reconciles
                                                              to the repo (GitOps)
```

```
┌─────────────────────────── AWS account (Terraform) ───────────────────────────┐
│  S3 + DynamoDB (remote state/lock)                                             │
│  VPC ── EKS cluster ───────────────────────────────────────────────────────┐  │
│           │   ┌──────────── per-service `service` module ───────────────┐   │  │
│           │   │  ECR repo · IRSA role (keyless) · namespace · [RDS]      │   │  │
│           │   └─────────────────────────────────────────────────────────┘   │  │
│           │   Argo CD ── watches the repo ── syncs k8s base (Deploy/SVC/HPA/  │  │
│           │              PDB + probes) for every onboarded service            │  │
│           └─────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Why these choices

- **Keyless everywhere.** CI authenticates to AWS over OIDC; pods assume IRSA
  roles. No long-lived AWS keys in CI secrets or pod env. RDS passwords are
  managed by Secrets Manager and never enter Terraform state.
- **GitOps over `kubectl apply`.** The repo is the single source of truth; the
  cluster reconciles to it (`selfHeal`, `prune`). Onboarding is a PR, and the
  diff *is* the deploy. The ApplicationSet means new services need zero Argo CD
  configuration.
- **The base is a contract, not a suggestion.** Probes, limits, non-root, and a
  PDB ship by default, so reliability isn't something each team rediscovers.
- **Self-service is the multiplier.** A platform team of one can't hand-write
  infra for every service. The scaffolder turns "I need a service" into a
  reviewable PR full of paved-road files — the platform engineer builds the
  road; the scaffolder lets everyone drive on it.

> The Terraform and Kubernetes here are **illustrative** — they sketch the
> platform a Platform Operations role would own. The live demo runs the FastAPI
> console + scaffolder on Render's free tier; the same container would run on the
> EKS cluster above. All data is synthetic; no HIPAA claim is made.
