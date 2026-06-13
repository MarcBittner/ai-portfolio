import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lint is run as a separate step (npm run lint), not during the production
  // build, so a style nit can't block a deploy.
  eslint: { ignoreDuringBuilds: true },
} as NextConfig;

export default nextConfig;
