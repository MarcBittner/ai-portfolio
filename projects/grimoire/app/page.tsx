import Link from "next/link";
import { BookOpen, GitCommitHorizontal, Sparkles, Users } from "lucide-react";

import { Button, Card } from "./components/ui";

const FEATURES = [
  {
    icon: BookOpen,
    title: "Curated library + your notes",
    body: "Read a curated public knowledge base, then keep your own personal notes alongside it — WYSIWYG or raw Markdown, round-tripped losslessly.",
  },
  {
    icon: GitCommitHorizontal,
    title: "Versioned, invisibly",
    body: "Every save is a commit behind the scenes. You just see Save and a plain version history.",
  },
  {
    icon: Users,
    title: "Auth + RBAC, per-user spaces",
    body: "Clerk sign-in with role-based access — Read-Only / Editor / Admin / Super Admin — and a private space that's yours alone.",
  },
  {
    icon: Sparkles,
    title: "RAG search + AI that helps",
    body: "Semantic ask-the-docs answers with citations, plus draft, expand, and proofread — all review-then-apply.",
  },
];

export default function Landing() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header className="mb-12">
        <span className="text-sm font-medium tracking-wide text-[--color-accent]">
          offline-first knowledge base
        </span>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight sm:text-5xl">
          <span className="text-[--color-accent]">Grimoire</span>
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-[--color-muted]">
          An offline-first, self-hostable knowledge base for AI — sign in, read a
          curated library, and keep your own notes. Markdown is the source of
          truth; the app adds WYSIWYG editing, per-user spaces, RBAC, and RAG
          search, all without anyone needing to touch Git.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link href="/app">
            <Button variant="primary">Open the library</Button>
          </Link>
          <Link href="/app/about">
            <Button variant="ghost">What is this?</Button>
          </Link>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <Card key={title}>
            <Icon size={20} className="text-[--color-accent]" aria-hidden />
            <h2 className="mt-3 text-base font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-[--color-muted]">{body}</p>
          </Card>
        ))}
      </section>

      <footer className="mt-14 text-xs text-[--color-muted]">
        Next.js · Clerk · MongoDB · Tailwind v4.
      </footer>
    </main>
  );
}
