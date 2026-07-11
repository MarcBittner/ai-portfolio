"use client";

import { ClerkProvider } from "@clerk/nextjs";

import { clerkEnabled } from "./clerk-shim";

// Clerk is the app's only client provider. Persistence is the Mongo / in-memory
// store (lib/db) accessed via server actions, so there's no client-side data
// provider to mount here.
//
// Zero-key boot path preserved: with no Clerk publishable key, clerkEnabled is
// false and Providers is a passthrough, so /app still boots + renders its
// signed-out state (see app/clerk-shim.tsx).
export function Providers({ children }: { children: React.ReactNode }) {
  if (!clerkEnabled) return <>{children}</>;
  return <ClerkProvider>{children}</ClerkProvider>;
}
