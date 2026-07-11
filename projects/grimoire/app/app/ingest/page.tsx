import { Sparkles } from "lucide-react";

import { IngestForm } from "@/app/components/ingest-form";

export const dynamic = "force-dynamic";

// AI Import — the self-service ingestion surface. Paste raw Email / ClickUp content;
// the AI cleans it into a structured, categorized doc the user reviews before saving.
export default function IngestPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={20} className="text-[--color-accent]" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight">AI Import</h1>
      </div>
      <p className="mb-6 text-sm text-[--color-muted]">
        Paste an email thread or a ClickUp task; AI cleans it into a structured,
        categorized doc.
      </p>
      <IngestForm />
    </div>
  );
}
