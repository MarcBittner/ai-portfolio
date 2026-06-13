import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// The workspace lives under /app and is gated; everything else (the marketing
// landing) is public so reviewers can read what the product does before signing
// in. This is Clerk running at the edge per-request.
const isProtected = createRouteMatcher(["/app(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) await auth.protect();
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/", "/(api|trpc)(.*)"],
};
