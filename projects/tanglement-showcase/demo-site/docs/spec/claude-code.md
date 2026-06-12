# Teaser Site — Prompts & State Transfer

## Document Purpose

Two sections, mirroring the `claude-code-utilities` convention:

1. **Section 1 — Workflow & task prompts.** Pointers to the canonical how-to
   docs so they don't drift.
2. **Section 2 — State transfer.** A self-contained prompt that brings a fresh
   Claude Code session up to speed.

---

# Section 1: Workflow & Task Prompts

Detailed how-to docs are kept next to the code:

- **`docs/spec/spec.md`** — product + non-functional requirements for the package
- **`docs/spec/development-plan.md`** — phase-level progress + open items
- **`docs/spec/session-init.md`** — paste-in session-initialization prompt
- **`README.md` / `BUILD_README.md`** (monorepo root) — build pathways
- **`docs/DEPLOYMENT.md`** — full build-push-pull deployment guide
- **`tanglement-teaser --help`** — the unified control script's full switch list
- Per-task content prompts (FAQ, code samples, dashboard, newsletter, legal):
  monorepo `CLAUDE.md` → "Claude Code Prompts for Development Tasks", and
  `docs/spec/15-teaser-site/teaser-site-claude-code-prompts.md`

Source of truth for "how do I build/run/change X" is these docs plus `git log`.
`development-plan.md` tracks phase-level progress; `PROGRESS.md` (monorepo) has
the finest-grained task tracker.

## Build / Deploy quick reference

```bash
# From anywhere in the repo — the script finds the repo root and host platform.
./tanglement-teaser --build                 # build image, default tag local-<sha>
./tanglement-teaser --build --deploy         # build then run locally on :3030
./tanglement-teaser --build --push --deploy  # build, push to GHCR, deploy
./tanglement-teaser --build --version 1.2.3  # explicit tag
./tanglement-teaser --deploy --image ghcr.io/marcbittner/teaser-site --tag latest
./tanglement-teaser --status                 # container status
./tanglement-teaser --logs                   # follow logs
./tanglement-teaser --stop                   # stop & remove container
./tanglement-teaser --git-push               # push commits using ghostlocalhost.pem
```

---

# Section 2: State Transfer

## Resume Prompt — Tanglement.ai Teaser Site

```
I'm continuing work on the Tanglement.ai teaser site, the first package in the
`tanglement.ai` monorepo at packages/teaser-site.

## What this is

A Next.js 16 (App Router, standalone) marketing + waitlist site for the
Tanglement.ai decentralized LLM-routing platform. Tailwind 4, Radix UI, Framer
Motion, Three.js/R3F, ConvertKit for the waitlist. React 19 with
legacy-peer-deps=true (do not remove). Ships as a multi-stage Alpine Docker
image to GHCR (ghcr.io/marcbittner/teaser-site), deployed on TrueNAS Scale at
http://10.10.10.9:3030 (host port 3030 → container 3000; 3000 is taken by
papertrail-frontend).

## Where the project just landed

- Added the spec-driven workflow docs for the package under
  packages/teaser-site/docs/spec/ (spec.md, development-plan.md, claude-code.md,
  session-init.md), modeled on ~/gits/claude-code-utilities.
- Added a unified cross-platform control script `tanglement-teaser` inside the
  package (packages/teaser-site/): named-switch driven (--build/--push/--deploy/
  --status/--logs/--stop/--git-push), auto-detects Linux vs macOS and arch,
  defaults its build context to its own directory and resolves the repo root via
  git rev-parse for git ops, all defaults overridable (--image, --tag/--version,
  --registry, --port, --container, --platform, --dockerfile, --context,
  --docker-bin, --ssh-key, --env-file). Supersedes the Mac-path-hardcoded
  build-local.sh for day-to-day use.
- Created packages/teaser-site/docs/spec/untracked/ (gitignored) holding
  credentials.md and the deploy key ghostlocalhost.pem.
- UI/design consistency pass: fixed the FluidBackground Retina spotlight offset
  (device-pixel uResolution via getDrawingBufferSize) and retuned the spotlight
  (bright core + soft dimming halo); committed the site to a single always-on
  dark theme (class-based dark: variant + .dark on <html>, dark base tokens);
  made section backgrounds transparent (CodeSamples + FAQ were opaque); and
  unified every card onto a shared .card-surface glass utility. See the
  "Design System" notes in README.md and FR-6 in spec.md.

## Current status (per docs/spec/development-plan.md + PROGRESS.md)

- Phases 1–4 complete; Phase 5 (Content Integration) at 3/6 (FAQ, Testimonials,
  Footer done; code samples, network dashboard, newsletter + legal pages
  pending). Phase 6.5 (UI/design consistency) largely done — visual QA pass
  across breakpoints still owed. Phases 6–7 otherwise mostly pending.
- ⚠️ CI/CD builds intermittently failing — see WORKFLOW_FIX_NEEDED.md and
  BUILD_ISSUES.md.
- Design system is documented (README "Design System", spec.md FR-6): new
  sections must be transparent and new cards must use .card-surface.

## What I need

[Describe the task for this session]

## Where to look first

- docs/spec/spec.md and docs/spec/development-plan.md
- tanglement-teaser --help for the build/deploy surface
- docs/DEPLOYMENT.md for the full deployment model
- docs/spec/15-teaser-site/PROGRESS.md for fine-grained task status
```

---

## Section 2 Maintenance

Regenerate this section before ending a session: update the "Where the project
just landed" and "Current status" blocks from the latest commits and
`development-plan.md` / `PROGRESS.md` task counts.

**Last Updated:** 2026-06-01
