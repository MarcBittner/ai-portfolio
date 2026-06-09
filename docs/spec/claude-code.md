# persona-twin — Claude Code Prompts

## Section 1: Development Task Prompts

### Standing rules (apply to every session)

- This is a monorepo: portfolio-level spec/plan live in `docs/spec/`;
  each project is self-contained under `projects/<name>/` with its own
  `docs/spec/spec.md` + `development-plan.md`.
- Work phase-by-phase against the active project's development plan
  (currently `projects/persona-twin/docs/spec/development-plan.md`);
  update its checkboxes — and the portfolio plan's phase list — as tasks
  complete.
- Commit style: `(task) description` — e.g. `(chunking) fixed-size chunker
  with overlap and provenance`. Commit per coherent unit.
- **Before every commit:** scan the staged diff for secret-shaped strings
  (key prefixes, connection strings with credentials, private-key blocks);
  refuse to commit on a hit.
- Synthetic, fictional data only. No personal data, no scraped content.
- The offline path (mock LLM, hash embedder, in-memory store) is a
  first-class mode — every feature must work without a `.env`.

### Live deployment + ship loop (post-v0.1.0)

The app runs on a **local kind cluster** (`kind-argo-demo`) under
**Argo CD** (Application synced from this repo's `main`). The full
ship loop for each feature:

1. Build code; keep `make test` + `make lint` green and bump the version
   in `pyproject.toml`, `src/persona_twin/__init__.py`, and
   `deploy/k8s/persona-twin.yaml` (image tag) together
2. `docker build -t persona-twin:vX.Y.Z .` then
   `docker save persona-twin:vX.Y.Z | docker exec -i argo-demo-control-plane ctr -n k8s.io images import -`
   (kind can't pull local images — they're side-loaded; manifest uses
   `imagePullPolicy: Never`)
3. Commit `(task) …`, tag `vX.Y.Z`, push (the secret-scan pre-commit
   hook gates it)
4. `kubectl annotate application -n argocd persona-twin
   argocd.argoproj.io/refresh=normal --overwrite` to pull the sync, wait
   for the revision to match HEAD, then
   `kubectl -n persona-twin rollout status deployment/persona-twin`
5. **`docker restart persona-twin-gateway`** — the relay container's
   port-forwards pin to the old pod; bounce it after every rollout
6. **Verify through the gateway** (`http://host.docker.internal:9081`)
   before reporting done — port-forwards to NodePort don't reach this
   container, in-cluster/gateway paths do

User-facing URLs (Mac browser, via the `persona-twin-gateway` relay
container publishing to localhost): **demo http://localhost:9081**,
**Argo http://localhost:9080**. Git pushes use the SSH key at
`docs/spec/untracked/ghostlocalhost.pem` (see [[github-push-key-location]]
memory): `GIT_SSH_COMMAND="ssh -i docs/spec/untracked/ghostlocalhost.pem
-o IdentitiesOnly=yes" git push`.

### Next task prompt

```
Continue persona-twin. Read projects/persona-twin/docs/spec/spec.md and
projects/persona-twin/docs/spec/development-plan.md (the Roadmap section
at the bottom lists the next candidate features — quantifying the new
retrieval paths via benchmarks is recommended). Pick one, implement it
following the standing rules, ship
it via the live deployment loop in claude-code.md §1, and verify through
the gateway. Keep `make test` green.
```

---

## Section 2: State Transfer Prompts

**Last Updated:** 2026-06-08

**Project Status:** persona-twin **v0.14.0**, live on the local
kind/Argo cluster. Phases 0–21 complete (RAG → twins → eval → frontend →
deploy → routing console → benchmarks/analytics → persistence → aggregate
scoreboard → free-model wiring → Ollama embeddings + circuit breaker →
hybrid retrieval + CI → streaming + conversational twins → persona
builder → observability → eval refinements + interview). GitHub Actions
CI is green (lint/test/eval gate + frontend build). **Next:** pick a
feature from the Roadmap section in the project plan — *quantifying the new
retrieval paths via benchmarks* is recommended.

v0.14.0 batch: **voice-consistency judge** (twin_answer benchmark metric),
**query rewriting** (`query_rewrite` routed task, opt-in
`PERSONA_TWIN_QUERY_REWRITE`), **history-aware chat retrieval**
(`PERSONA_TWIN_CHAT_CONDENSE`, on by default), **twin-vs-twin**
(`/interview` tab), and builder **doc upload**. Grafana at
**localhost:9082**, Prometheus **9083**. Sibling project **pii-redactor**
is also live on Argo at **localhost:9084** (its own Argo Application).

Active config worth knowing: Ollama is the live embedder
(`nomic-embed-text`, 768d) and provides local LLM models; OpenRouter free
key is set (cluster Secret `persona-twin-providers`, value also in
untracked credentials), so free-model discovery is on; hybrid retrieval
(BM25+RRF) is on by default.

### Resume Prompt for Next Session

You are resuming work on **persona-twin** — a public, MIT-licensed
reference implementation of RAG, HEXACO persona twins, multi-provider LLM
routing, layered evaluation, model benchmarking, hybrid retrieval,
streamed conversational twins, a browser persona builder, observability,
query rewriting, and twin-vs-twin interviews. It is **v0.14.0, deployed
live** on a local kind cluster under Argo CD.

1. Read `projects/persona-twin/docs/spec/spec.md` (requirements, FR-1…
   FR-20) and `.../development-plan.md` — the **Roadmap** section at the
   bottom lists the next candidate features
2. Read `docs/spec/claude-code.md` §1 for the standing rules **and the
   live deployment / ship loop** (build → side-load into kind → bump
   manifest → push → Argo sync → bounce gateway → verify via gateway)
3. Credentials live in `docs/spec/untracked/credentials.md` (gitignored:
   OpenRouter key, Argo admin password, GitHub SSH key). Never commit.
4. Pick the next roadmap feature (benchmark the new retrieval paths
   recommended),
   implement it, ship via the loop, verify through the
   gateway at http://localhost:9081, keep `make test` green.
