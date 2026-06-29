import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle (.next/standalone/server.js) so the Docker
  // runtime image is small and needs no node_modules at runtime.
  output: "standalone",
  // Lint is run as a separate step (npm run lint), not during the production
  // build, so a style nit can't block a deploy.
  eslint: { ignoreDuringBuilds: true },
} as NextConfig;

export default nextConfig;
