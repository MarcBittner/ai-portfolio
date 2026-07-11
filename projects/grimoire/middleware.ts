import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// The workspace lives under /app and is gated; everything else (the landing) is
// public. When Clerk isn't configured (zero-key boot / no auth secrets), run a
// passthrough so the app boots and serves the landing instead of 500-ing on every
// request because clerkMiddleware has no keys.
const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

// Clerk provides auth *context* on every request, but does NOT force sign-in —
// /app is browsable signed-out (anonymous read-only); signing in unlocks the
// user's RBAC role (edit/admin). So the Sign in button is optional, not a gate.
export default clerkEnabled
  ? clerkMiddleware()
  : function middleware() {
      return NextResponse.next();
    };

export const config = {
  // Run Clerk on ALL /app routes — including doc paths that end in ".md". The
  // old "exclude anything with a dot" matcher skipped doc pages, so currentUser()
  // was null there and every doc 404'd even when signed in.
  matcher: ["/app/:path*", "/(api|trpc)(.*)"],
};
