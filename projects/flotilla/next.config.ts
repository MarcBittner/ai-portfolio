import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle (.next/standalone/server.js) so the Docker
  // runtime image is small and needs no node_modules at runtime.
  output: "standalone",
  // Lint is run as a separate step (npm run lint), not during the production
  // build, so a style nit can't block a deploy.
  eslint: { ignoreDuringBuilds: true },
  // React Compiler (Next 16 top-level key): auto-memoizes components/hooks so the
  // 8s SWR fleet poll re-renders only what actually changed, cutting the re-render
  // cost of the whole page tree. Requires babel-plugin-react-compiler@1.0.0 (dev).
  // Known tradeoff: adds ~70KB (react-compiler-runtime + emitted _c memo caches).
  reactCompiler: true,
  experimental: {
    // Lengthen the client router cache so repeat <Link> prefetches (e.g. the nav
    // tabs, which the router can re-request as you move around) are deduped from
    // cache instead of re-fetched. dynamic: 30s covers server-rendered routes;
    // static: 180s covers the prerendered tabs. Cuts the /app prefetch volume
    // without changing navigation behavior.
    staleTimes: { dynamic: 30, static: 180 },
  },
} as NextConfig;

export default nextConfig;
