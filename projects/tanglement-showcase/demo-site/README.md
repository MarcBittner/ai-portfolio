# Tanglement.ai Teaser Site

Marketing teaser site for Tanglement.ai - a decentralized routing layer for LLM access.

## Features

- **WebGL Fluid Background**: Custom shader-based background with spotlight effect that follows cursor
- **Responsive Design**: Mobile-first responsive layout
- **Type-Safe Forms**: React Hook Form with Zod validation
- **Animation**: Framer Motion and GSAP animations
- **Modern Stack**: Next.js 16 with TypeScript and Tailwind CSS

## Getting Started

### Development

```bash
npm run dev
# or
PORT=3000 npm run dev -- -H 0.0.0.0
```

Open [http://localhost:3000](http://localhost:3000) to view the site.

### Build

```bash
npm run build
npm start
```

## Build & Deploy — `tanglement-teaser`

This package ships a single cross-platform control script,
`./tanglement-teaser` (here in the `packages/teaser-site/` directory), for
building, pushing, deploying, and inspecting the Docker image. It auto-detects
the host OS/arch (Linux incl. TrueNAS Scale, and macOS on Apple Silicon /
Intel), resolves the repo root itself for git operations, and builds for the
host's native platform so the image runs locally. Every parameter has a
known-working default, and every default is overridable with a named switch.

Run it from this directory (or from anywhere — it finds its own context):

```bash
./tanglement-teaser --build                  # build (tag: local-<short-sha>)
./tanglement-teaser --build --deploy         # build, then run locally on :3030
./tanglement-teaser --build --push --deploy  # build, push to GHCR, deploy
./tanglement-teaser --all                    # = --build --push --deploy
./tanglement-teaser --build --version 1.2.3  # explicit tag
./tanglement-teaser --deploy --image ghcr.io/marcbittner/teaser-site --tag latest
./tanglement-teaser --status                 # container status
./tanglement-teaser --logs                   # follow logs
./tanglement-teaser --stop                   # stop & remove the container
./tanglement-teaser --git-push               # git push using the deploy SSH key
./tanglement-teaser --help                   # full switch reference
```

### Actions (combine freely; run in order build → push → deploy)

| Switch        | Effect |
|---------------|--------|
| `--build`     | Build the Docker image locally |
| `--push`      | Push to the registry (GHCR by default) |
| `--push-gcr`  | Also push to Google Container Registry |
| `--deploy`    | Run/replace the container locally |
| `--all`       | Shorthand for `--build --push --deploy` |
| `--status`    | Show container status and exit |
| `--logs`      | Follow container logs and exit |
| `--stop`      | Stop & remove the container and exit |
| `--git-push`  | `git push` using the deploy SSH key and exit |

### Parameters (override the defaults)

| Switch | Default |
|--------|---------|
| `--version` / `--tag VALUE` | `local-<short-sha>` |
| `--image NAME` | `marcbittner/teaser-site` (bare names get the registry prepended; full refs like `ghcr.io/...` are used as-is) |
| `--registry HOST` | `ghcr.io` |
| `--gcr-project ID` | `tanglement-ai` |
| `--container NAME` | `tanglement-teaser-site` |
| `--port N` / `--container-port N` | `3030` / `3000` |
| `--context DIR` | the script's own directory (`packages/teaser-site`) |
| `--dockerfile FILE` | `<context>/Dockerfile` |
| `--platform P` | host-native arch (e.g. `linux/arm64` on Apple Silicon) |
| `--docker-bin PATH` | auto-detected (falls back to `/host/usr/bin/docker` on TrueNAS) |
| `--env-file FILE` | none; passed to `docker run` on `--deploy` |
| `--ssh-key FILE` | `<context>/docs/spec/untracked/ghostlocalhost.pem` |
| `--restart POLICY` | `unless-stopped` |
| `--no-cache` | build without the Docker cache |
| `--no-latest` | don't also tag/push `:latest` on the `main` branch |
| `--dry-run` | print every command instead of executing it |

> Tip: prefix any invocation with `--dry-run` to see the exact `docker` /
> `git` commands the script would run without executing them.

The spec-driven workflow docs for this package live in
[`docs/spec/`](docs/spec/) (`spec.md`, `development-plan.md`, `claude-code.md`,
`session-init.md`); the full deployment model is in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Project Structure

```
src/
├── app/              # Next.js app directory
│   ├── layout.tsx    # Root layout with FluidBackground
│   └── page.tsx      # Home page
├── components/
│   ├── layout/       # Layout components (Navbar, Container, etc.)
│   ├── sections/     # Page sections (Hero, Features, FAQ, etc.)
│   └── ui/           # UI components
│       ├── FluidBackground.tsx  # WebGL shader background
│       └── ...
├── hooks/            # Custom React hooks
├── lib/              # Utilities and helpers
└── styles/           # Global styles
```

## Key Components

### FluidBackground

WebGL-based background effect using Three.js with custom shaders:
- **Simplex Noise**: 3D noise for organic patterns
- **Fractional Brownian Motion**: 5 octaves for visual complexity
- **Spotlight Effect**: A large, soft bright-core-with-dimming-halo light that
  tracks the cursor. The shader works in **device pixels** (`uResolution` is set
  from `renderer.getDrawingBufferSize()`), so the spotlight stays aligned to the
  cursor on HiDPI/Retina displays — don't revert `uResolution` to
  `window.innerWidth/innerHeight` or the light drifts off-cursor at `dpr > 1`.
- **Brand Colors**: Deep blue (#0a2540), Purple (#635bff), Cyan (#00d4ff)

Located at: `src/components/ui/FluidBackground.tsx`. Mounted once in
`src/app/layout.tsx` as a fixed, full-viewport background behind all content.
Spotlight shape is tuned via `coreRadius` / `haloRadius` / `baseBrightness` in
the fragment shader.

Usage:
```tsx
<FluidBackground speed={1.0} className="fixed inset-0 z-0" />
```

### Design System (dark theme)

The whole UI is presented over the dark FluidBackground, so the site renders in
a **single, always-on dark theme**:

- `<html className="dark">` (set in `layout.tsx`) plus a class-based `dark:`
  variant in `globals.css` (`@custom-variant dark (&:where(.dark, .dark *))`) —
  dark styling applies for every visitor, not just those whose OS is in dark
  mode. Base tokens (`--foreground` light, `--background`/borders dark) live in
  the `.dark { … }` block.
- **Section backgrounds are transparent** so the animated background shows
  through. Use `Section variant="default"` / `"muted"` (both transparent); avoid
  opaque section backgrounds.
- **Cards use one shared surface: `.card-surface`** — a translucent dark "glass"
  (`gray-900/55` + blur + `gray-800` border) defined in `globals.css`. Pair it
  with `card-3d` (tilt) and `hover:border-brand-accent/50` for the standard
  card. Prefer `.card-surface` over ad-hoc `bg-white` / `bg-gray-*` so cards stay
  consistent.

## Technology Stack

- **Framework**: Next.js 16.0.1 with App Router
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **3D Graphics**: Three.js
- **Animation**: Framer Motion, GSAP
- **Forms**: React Hook Form + Zod
- **Code Quality**: ESLint, Prettier, Husky

## Development Tools

- **Linting**: `npm run lint`
- **Type Checking**: `npm run type-check`
- **Formatting**: Prettier with Tailwind plugin
- **Pre-commit Hooks**: Husky + lint-staged

## Environment Variables

No environment variables required for development.

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 15+
- Edge 90+

Requires WebGL support for background effects.

## Recent Changes

### 2026-06-01
- **Design consistency pass**: committed the site to a single always-on dark
  theme (class-based `dark:` variant + `.dark` on `<html>`), made all section
  backgrounds transparent to show the FluidBackground, and unified every card
  onto a shared `.card-surface` glass treatment (Features, Problem, Solution,
  Trust, Testimonials, FAQ, CodeSamples). FAQ and CodeSamples sections are now
  transparent; Footer/Testimonials text fixed for dark.
- **FluidBackground spotlight**: fixed the Retina cursor-offset bug (shader now
  uses device-pixel `uResolution` via `getDrawingBufferSize()`) and retuned the
  spotlight to a large bright core with a soft dimming halo.
- **Tooling/docs**: added the unified `tanglement-teaser` control script and the
  spec-driven workflow docs under `docs/spec/`.

### 2025-11-04
- Added WebGL FluidBackground component with spotlight effect
- Implemented Simplex noise and FBM shaders
- Fixed background to span entire viewport
- Added 'use client' directive to Form component
- Updated layout to use fixed background with scrolling content

## License

Proprietary - Tanglement.ai
