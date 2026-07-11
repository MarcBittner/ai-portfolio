"use client";

// Clerk client widgets, made optional AND lazy.
//
// Two things happen here:
//   1. OPTIONAL — when NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is unset (e.g. the
//      break-glass-only deploy with no Clerk secrets) every widget resolves to a
//      safe no-op so the app still boots and renders the shell instead of
//      crashing on a missing ClerkProvider.
//   2. LAZY — when Clerk IS configured the real widgets (`@clerk/clerk-react`,
//      ~45KB) load via `next/dynamic({ ssr:false })`, so that code lands in its
//      own chunk instead of the shared initial bundle on every route. This
//      console is break-glass-primary; Clerk is the secondary login path, so its
//      widget code shouldn't gate first paint. The real components live in
//      ./clerk-widgets, which is only imported by these dynamic() calls.
//
// Server-side auth is unaffected: middleware.ts / lib/auth.ts verify the Clerk
// session or break-glass cookie on the server and never touch these widgets.

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

export const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
const Empty = () => null;

// Lazy client-only handles to the real Clerk widgets. ssr:false keeps
// @clerk/clerk-react out of the server render AND the initial client chunk;
// each resolves in its own dynamically-imported chunk on first use.
const LazySignedIn = dynamic(() => import("./clerk-widgets").then((m) => m.SignedIn), {
  ssr: false,
});
const LazySignedOut = dynamic(() => import("./clerk-widgets").then((m) => m.SignedOut), {
  ssr: false,
  // While the chunk loads, show the children (the SignInButton) rather than a
  // blank — matches SignedOut's default-visible intent for logged-out users.
  loading: () => null,
});
const LazySignInButton = dynamic(() => import("./clerk-widgets").then((m) => m.SignInButton), {
  ssr: false,
});
const LazyUserButton = dynamic(() => import("./clerk-widgets").then((m) => m.UserButton), {
  ssr: false,
});
const LazyOrganizationSwitcher = dynamic(
  () => import("./clerk-widgets").then((m) => m.OrganizationSwitcher),
  { ssr: false },
);

export const SignedIn = clerkEnabled ? LazySignedIn : Empty;
export const SignedOut = clerkEnabled ? LazySignedOut : Passthrough;
export const SignInButton = clerkEnabled ? LazySignInButton : Passthrough;
export const UserButton = clerkEnabled ? LazyUserButton : Empty;
export const OrganizationSwitcher = clerkEnabled ? LazyOrganizationSwitcher : Empty;
