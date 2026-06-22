# counsel — Deployment

[`README`](../README.md) · [`OVERVIEW`](OVERVIEW.md) ·
[`ARCHITECTURE`](ARCHITECTURE.md) · [`API`](API.md) · [`WALKTHROUGH`](WALKTHROUGH.md)

counsel is a single FastAPI service that serves both the API and the static SPA.
It runs with **zero keys** (deterministic offline narrator), so a deploy is live
and demoable with no secrets configured.

## Local

```bash
./run.sh setup            # editable install (+ dev extras)
./run.sh serve            # http://127.0.0.1:8025
# CI / containers without a venv:
./run.sh setup --no-venv && ./run.sh serve --no-venv
```

## Docker

The image is single-stage, non-root, runtime-deps-only, and runs from source so
the static UI is always present.

```bash
docker build -t counsel .
docker run --rm -p 8080:8080 counsel        # http://127.0.0.1:8080
```

- Listens on `$PORT` (default `8080`); a platform that injects `PORT` (Render,
  Cloud Run) works unmodified.
- `HEALTHCHECK` polls `/health`.
- `tests/`, `docs/`, and `eval-report.md` are excluded from the image
  (`.dockerignore`).

## Render (free web service)

Deployed as a Docker web service built from the repo:

- `dockerfilePath: ./projects/counsel/Dockerfile`,
  `dockerContext: ./projects/counsel`
- `healthCheckPath: /health`, region oregon, plan free
- Build filter `paths: ["projects/counsel/**"]`,
  `ignoredPaths: ["**/*.md","**/docs/**","**/tests/**","**/LICENSE"]` so doc/test
  pushes don't rebuild the service.

Free-tier instances sleep after ~15 min idle; the first request cold-starts in
~30–60s. The live smoke suite tolerates this with a `/health` poll + transient
retry (`./run.sh smoke` with `SMOKE_URL=https://<host>`).

## Environment / routing

| Var | Purpose | Default |
|---|---|---|
| `PORT` | listen port | `8080` (container), `8025` (run.sh) |
| `LLM_MODE` | routing mode `auto\|paid\|local\|free\|offline` | `auto` |
| `OPENROUTER_API_KEY` | free hosted tier | unset → tier skipped |
| `OPENROUTER_MODEL` | free model id | `google/gemma-4-31b-it:free` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | paid tier | unset → tier skipped |
| `OLLAMA_BASE_URL` | local Ollama probe | `http://localhost:11434` |

With no keys set, routing falls through to the deterministic offline narrator and
the app is fully functional. Set `OPENROUTER_API_KEY` to light up the free tier
in the cloud.

### Local models from a cloud deploy (browser→host Ollama)

The cloud server can't reach a reviewer's `localhost`, so the **local** tier is
exercised from the browser: the SPA probes the visitor's own Ollama
(`http://localhost:11434`) and routes the narration there, then posts the result
back through the same verification path. No server-side Ollama needed; the cloud
demo can still show the local tier working on the reviewer's machine.

## Post-deploy verification

```bash
curl -s https://<host>/health        # {"status":"ok",...}
curl -s https://<host>/llm           # reachable providers + mode
SMOKE_URL=https://<host> ./run.sh smoke --no-venv
```
