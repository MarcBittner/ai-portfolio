# Claude Code Workflow — Session Initialization (Tanglement.ai Teaser Site)

## Environment Context

This project builds and deploys **locally on whatever host you are on**. The
unified control script (`tanglement-teaser`) auto-detects the platform:

- **Linux** (including TrueNAS Scale): builds/deploys via the local Docker
  daemon. On TrueNAS the Docker binary may be at `/host/usr/bin/docker`; the
  script falls back to it automatically (overridable with `--docker-bin`).
- **macOS** (Apple Silicon or Intel): builds/deploys via Docker Desktop /
  OrbStack / Colima. Default build platform is the host's native arch so the
  image runs locally.

The script never hard-codes a repo path — it resolves the repo root with
`git rev-parse --show-toplevel` — so it works regardless of clone location.

**Current Project:** the `packages/teaser-site` subdirectory of the
`tanglement.ai` monorepo.

## Core Workflow: Specification-Driven Development

Your workflow centers on three interconnected files in `docs/spec/`:

### 1. **spec.md** — The Product Specification
- **Contains:** what the site does (functional, non-functional, security reqs)
- **Update when:** any conversation decision changes product requirements

### 2. **development-plan.md** — Phase / Task List
- **Contains:** ordered phases derived from spec.md
- **Update when:** after each commit or as tasks change
- **Must show:** ✅ completed · 🔄 in progress · ⏳ pending

### 3. **claude-code.md** — Prompts & State Transfer
- **Section 1:** pointers to the canonical how-to docs + build/deploy quickref
- **Section 2:** state-transfer prompt to resume sessions
- **Update when:** after each commit (Section 1) and **before ending a session
  (Section 2 — CRITICAL)**

## Session Documentation (NEVER Commit These)

In `docs/spec/untracked/` (gitignored) maintain:

- **credentials.md** — credentials used/created during sessions; also holds the
  deploy key `ghostlocalhost.pem`
- **[YYYYMMDD_HHMMSS<TZ>]-session-transcript.md** — append-only session
  transcript (`date +%Y%m%d_%H%M%S%Z`), updated ~every 10 minutes

Ensure `docs/spec/untracked/` stays in `.gitignore`.

## Session Startup Process

**Execute these steps in order — do not ask questions covered by these steps:**

1. **Locate the project**
   - `cd` to the repo, then `packages/teaser-site` (or just run
     `./tanglement-teaser` from anywhere — it finds the root itself)

2. **Check for spec structure**
   - Verify `docs/spec/` exists; if not, this is a new setup (only THEN ask)

3. **Read the state transfer prompt** — `docs/spec/claude-code.md` Section 2

4. **Read credentials** — `docs/spec/untracked/credentials.md` (request only
   what's missing)

5. **Review task status** — `development-plan.md` and (monorepo)
   `docs/spec/15-teaser-site/PROGRESS.md`

6. **Report status and confirm next steps** — current location, last completed
   task, next pending task; ask the user to confirm

## Commit Checklist

Before each commit, update as needed:
- ✅ `spec.md` (if requirements changed)
- ✅ `development-plan.md` (mark completed tasks)
- ✅ `claude-code.md` Section 1
- ✅ Session transcript

## End-of-Session Checklist

- ✅ All commit checklist items above
- ✅ **`claude-code.md` Section 2 with a fresh state-transfer prompt** (CRITICAL)
- ✅ `credentials.md` (if new credentials were used)
- ✅ Final session transcript update

---

**Execute the Session Startup Process above, then report your findings.**
