import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// The workspace lives under /app and is gated; everything else (the marketing
// landing) is public so reviewers can read what the product does before signing
// in. This is Clerk running at the edge per-request.
//
// When Clerk isn't configured (e.g. the public demo with no auth secrets), run a
// passthrough instead — so the app boots and serves the landing page rather than
// 500-ing on every request because clerkMiddleware has no keys.
const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const isProtected = createRouteMatcher(["/app(.*)"]);

export default clerkEnabled
  ? clerkMiddleware(async (auth, req) => {
      if (isProtected(req)) await auth.protect();
    })
  : function middleware() {
      return NextResponse.next();
    };

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/", "/(api|trpc)(.*)"],
};
