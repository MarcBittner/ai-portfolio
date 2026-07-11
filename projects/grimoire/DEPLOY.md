# Deploying Grimoire

Grimoire is self-hostable and offline-first: it boots with zero keys against an
in-memory store, and ships as a stock Next.js `output: "standalone"` image (Docker
/ Render; also Vercel-portable).

Deployment and operations documentation lives in
**[`docs/deploy-and-ops.md`](./docs/deploy-and-ops.md)** — Render + Vercel setup, the
full environment-variable reference, operational runbooks, disaster recovery, and
troubleshooting.
