"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FilePlus, LayoutTemplate } from "lucide-react";

import { Badge, Button, Card, cn } from "@/app/components/ui";
import { createDocAction } from "@/app/actions/docs";
import { TEMPLATES, getTemplate } from "@/lib/templates";

export default function NewDocPage() {
  const router = useRouter();
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [templateId, setTemplateId] = useState("blank");
  // Track whether the user has hand-edited the content, so switching templates
  // doesn't silently clobber their work.
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function pickTemplate(id: string) {
    const tpl = getTemplate(id);
    if (!tpl) return;
    // Only reseed the editor when it's safe: the box is empty, or it still holds
    // the previously-selected template's untouched body.
    const prev = getTemplate(templateId);
    const safeToReplace = !dirty || content === "" || content === prev?.body;
    setTemplateId(id);
    if (safeToReplace) {
      setContent(tpl.body);
      setDirty(false);
    }
  }

  function onContentChange(value: string) {
    setContent(value);
    setDirty(true);
  }

  function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await createDocAction({ path: path.trim(), content });
      if (res.ok) router.push(`/app/doc/${path.trim()}`);
      else setError(res.error);
    });
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-5 flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <FilePlus size={22} className="text-[--color-accent]" /> New doc
      </h1>
      <Card>
        <form onSubmit={create} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Path</label>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="eng/runbooks/new-thing.md"
              className="w-full rounded-md border border-[--color-line] bg-[color-mix(in_oklch,_var(--color-ink)_3%,_transparent)] px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--color-accent]/40"
            />
            <p className="mt-1 text-xs text-[--color-muted]">
              The top folder is the Space (e.g. <code>eng/…</code>). Must end in .md.
            </p>
          </div>

          <div>
            <label className="mb-1 flex items-center gap-1.5 text-sm font-medium">
              <LayoutTemplate size={15} className="text-[--color-accent]" aria-hidden />
              Start from a template
            </label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {TEMPLATES.map((tpl) => {
                const selected = tpl.id === templateId;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => pickTemplate(tpl.id)}
                    aria-pressed={selected}
                    className={cn(
                      "flex h-full flex-col rounded-md border p-2.5 text-left transition-all duration-150",
                      "hover:-translate-y-px hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--color-accent]/40",
                      selected
                        ? "border-[--color-accent] bg-[--color-accent]/10"
                        : "border-[--color-line] bg-[--color-surface] hover:border-[--color-accent]",
                    )}
                  >
                    <span className="flex items-center justify-between gap-1">
                      <span className="text-sm font-medium text-[--color-ink]">{tpl.name}</span>
                      {selected && <Badge tone="accent">Selected</Badge>}
                    </span>
                    <span className="mt-1 text-xs text-[--color-muted]">{tpl.description}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Content (optional)</label>
            <textarea
              value={content}
              onChange={(e) => onContentChange(e.target.value)}
              placeholder="# Title&#10;&#10;Start writing…"
              className="h-72 w-full resize-y rounded-md border border-[--color-line] bg-[color-mix(in_oklch,_var(--color-ink)_3%,_transparent)] p-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--color-accent]/40"
            />
            <p className="mt-1 text-xs text-[--color-muted]">
              Seeded from the selected template. Edit freely — switching templates
              won&apos;t overwrite your changes.
            </p>
          </div>

          {error && <p className="text-sm text-[--color-bad]">{error}</p>}
          <Button type="submit" variant="primary" disabled={pending || !path.trim()}>
            {pending ? "Creating…" : "Create doc"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
