import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("chat", "routes/chat.tsx"),
  route("console", "routes/routing.tsx"),
  route("analytics", "routes/analytics.tsx"),
] satisfies RouteConfig;
