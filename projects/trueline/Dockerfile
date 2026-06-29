# Next.js standalone build for trueline. NEXT_PUBLIC_* vars must be present at
# BUILD time (Next inlines them into the client bundle), so they're declared as
# ARGs — Render passes matching service env vars as Docker build args. Without a
# Clerk publishable key + Convex URL at build, the client falls back to demo
# mode (Clerk optional, placeholder Convex). Server-only secrets (CLERK_SECRET_KEY)
# are read at runtime, not needed here.
FROM node:20-slim AS build
WORKDIR /app
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=""
ARG NEXT_PUBLIC_CONVEX_URL=""
ARG NEXT_PUBLIC_CONVEX_SITE_URL=""
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NEXT_PUBLIC_CONVEX_URL=$NEXT_PUBLIC_CONVEX_URL \
    NEXT_PUBLIC_CONVEX_SITE_URL=$NEXT_PUBLIC_CONVEX_SITE_URL
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
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
