import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";

// Inlined (not imported from lib/breakglass) because middleware runs on the Edge
// runtime, which can't load that module's `node:crypto` dependency. Keep in sync
// with BREAKGLASS_COOKIE in lib/breakglass.ts.
const BREAKGLASS_COOKIE = "bg_session";

// Header the route layer's withOperator (lib/api.ts) reads to hard-reject the
// public `guest` tier from any non-safe (mutating) method. Middleware is the ONE
// place with reliable access to req.method for every request, so it stamps it here.
// withOperator FAILS CLOSED for guests when this header is absent, so this is a
// convenience/robustness signal — never the sole guard.
const REQ_METHOD_HEADER = "x-flotilla-method";

// Public read-only tier (see lib/auth.ts). When on, an UNAUTHENTICATED visitor is
// allowed to reach /app (and the read APIs) as a view-only guest instead of being
// bounced to a login. The route layer (withOperator) still hard-blocks every guest
// mutation server-side, so this only widens READ visibility. Parsed permissively.
function publicReadonlyEnabled(): boolean {
  const v = (process.env.FLOTILLA_PUBLIC_READONLY || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// The workspace lives under /app and is gated; the landing/login are public.
//
// Two auth modes:
//  • Clerk configured → clerkMiddleware protects /app.
//  • No Clerk (our break-glass deploy) → gate /app on the presence of the
//    break-glass session cookie and bounce to /breakglass otherwise. Without
//    this, an un-logged-in visitor lands on /app and sees EMPTY tables (the API
//    returns nothing without a session) instead of being asked to log in.
// Either way, `/` redirects straight into the app so the bare URL just works.
//
// PUBLIC read-only tier: when FLOTILLA_PUBLIC_READONLY is on, /app is NOT gated — an
// unauthenticated visitor is allowed through as a guest (view-only). The route
// layer enforces the mutation block; middleware just stops bouncing them to login.
const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const isProtected = createRouteMatcher(["/app(.*)"]);

// Attach the request-method header so the response carries it into the route
// handler. Returned everywhere we `next()` so every route sees x-flotilla-method.
function withMethodHeader(req: NextRequest): NextResponse {
  const headers = new Headers(req.headers);
  headers.set(REQ_METHOD_HEADER, req.method);
  return NextResponse.next({ request: { headers } });
}

export default clerkEnabled
  ? clerkMiddleware(async (auth, req) => {
      if (req.nextUrl.pathname === "/") {
        return NextResponse.redirect(new URL("/app", req.url));
      }
      if (isProtected(req) && !publicReadonlyEnabled()) {
        // Allow the break-glass path (Marc's offline login) alongside Clerk:
        // if the break-glass cookie is present, let the route's own guard
        // (getPrincipal) validate it; otherwise require a Clerk session and
        // redirect to our in-app /sign-in explicitly (auth.protect() 404s here
        // without an inferable sign-in URL).
        // Skipped entirely when the public read-only tier is on: a visitor may
        // reach /app as a guest, and the route layer blocks every guest mutation.
        if (!req.cookies.get(BREAKGLASS_COOKIE)) {
          const { userId } = await auth();
          if (!userId) {
            const url = new URL("/sign-in", req.url);
            return NextResponse.redirect(url);
          }
        }
      }
      return withMethodHeader(req);
    })
  : function middleware(req: NextRequest) {
      const { pathname } = req.nextUrl;
      if (pathname === "/") {
        return NextResponse.redirect(new URL("/app", req.url));
      }
      if (
        pathname.startsWith("/app") &&
        !publicReadonlyEnabled() &&
        !req.cookies.get(BREAKGLASS_COOKIE)
      ) {
        const url = new URL("/breakglass", req.url);
        url.searchParams.set("next", pathname);
        return NextResponse.redirect(url);
      }
      return withMethodHeader(req);
    };

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/", "/(api|trpc)(.*)"],
};
