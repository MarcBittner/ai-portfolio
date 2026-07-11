"use client";

import dynamic from "next/dynamic";
import { SWRConfig } from "swr";

import { clerkEnabled } from "./clerk-shim";

// Global SWR defaults for the poll-heavy dashboard (performance-plan §Area 4).
// Behaviour-preserving safety net, not a result change:
//   • revalidateOnFocus:false — no refetch storm when tabbing back (already set
//     per-hook in useApi; pinned here as the floor).
//   • dedupingInterval — collapse identical in-flight/just-fired requests (e.g. two
//     panels polling the same endpoint) into one fetch.
//   • focusThrottleInterval — cap focus-driven revalidations.
// refreshWhenHidden is left at its SWR default (false) so background tabs pause.
// Deliberately NOT setting keepPreviousData — the per-key loading semantics stay
// exactly as before (this change is throttling only, not a UX behaviour change).
const SWR_DEFAULTS = {
  revalidateOnFocus: false,
  dedupingInterval: 2000,
  focusThrottleInterval: 5000,
} as const;

// ClerkProvider loaded lazily + client-only. This console is break-glass-primary
// (server auth in middleware.ts / lib/auth.ts accepts the break-glass cookie OR a
// Clerk session), so the ~45KB `@clerk/nextjs` client bundle is the *secondary*
// path and shouldn't sit in the shared initial chunk on every route. ssr:false
// keeps it out of the server render and the first client chunk; it hydrates in
// its own dynamically-imported chunk. Server-side Clerk auth is unaffected —
// it never runs through this provider.
const ClerkProvider = dynamic(() => import("@clerk/nextjs").then((m) => m.ClerkProvider), {
  ssr: false,
});

// Data comes from MongoDB via our own /api routes (server-side), so there's no
// reactive-DB provider here — just Clerk for auth + the SWR config. When Clerk
// isn't configured (local/dev with break-glass only) we skip ClerkProvider so the
// app still boots.
export function Providers({ children }: { children: React.ReactNode }) {
  const withSwr = <SWRConfig value={SWR_DEFAULTS}>{children}</SWRConfig>;
  if (!clerkEnabled) return withSwr;
  return <ClerkProvider>{withSwr}</ClerkProvider>;
}
