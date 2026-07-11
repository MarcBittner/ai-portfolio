"use client";

import Link from "next/link";
import { Nav } from "@/app/components/nav";

const STACK: { group: string; items: [string, string][] }[] = [
  {
    group: "Frontend",
    items: [
      ["Next.js 16", "App Router, React Server Components, edge middleware, React Compiler auto-memoization"],
      ["React 19", "SWR-polled fleet views (8s), virtualized long tables"],
      ["Tailwind v4", "CSS-first theme, oklch colors, system-aware dark/light + accent palette"],
    ],
  },
  {
    group: "Control plane & data",
    items: [
      ["MongoDB", "the dashboard's own state — instances, jobs, logs, backups, config — decoupled from the deployments it manages"],
      ["Async job queue", "the API only enqueues; a standalone worker claims each job exactly once and streams logs"],
      ["Idempotent by key", "re-submitting a provision converges to one row (no duplicates on retry / double-submit)"],
    ],
  },
  {
    group: "Managed targets",
    items: [
      ["Vercel", "code deploys per (branch × instance)"],
      ["Convex", "fresh isolated deployments + snapshot import (masked)"],
      ["Clerk", "per-instance auth config + managed test users"],
    ],
  },
  {
    group: "Auth & safety",
    items: [
      ["Clerk or break-glass", "operator sign-in; an offline break-glass login for keyless deploys"],
      ["RBAC + guest tier", "roles gate every mutation; a public read-only guest can view but never change the fleet"],
      ["Kill-switch", "FLOTILLA_PUBLIC_READONLY blocks EVERY mutation for ALL roles on the public showcase"],
    ],
  },
  {
    group: "Hosting & ops",
    items: [
      ["Render", "hosts the Next.js app (standalone Docker image); Vercel is the canonical host for this stack — same code"],
      ["MongoDB Atlas", "the control-plane store (independent of the upstream deployment's own DB)"],
      ["GitHub", "source + CI quality gate (lint · typecheck · test)"],
    ],
  },
];

const PRINCIPLES = [
  "The public showcase is READ-ONLY: the kill-switch blocks provision / refresh / teardown / config-write for everyone.",
  "The demo fleet is synthetic — the ai-portfolio roster rendered as managed instances, no real deploy keys or creds.",
  "Long-running provisioning never touches the request path — it runs in a standalone worker off a Mongo job queue.",
  "Every provision is idempotent on an identity key, so a retried or double-submitted job converges instead of duplicating.",
  "Production is a hard write-block in the engine — the tool refuses to overwrite a production deployment regardless of role.",
  "Health checks are unauthenticated GETs, unaffected by the guest gate or the kill-switch.",
];

export default function About() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <Nav />
      <h1 className="text-lg font-semibold">About flotilla</h1>
      <p className="mb-5 mt-1 text-sm text-[--color-muted]">
        flotilla is an operator console for provisioning, refreshing, and managing preview &amp;
        staging application instances across Vercel + Convex + Clerk — one branch + one backup at
        a time. Consolidated logs, rollback-safe orchestration, reproducible templates, and an async
        job queue keep the fleet observable and safe. This public deploy runs read-only over a
        synthetic demo fleet.
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
        A portfolio demo on the Next.js · MongoDB · Clerk stack ·{" "}
        <Link href="/app" className="text-[--color-accent]">
          dashboard
        </Link>
      </p>
    </main>
  );
}
