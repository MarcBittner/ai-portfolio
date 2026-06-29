"use client";

// Clerk, made optional. When NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is set the real
// Clerk components are used; when it isn't (e.g. the public demo with no auth
// secrets) these resolve to safe no-ops so the app still boots and renders the
// landing + shell instead of crashing on every request. Inlined at build time.

import {
  OrganizationSwitcher as COrganizationSwitcher,
  SignedIn as CSignedIn,
  SignedOut as CSignedOut,
  SignInButton as CSignInButton,
  UserButton as CUserButton,
} from "@clerk/nextjs";
import type { ReactNode } from "react";

export const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
const Empty = () => null;

export const SignedIn = clerkEnabled ? CSignedIn : Empty;
export const SignedOut = clerkEnabled ? CSignedOut : Passthrough;
export const SignInButton = clerkEnabled ? CSignInButton : Passthrough;
export const UserButton = clerkEnabled ? CUserButton : Empty;
export const OrganizationSwitcher = clerkEnabled ? COrganizationSwitcher : Empty;
