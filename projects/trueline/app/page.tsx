import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";

const PIPELINE = [
  ["Upload", "Invoice text → Convex storage + a record (mutation)."],
  ["Extract", "An action calls the LLM with a strict JSON schema — per-line confidence + a source quote. The model only reads."],
  ["Verify", "Deterministic code recomputes qty × unit price. The LLM never does math."],
  ["Reconcile", "Match each line to the PO line and the catalog rate (SKU, else fuzzy description); compute variance."],
  ["Flag", "Red / yellow / green + a recoverable-$ estimate vs the lower baseline."],
  ["Review", "A reactive dashboard updates live; an estimator approves / edits / rejects. Edits become labels."],
  ["Eval", "CI scores flag precision/recall on a labeled set before any threshold/model change ships."],
];

const STACK = [
  ["Next.js 16 + React 19", "App Router, server components for the shell, client components for live data. On Vercel."],
  ["Convex", "The backend: reactive queries, transactional mutations, and an action for the external LLM call. No separate API server or SQL DB."],
  ["Clerk", "Auth + multi-tenant organizations + billing. The org id rides in the JWT and scopes every Convex row."],
  ["LLM (Anthropic / free)", "Server-side only. Structured outputs; calculator-verified. Free OpenRouter models by default, Anthropic when a key is set."],
  ["Tailwind v4", "CSS-first theme, oklch colors."],
];

export default function Landing() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-10 flex items-center justify-between">
        <div className="font-semibold tracking-tight">
          <span className="text-[--color-accent]">true</span>line
        </div>
        <div className="flex items-center gap-3 text-sm">
          <SignedOut>
            <SignInButton mode="modal">
              <button className="rounded-lg bg-[--color-accent] px-4 py-2 font-medium text-[--color-accent-ink]">
                Sign in
              </button>
            </SignInButton>
          </SignedOut>
          <SignedIn>
            <Link href="/app" className="rounded-lg bg-[--color-accent] px-4 py-2 font-medium text-[--color-accent-ink]">
              Open workspace
            </Link>
            <UserButton afterSignOutUrl="/" />
          </SignedIn>
        </div>
      </header>

      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
        Catch what's padding the invoice — before you pay it.
      </h1>
      <p className="mt-4 text-[--color-muted]">
        trueline reads a vendor invoice, <strong className="text-[--color-ink]">verifies the math
        in code</strong>, reconciles every line against the purchase order and catalog rates, and
        flags overcharges with a recoverable-dollar estimate — then routes the money-path lines to
        a human. The model reads; deterministic code decides.
      </p>

      <div className="mt-6">
        <SignedOut>
          <SignInButton mode="modal">
            <button className="rounded-lg bg-[--color-accent] px-5 py-2.5 font-medium text-[--color-accent-ink]">
              Sign in to open the workspace →
            </button>
          </SignInButton>
        </SignedOut>
        <SignedIn>
          <Link href="/app" className="rounded-lg bg-[--color-accent] px-5 py-2.5 font-medium text-[--color-accent-ink]">
            Open the workspace →
          </Link>
        </SignedIn>
        <p className="mt-2 text-xs text-[--color-muted]">
          A demo organization is seeded with sample invoices the moment you sign in. Synthetic data only.
        </p>
      </div>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[--color-muted]">
          The verification pipeline
        </h2>
        <ol className="mt-4 space-y-3">
          {PIPELINE.map(([t, d], i) => (
            <li key={t} className="glass flex gap-3 p-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[--color-accent]/15 text-xs font-semibold text-[--color-accent]">
                {i + 1}
              </span>
              <div>
                <div className="font-medium">{t}</div>
                <div className="text-sm text-[--color-muted]">{d}</div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[--color-muted]">
          The stack
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {STACK.map(([t, d]) => (
            <div key={t} className="glass p-3">
              <div className="font-medium">{t}</div>
              <div className="text-sm text-[--color-muted]">{d}</div>
            </div>
          ))}
        </div>
      </section>

      <footer className="mt-12 border-t border-[--color-line] pt-6 text-xs text-[--color-muted]">
        Synthetic, fictional data only. A portfolio project demonstrating the
        Next.js · Convex · Clerk · LLM stack and an extract → verify → reconcile → review → eval loop.
      </footer>
    </main>
  );
}
