"use client";

import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";

import { clerkEnabled } from "./clerk-shim";

// Clerk mints a JWT (the "convex" template) → ConvexProviderWithClerk passes it
// on every request → Convex validates it (auth.config.ts) → functions read the
// identity via ctx.auth. One client for the app; the URL is injected at deploy.
const convex = new ConvexReactClient(
  process.env.NEXT_PUBLIC_CONVEX_URL || "https://placeholder.convex.cloud",
);

// Stub auth for the public demo (no Clerk secrets): always unauthenticated, so
// useConvexAuth() resolves and gated /app pages render their signed-out state
// instead of the app crashing for lack of an auth-integrated Convex provider.
function useNoAuth() {
  return {
    isLoading: false,
    isAuthenticated: false,
    fetchAccessToken: async () => null,
  };
}

export function Providers({ children }: { children: React.ReactNode }) {
  if (!clerkEnabled) {
    return (
      <ConvexProviderWithAuth client={convex} useAuth={useNoAuth}>
        {children}
      </ConvexProviderWithAuth>
    );
  }
  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        {children}
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
