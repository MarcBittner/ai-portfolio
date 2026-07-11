# Next.js standalone build for flotilla (the instance-dashboard control plane).
# NEXT_PUBLIC_* vars must be present at BUILD time (Next inlines them into the
# client bundle), so they're declared as ARGs — Render passes matching service env
# vars as Docker build args. Without a Clerk publishable key at build, the client
# falls back to the keyless break-glass / public-read-only path (Clerk optional).
# Server-only secrets (CLERK_SECRET_KEY, MONGODB_URI, …) are read at RUNTIME from
# the service env, not baked into the image.
FROM node:20-slim AS build
WORKDIR /app
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=""
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Next 16 standalone build. Bump the heap so the (large) app + React Compiler pass
# never OOMs the builder. `output: "standalone"` (next.config.ts) emits a
# self-contained server.js + a trimmed node_modules.
ENV NODE_OPTIONS=--max-old-space-size=8192
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOSTNAME=0.0.0.0
RUN useradd --create-home --uid 1001 app
# Next standalone output: a self-contained server + the static assets + public/.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER app
EXPOSE 8080
CMD ["node", "server.js"]
