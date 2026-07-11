"use client";

import { useState, useTransition } from "react";
import { Check, Lightbulb, X } from "lucide-react";

import { submitSuggestion } from "@/app/actions/suggestions";
import { Button, Card } from "./ui";

/** Lightweight suggestion editor — a plain source textarea seeded with the doc's
 *  raw markdown plus a short note. Intentionally NOT the full WYSIWYG editor: kept
 *  simple and robust so any reader can propose a change. Submit gates through the
 *  permission-checked `submitSuggestion` server action. */
export function SuggestPanel({
  path,
  initialContent,
  baseSha,
  onDone,
}: {
  path: string;
  initialContent: string;
  baseSha: string;
  onDone: () => void;
}) {
  const [content, setContent] = useState(initialContent);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await submitSuggestion(path, content, note, baseSha);
      if (res.ok) {
        setDone(true);
        onDone();
      } else {
        setError(res.error ?? "Could not submit your suggestion.");
      }
    });
  }

  if (done) {
    return (
      <Card className="flex items-center gap-2 text-sm text-[--color-ink]">
        <Check size={16} className="text-[--color-ok]" />
        Suggestion submitted — an editor will review it.
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium text-[--color-ink]">
        <Lightbulb size={16} className="text-[--color-accent]" />
        Suggest an edit
      </div>
      <p className="text-xs text-[--color-muted]">
        Edit the source below and describe your change. Someone with edit access will
        review and apply it.
      </p>

      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What are you proposing?"
        className="w-full rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-2 text-sm text-[--color-ink] placeholder:text-[--color-muted] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--color-accent]/50"
      />

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        rows={18}
        className="w-full resize-y rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-2 font-mono text-xs leading-relaxed text-[--color-ink] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--color-accent]/50"
      />

      {error && <p className="text-xs text-[--color-bad]">{error}</p>}

      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={submit} disabled={pending}>
          <Check size={14} /> {pending ? "Submitting…" : "Submit suggestion"}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          <X size={14} /> Cancel
        </Button>
      </div>
    </Card>
  );
}
