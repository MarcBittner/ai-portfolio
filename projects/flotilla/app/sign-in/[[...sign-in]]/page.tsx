import { SignIn } from "@clerk/nextjs";

// Clerk sign-in target (NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in). auth.protect()
// bounces un-authenticated visitors here. Access is further gated by the email
// allowlist in lib/auth.ts, so signing in ≠ getting in unless you're a named
// operator. Marc's break-glass path stays available via the link below.
export default function SignInPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-16">
      <h1 className="mb-1 text-xl font-semibold tracking-tight">
        i<span className="text-[--color-accent]">·</span>dash
      </h1>
      <p className="mb-6 text-xs text-[--color-muted]">Sign in with your account.</p>
      <SignIn
        signUpUrl="/sign-in"
        fallbackRedirectUrl="/app"
        forceRedirectUrl="/app"
        appearance={{ elements: { footer: { display: "none" } } }}
      />
      <a href="/breakglass" className="mt-6 text-xs text-[--color-muted] underline decoration-dotted">
        operator break-glass login
      </a>
    </main>
  );
}
