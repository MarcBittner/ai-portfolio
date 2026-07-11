# Dedicated collab WS service — small, stateful (holds live Yjs rooms in memory,
# persists to Mongo). Deployed separately from the main app (its own Render
# service) so the app stays stateless / Vercel-portable.
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production PORT=1234
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
EXPOSE 1234
CMD ["node", "server.mjs"]
