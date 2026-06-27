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

1. Build code; keep `./run.sh test` + `./run.sh lint` green and bump the version
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
the gateway. Keep `./run.sh test` green.
```

---

## Section 2: State Transfer Prompts

---

### 2026-06-27 — fleet polish + full live-demo redeploy + CO-Ver onboarding

**What happened this session (ai-portfolio + life-ops):**
- **Crash recovery → session-workflow automation.** Built auto-transcript capture so a crash
  never loses work again: `claude-code-utilities/scripts/mirror-transcript.py` (Stop/SessionEnd
  hook → mirrors the live `.jsonl` into `docs/spec/untracked/*-session-transcript.md`),
  `session-context.sh` (SessionStart hook injects the workflow rules), `install-hooks.sh` (wires
  them into `~/.claude/settings.json`; `session-init.sh`/`install-cc-alias.sh` call it). Takes
  full effect on the NEXT `cc` session (hooks load at startup).
- **Fleet consistency pass (committed):** dark/light theme + About/stack on the 6 group-A apps;
  fixed the browser→host Ollama bridge on promptguard/reconcile/postureline (local tier now runs
  the model in the BROWSER via host Ollama — the recurring "diagnostics broken" bug); README
  badges/screenshots on 4 thin ones; cross-stack fixes (persona-twin bridge, trueline theme,
  vigil About). All test/adversarially verified.
- **Live-demo crisis fixed:** accounts 1–3 were system-suspended. Redeployed all 29 demos onto
  accounts 4/5/6; fixed a Docker build-context bug (`rootDir`), set `OPENROUTER_API_KEY` fleet-wide
  (routing was falling back to offline), made **vigil cold-start-aware** (re-probes Render warmup
  signals with a 55s budget; fixed `/healthz` health paths + self-monitor port). **27/29 live.**
  Added `scripts/live-urls.json`, `scripts/postdeploy-check.py`, `docs/POSTDEPLOY-CHECKLIST.md`.
- **Quin/Ben + CO-Ver:** Gmail drafts prepared (draft-only integration — no send tool). Saved
  personal/job context to memory (`~/.claude/projects/-workspace/memory/`): Marc's bio + the new
  **CO-Ver** contract role (senior fullstack; Vinny DiDonato; Next.js/Convex/Clerk/Anthropic).

**State now:** `origin/main` is pushed and current. 27/29 demos live (README = source of truth).

**Next session — pick up here:**
1. **cycleledger** + **trueline** are the only demos down — provision a free Postgres
   (`DATABASE_URL`) for cycleledger; trueline needs the user's Convex URL + Clerk keys.
2. CO-Ver day-1 onboarding (NDA signed; await onboarding sheet; customer story + context bundles).
3. Run `python3 scripts/postdeploy-check.py` first to re-confirm live state (free tiers may
   re-sleep / accounts 1–3 minutes may reset).

---

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

You are resuming work on **persona-twin** — a public, source-available (proprietary)
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
   gateway at http://localhost:9081, keep `./run.sh test` green.
