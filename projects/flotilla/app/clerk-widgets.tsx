"use client";

// The REAL Clerk client widgets, isolated here so `next/dynamic` can pull them
// into their own lazy chunk instead of the shared initial bundle. This console
// is break-glass-primary (see lib/breakglass.ts) — Clerk is the *secondary*
// login path — so the ~45KB of `@clerk/clerk-react` widget code has no business
// on the first paint of every route. `clerk-shim.tsx` lazy-loads these; when
// Clerk isn't configured the shim resolves to no-ops and never imports this file.
//
// Server-side auth is untouched: `middleware.ts` and `lib/auth.ts` read the
// Clerk session / break-glass cookie on the server and do NOT depend on any of
// these client widgets.

export {
  OrganizationSwitcher,
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
} from "@clerk/nextjs";
