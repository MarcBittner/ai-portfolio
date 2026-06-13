"use client";

import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";

// Clerk mints a JWT (the "convex" template) → ConvexProviderWithClerk passes it
// on every request → Convex validates it (auth.config.ts) → functions read the
// identity via ctx.auth. One client for the app; the URL is injected at deploy.
const convex = new ConvexReactClient(
  process.env.NEXT_PUBLIC_CONVEX_URL || "https://placeholder.convex.cloud",
);

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        {children}
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
