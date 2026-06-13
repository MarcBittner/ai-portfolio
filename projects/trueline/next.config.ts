import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Convex codegen runs at build time on Vercel via:
  //   npx convex deploy --cmd 'npm run build'
  // which sets NEXT_PUBLIC_CONVEX_URL for the client bundle.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
