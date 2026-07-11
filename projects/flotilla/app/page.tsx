import Link from "next/link";
import { buttonCls } from "./components/ui";

// Public landing. The real tool lives under /app (Clerk-gated by middleware).
export default function Landing() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">
        i<span className="text-[--color-accent]">·</span>dash
      </h1>
      <p className="mt-3 max-w-xl text-sm text-[--color-muted]">
        Provision, refresh, and manage preview &amp; staging app instances across
        Vercel + Convex + Clerk — one branch + one backup at a time. Consolidated
        logs, rollback-safe orchestration, reproducible templates.
      </p>
      <div className="mt-6">
        <Link href="/app" className={buttonCls("primary")}>
          Open dashboard →
        </Link>
      </div>
    </main>
  );
}
