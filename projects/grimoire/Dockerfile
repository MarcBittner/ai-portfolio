# Grimoire — Next.js standalone image for self-hosting (Docker / Render; also
# Vercel-portable: stock Next, output:"standalone", stateless). NEXT_PUBLIC_* are
# inlined at BUILD time, so they're build ARGs (the platform passes them as build
# args). Server-only secrets (MONGODB_URI, ANTHROPIC_API_KEY, GITHUB_TOKEN,
# CLERK_SECRET_KEY) are read at RUNTIME from the service env — never baked in.
FROM node:20-slim AS build
WORKDIR /app
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=""
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
RUN useradd --create-home --uid 1001 app
# Next standalone bundle + static assets + public/. We also copy content/ so the
# local-store demo works out-of-the-box; production can set GITHUB_TOKEN + DOCS_REPO
# to use the GitHub API store instead (durable commits).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/content ./content
USER app
EXPOSE 8080
CMD ["node", "server.js"]
