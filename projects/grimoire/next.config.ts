import type { NextConfig } from "next";

// `output: "standalone"` keeps the self-hosted Docker image small AND keeps the
// build portable: Vercel ignores it (native build), Docker/Render uses it — so
// Grimoire is self-hostable anywhere while staying Vercel-portable.
const nextConfig: NextConfig = {
  // standalone only for self-hosting (Render/Docker). Vercel builds natively and
  // doesn't want it, so omit it there (process.env.VERCEL is set on Vercel).
  ...(process.env.VERCEL ? {} : { output: "standalone" }),
  // Tree-shake barrel-file icon imports so only the icons actually used ship,
  // instead of the whole lucide-react module graph.
  experimental: { optimizePackageImports: ["lucide-react"] },
} as NextConfig;

export default nextConfig;
