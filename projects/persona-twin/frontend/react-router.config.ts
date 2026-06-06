import type { Config } from "@react-router/dev/config";

export default {
  // SPA mode: static build, talks to the FastAPI service via /api proxy
  ssr: false,
} satisfies Config;
