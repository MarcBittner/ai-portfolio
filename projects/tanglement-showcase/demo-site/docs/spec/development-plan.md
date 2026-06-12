# Tanglement.ai Teaser Site — Development Plan

## Overview

Phase-level progress for the teaser-site package. Granular per-task history
lives in the git log and in `docs/spec/15-teaser-site/PROGRESS.md` (monorepo
root). Each completed phase points at the work that closed it.

**Legend:** ✅ completed · 🔄 in progress · ⏳ pending · ⚠️ needs attention

---

## Phase 1: Project Initialization ✅ (6/6)

- [x] Git repo + monorepo workspace layout
- [x] Next.js 16 project in `packages/teaser-site`
- [x] Project structure (`src/{app,components,lib,types}`)
- [x] Core dependencies installed (React 19, Tailwind 4, Radix, Framer, R3F)
- [x] Code-quality tooling (ESLint, Prettier, Husky, lint-staged)
- [x] TypeScript strict + Tailwind design system

## Phase 2: Foundation & Infrastructure ✅ (5/5)

- [x] Dockerfile (multi-stage, standalone, non-root)
- [x] `docker-compose.yml` + `docker-compose.truenas.yml`
- [x] GitHub Actions CI/CD (`.github/workflows/deploy-teaser-site.yml`)
- [x] Env handling (`.env.example`, Zod validation, `SKIP_ENV_VALIDATION`)
- [x] `/api/health` endpoint

## Phase 3: Core Components ✅ (5/5)

- [x] Layout / shell, design tokens
- [x] UI primitives (`src/components/ui/`)
- [x] Reusable section scaffolding
- [x] Animation utilities
- [x] Theming

## Phase 4: Hero Section & Marketing ✅ (6/6)

- [x] Hero with Tanglement.ai messaging
- [x] Features section
- [x] Animated gradient backgrounds
- [x] Responsive layout pass
- [x] CTA / waitlist entry points
- [x] Content updates to real Tanglement.ai copy

## Phase 5: Content Integration 🔄 (3/6)

- [x] P5 — FAQ section (Radix Accordion)
- [x] P5 — Testimonials (clearly simulated)
- [x] P5 — Footer
- [ ] P5-T02 — Developer preview / code samples section
- [ ] P5-T03 — Network status dashboard (simulated metrics + disclaimer)
- [ ] P5-T05 — Newsletter subscription (ConvertKit) + P5-T06 legal pages

## Phase 6: Testing & QA ⏳ (0/7)

- [ ] Component tests, a11y checks, Lighthouse pass, cross-browser

## Phase 6.5: UI / Design Consistency 🔄

- [x] **FluidBackground spotlight fix** — corrected the HiDPI/Retina cursor
      offset (device-pixel `uResolution` via `getDrawingBufferSize()`) and
      retuned the spotlight (bright core + soft dimming halo)
- [x] **Single always-on dark theme** — class-based `dark:` variant + `.dark`
      on `<html>`, dark base tokens; no longer OS-`prefers-color-scheme` driven
- [x] **Transparent section backgrounds** so the background shows through
      (CodeSamples + FAQ were the opaque offenders)
- [x] **Unified `.card-surface`** glass treatment across all cards (Features,
      ProblemStatement, SolutionOverview, TrustIndicators, Testimonials, FAQ,
      CodeSamples); Footer/Testimonials text fixed for dark
- [ ] Visual QA pass across breakpoints + a final contrast/readability check

## Phase 7: Deployment & Launch 🔄 (build tooling landed)

- [x] Local build pathway (`build-local.sh`)
- [x] **Unified cross-platform control script `tanglement-teaser`** —
      named-switch driven `--build/--push/--deploy/--status/--logs/--stop`,
      Linux + macOS auto-detection, overridable defaults
- [x] Spec-driven workflow docs for the package (`docs/spec/`)
- [ ] ⚠️ CI/CD build reliability (see `WORKFLOW_FIX_NEEDED.md`)
- [ ] Production domain + reverse proxy / TLS
- [ ] Launch checklist

---

## Open Items / Known Issues

- ⚠️ **CI/CD builds intermittently failing** — Dockerfile fixed; workflow may
  still need a manual nudge. See `WORKFLOW_FIX_NEEDED.md` and `BUILD_ISSUES.md`.
- **Progress drift** — root `CLAUDE.md` (9/49) lags `PROGRESS.md` (24/49 + 3).
  `PROGRESS.md` is the source of truth.
- **Port 3000 conflict** on TrueNAS (papertrail-frontend) — teaser uses 3030.

---

**Last Updated:** 2026-06-01
