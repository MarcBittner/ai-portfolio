"use client";

import Link from "next/link";
import { Nav } from "@/app/components/nav";

const STACK: { group: string; items: [string, string][] }[] = [
  {
    group: "Frontend",
    items: [
      ["Next.js 16", "App Router, React Server Components, server actions, edge middleware"],
      ["React 19", "client components subscribe to live Convex data"],
      ["Tailwind v4", "CSS-first theme, oklch colors"],
    ],
  },
  {
    group: "Backend & data",
    items: [
      ["Convex", "reactive queries · transactional mutations · actions for external I/O · scheduler · typed end-to-end"],
      ["No SQL / no ORM", "the query layer is built in; relationships via document references + explicit indexes"],
    ],
  },
  {
    group: "Auth & tenancy",
    items: [
      ["Clerk", "sign-in, sessions, multi-tenant organizations, billing"],
      ["Clerk → Convex JWT", "the org id rides in the token and scopes every row"],
    ],
  },
  {
    group: "AI / LLM",
    items: [
      ["Anthropic (Claude)", "paid path — best structured-extraction quality"],
      ["OpenRouter free models", "zero-cost default (gemma-4-31b-it:free)"],
      ["Deterministic offline engine", "no-model fallback; runs with zero keys"],
    ],
  },
  {
    group: "Hosting & ops",
    items: [
      ["Render", "hosts the Next.js app (Vercel is the canonical host for this stack — same code)"],
      ["Convex Cloud", "managed backend + database + realtime"],
      ["GitHub", "source + CI quality gate"],
    ],
  },
];

const PRINCIPLES = [
  "The LLM only reads the invoice into structured JSON — it never computes money or decides a flag.",
  "Every total is recomputed and every flag is decided in deterministic code (calculator verifies).",
  "Per-line confidence + a source quote ground every number back to the document.",
  "Extraction runs in a Convex action (the only place external I/O is allowed), idempotent on the invoice id.",
  "The review dashboard is a reactive query — it updates live the instant a run finishes.",
  "Accuracy is measured by an eval (flag precision/recall), not asserted.",
];

export default function About() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <Nav />
      <h1 className="text-lg font-semibold">About trueline</h1>
      <p className="mb-5 mt-1 text-sm text-[--color-muted]">
        Invoice line-item verification: extract → verify the math in code → reconcile against the
        purchase order &amp; market rates → flag recoverable overcharges → human review → eval.
        Synthetic, fictional data only.
      </p>

      <section className="space-y-4">
        {STACK.map((g) => (
          <div key={g.group} className="glass p-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-[--color-muted]">
              {g.group}
            </div>
            <ul className="mt-3 space-y-2">
              {g.items.map(([name, desc]) => (
                <li key={name} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                  <span className="min-w-[180px] font-medium">{name}</span>
                  <span className="text-sm text-[--color-muted]">{desc}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="glass mt-4 p-5">
        <div className="text-xs font-semibold uppercase tracking-wide text-[--color-muted]">
          Design principles
        </div>
        <ul className="mt-3 space-y-2 text-sm text-[--color-muted]">
          {PRINCIPLES.map((p) => (
            <li key={p} className="flex gap-2">
              <span className="text-[--color-accent]">▸</span>
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-6 text-center text-xs text-[--color-muted]">
        A portfolio demo on the Next.js · Convex · Clerk · LLM stack ·{" "}
        <Link href="/" className="text-[--color-accent]">
          landing
        </Link>
      </p>
    </main>
  );
}
