# Next.js standalone build for trueline. Boots WITHOUT Convex/Clerk secrets
# (auth + backend are optional in demo mode — the landing renders and the gated
# /app shows a signed-out state). Set NEXT_PUBLIC_CONVEX_URL + Clerk keys to
# enable the full app.
FROM node:20-slim AS build
WORKDIR /app
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
