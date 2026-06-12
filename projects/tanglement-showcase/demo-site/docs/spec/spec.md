# Tanglement.ai Teaser Site — Product Specification

## Product Overview

The **Tanglement.ai teaser site** is a Next.js marketing/waitlist site that
introduces the Tanglement.ai decentralized agent-marketplace and LLM-routing
platform ahead of its public launch. It is the first package in the
`tanglement.ai` monorepo (`packages/teaser-site`).

The site's job is to communicate the value proposition (cost savings,
multi-provider routing, privacy-first client-side key handling), build a
waitlist, and establish credibility — all before the SDK or network exist.
Most data-heavy components (network dashboard, testimonials) are clearly
labelled simulations.

> The full product spec for the broader platform lives at
> `docs/spec/15-teaser-site/teaser-site-spec.md` (monorepo root). This file is
> the teaser-site package's working spec for spec-driven development sessions.

---

## Technology Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16 (App Router, **standalone** output) |
| Runtime | Node.js 20 (Alpine in production) |
| Language | TypeScript 5.x (strict mode) |
| Styling | Tailwind CSS 4.x |
| UI primitives | Radix UI |
| Animation | Framer Motion |
| 3D | Three.js + React Three Fiber |
| Forms | React Hook Form + Zod |
| Package manager | npm 10 workspaces (`legacy-peer-deps=true`) |
| Container | Docker multi-stage build |

**React 19 note:** `.npmrc` sets `legacy-peer-deps=true` for Three.js / Framer
Motion compatibility — do not remove it.

---

## Functional Requirements

### FR-1: Marketing Content
- **FR-1.1** Hero section with Tanglement.ai messaging and waitlist CTA
- **FR-1.2** Features section (cost savings, routing tiers, privacy)
- **FR-1.3** FAQ section (Radix Accordion)
- **FR-1.4** Testimonials (clearly simulated)
- **FR-1.5** Footer with legal links and newsletter entry point

### FR-2: Waitlist / Lead Capture
- **FR-2.1** Newsletter subscription via ConvertKit (`src/lib/email/`)
- **FR-2.2** Client + server validation (Zod), success/error states
- **FR-2.3** GDPR-compliant consent checkbox

### FR-3: Simulated Network Status
- **FR-3.1** Animated metrics (active nodes, requests routed, uptime, savings)
- **FR-3.2** Prominent "simulated data for demonstration" disclaimer

### FR-4: Health & Observability
- **FR-4.1** `/api/health` endpoint returning 200 when healthy (used by the
  container HEALTHCHECK)

### FR-5: Build & Deployment (see `development-plan.md` Phase 7)
- **FR-5.1** Two build pathways producing identical images: GitHub Actions
  (multi-arch, ~8 min) and a **local build** for fast iteration (~3–5 min)
- **FR-5.2** A single cross-platform control script
  (`tanglement-teaser`) that detects the host OS/arch and can build, push,
  deploy, and inspect the container locally, with every parameter overridable
  via named switches and sane defaults baked in
- **FR-5.3** Image published to GHCR (`ghcr.io/marcbittner/teaser-site`);
  optional GCR mirror

### FR-6: Visual Design System

- **FR-6.1** A single full-viewport WebGL background (`FluidBackground`,
  mounted once in `layout.tsx`) with a cursor-tracking spotlight (bright core +
  soft dimming halo). The shader operates in device pixels so the spotlight
  stays aligned to the cursor on HiDPI/Retina displays.
- **FR-6.2** The site renders in a **single always-on dark theme** (it sits on
  the dark background). Dark styling is class-based (`.dark` on `<html>` + a
  class-based `dark:` variant), not OS-`prefers-color-scheme`-dependent, so all
  visitors get the same presentation.
- **FR-6.3** Section backgrounds are **transparent** so the background shows
  through; cards use one shared `.card-surface` glass treatment (translucent
  dark + blur + border, optionally with the `card-3d` tilt). New sections/cards
  must follow this rather than introducing opaque or light backgrounds.

---

## Non-Functional Requirements

### NFR-1: Portability
- The control script runs unmodified on **Linux** (incl. TrueNAS Scale's
  `/host/usr/bin/docker`) and **macOS** (Apple Silicon + Intel). It detects
  the platform with `uname -s`/`uname -m`, never hard-codes a repo path
  (uses `git rev-parse --show-toplevel`), and uses portable bash.
- Default build `--platform` is the host's native arch so the image runs
  locally; overridable for multi-arch releases.

### NFR-2: Idempotency
- `--deploy` stops/removes any existing container before starting a new one.
- Re-running `--build` with the same tag is safe.

### NFR-3: Observability
- Color-coded `log_info` / `log_warn` / `log_error` / `log_step` output.
- `--status` and `--logs` actions for the running container.

### NFR-4: Image Size
- Multi-stage Alpine build; standalone output keeps the image ~150–280 MB.

---

## Security Requirements

### SEC-1: Secret Handling
- No secrets in tracked files. The deploy SSH key
  (`ghostlocalhost.pem`) and `credentials.md` live in `docs/spec/untracked/`,
  which is gitignored (and `*.pem`/`*.key` are independently ignored).
- Registry tokens are supplied via the environment / `docker login`, never
  committed and never baked into the control script.

### SEC-2: Container Hardening
- Production image runs as a non-root user.
- HEALTHCHECK enabled so unhealthy containers are detected.

---

## Deployment Targets

| Target | Port | Notes |
|---|---|---|
| Local dev (any host) | host `3030` → container `3000` | `tanglement-teaser --build --deploy` |
| TrueNAS Scale (`10.10.10.9`) | `3030` → `3000` | Docker at `/host/usr/bin/docker`; port 3000 used by papertrail |
| CI / GHCR | — | GitHub Actions multi-arch build & push |

---

## Out of Scope (teaser phase)

- The actual SDK / routing network (code samples are illustrative mockups)
- Real telemetry behind the network dashboard
- Multi-tenant auth / accounts

---

**Last Updated:** 2026-06-01
