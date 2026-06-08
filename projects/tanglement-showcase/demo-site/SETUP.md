# Teaser Site Setup Instructions

## Prerequisites

Before starting, ensure you have:
- Node.js 20+ installed
- npm 10+ installed

Check with:
```bash
node --version  # Should be >= v20.0.0
npm --version   # Should be >= 10.0.0
```

If not installed, install from: https://nodejs.org/

## Setup Steps

### Step 1: Initialize Next.js Project

From this directory (`/home/phaedrus/gits/tanglement.ai/packages/teaser-site`), run:

```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-git
```

**Options explained:**
- `--typescript`: Enable TypeScript
- `--tailwind`: Include Tailwind CSS
- `--eslint`: Include ESLint
- `--app`: Use App Router (Next.js 14)
- `--src-dir`: Use src/ directory structure
- `--import-alias "@/*"`: Enable path aliases
- `--no-git`: Don't initialize git (we're already in a git repo)

### Step 2: Follow Claude Code Prompts

Once Next.js is initialized, continue with the prompts in:

`/home/phaedrus/gits/tanglement.ai/docs/spec/15-teaser-site/teaser-site-claude-code-prompts.md`

Start with **Prompt P1-02: Install Dependencies and Configure Tools**

## Current Status

✅ Monorepo structure created
✅ Root package.json with workspaces configured
✅ .gitignore updated for monorepo
⏳ **NEXT STEP**: Initialize Next.js project (requires Node.js installation)

## Quick Commands

After setup, from the monorepo root:

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Run linter
npm run lint

# Run tests
npm run test

# Clean all build artifacts
npm run clean
```

## Troubleshooting

### Node.js not installed
Install Node.js 20 LTS from https://nodejs.org/ or use nvm:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
nvm use 20
```

### npx command not found
Ensure npm is properly installed:
```bash
npm install -g npm@latest
```

### Permission errors
If you encounter permission errors, don't use sudo. Fix npm permissions:
```bash
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH
```

Add the export line to your `~/.bashrc` or `~/.zshrc`.

## Next Steps After Initialization

1. Copy `.gitignore.template` from spec to project root
2. Create `.env.local` from `.env.example`
3. Follow remaining prompts in `teaser-site-claude-code-prompts.md`
