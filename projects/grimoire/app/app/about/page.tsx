import { Card } from "@/app/components/ui";

export default function AboutPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">About Grimoire</h1>
      <Card>
        <p className="text-sm leading-relaxed text-[--color-muted]">
          Grimoire is an offline-first, self-hostable knowledge base for AI. Sign in,
          read a <strong className="text-[--color-ink]">curated public library</strong>,
          and keep your own personal notes alongside it. Markdown is the source of
          truth and every change is a commit — but the Git layer is invisible to
          users. The app provides WYSIWYG and raw editing, four-level RBAC with custom
          scopes and per-user spaces, import/conversion (docx/PDF → Markdown), and AI
          assistance (drafting, proofing, and RAG-powered Ask-the-docs with citations).
        </p>
        <p className="mt-3 text-sm leading-relaxed text-[--color-muted]">
          New users self-sign-up as guests — read the public library and edit their own
          notes. Built on Next.js, Clerk, MongoDB, and Tailwind v4, with a standardized
          design system and LLM fallback routing. It boots with zero keys, so you can
          run it entirely offline against an in-memory store.
        </p>
      </Card>
    </div>
  );
}
