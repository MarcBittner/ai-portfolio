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
- **Spotlight Effect**: Dynamic lighting that follows cursor
- **Brand Colors**: Deep blue (#0a2540), Purple (#635bff), Cyan (#00d4ff)

Located at: `src/components/ui/FluidBackground.tsx`

Usage:
```tsx
<FluidBackground speed={1.0} className="fixed inset-0 z-0" />
```

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

### 2025-11-04
- Added WebGL FluidBackground component with spotlight effect
- Implemented Simplex noise and FBM shaders
- Fixed background to span entire viewport
- Added 'use client' directive to Form component
- Updated layout to use fixed background with scrolling content

## License

Proprietary - Tanglement.ai
