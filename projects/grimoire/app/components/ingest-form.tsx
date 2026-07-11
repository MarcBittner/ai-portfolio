"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail, Save, Sparkles, SquareKanban } from "lucide-react";

import {
  previewIngest,
  commitIngest,
  type IngestPreview,
} from "@/app/actions/ingest";
import type { IngestSource } from "@/lib/ai/clean";
import { Badge, Button, Card } from "@/app/components/ui";

const inputCls =
  "mt-1 w-full rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-2 text-sm";

// AI Import console — paste an email thread or a task/ticket, let the AI clean it
// into a structured, categorized doc, review/tweak the result, then commit. The
// conversion + save are server actions (authorized + committed server-side); this
// is just the form + review UI.
export function IngestForm() {
  const router = useRouter();
  const [source, setSource] = useState<IngestSource>("email");
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState<IngestPreview | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [destination, setDestination] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [converting, startConvert] = useTransition();
  const [saving, startSave] = useTransition();

  function onConvert() {
    setError(null);
    startConvert(async () => {
      try {
        const result = await previewIngest(source, raw);
        setPreview(result);
        setMarkdown(result.markdown);
        setDestination(result.spaceKey);
      } catch (err) {
        setPreview(null);
        setError(err instanceof Error ? err.message : "Conversion failed.");
      }
    });
  }

  function onSave() {
    if (!preview) return;
    setError(null);
    startSave(async () => {
      try {
        const res = await commitIngest({
          source,
          markdown,
          title: preview.title,
          destination: destination.trim() || undefined,
        });
        if (res.ok && res.path) {
          router.push(`/app/doc/${res.path}`);
        } else {
          setError(res.error ?? "Save failed.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-[--color-accent]" aria-hidden />
          <h2 className="text-sm font-semibold">Paste content</h2>
        </div>

        <div className="mt-3 flex gap-2 text-sm">
          <Button
            type="button"
            variant={source === "email" ? "primary" : "ghost"}
            onClick={() => setSource("email")}
          >
            <Mail size={14} aria-hidden /> Email
          </Button>
          <Button
            type="button"
            variant={source === "clickup" ? "primary" : "ghost"}
            onClick={() => setSource("clickup")}
          >
            <SquareKanban size={14} aria-hidden /> Task
          </Button>
        </div>

        <label className="mt-3 block text-sm">
          <span className="text-[--color-muted]">
            {source === "email"
              ? "Paste the raw email thread (quotes / signatures get stripped)"
              : "Paste the task / ticket (title, description, comments, status)"}
          </span>
          <textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={12}
            placeholder={source === "email" ? "From: …\nSubject: …\n\n…" : "Task: …\nStatus: …\n\nDescription: …"}
            className={`${inputCls} font-mono`}
          />
        </label>

        <div className="mt-3">
          <Button type="button" variant="primary" onClick={onConvert} disabled={converting || !raw.trim()}>
            <Sparkles size={14} aria-hidden />
            {converting ? "Converting…" : "Convert with AI"}
          </Button>
        </div>

        {error && !preview && <p className="mt-3 text-sm text-[--color-bad]">{error}</p>}
      </Card>

      {preview && (
        <Card>
          <div className="flex items-center gap-2">
            <Save size={16} className="text-[--color-accent]" aria-hidden />
            <h2 className="text-sm font-semibold">Review &amp; save</h2>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
            <Badge tone="accent">{preview.spaceKey}</Badge>
            {preview.tags.map((t) => (
              <span key={t} className="text-[--color-muted]">
                #{t}
              </span>
            ))}
            <span className="opacity-60">· via {preview.provider}</span>
          </div>
          {preview.summary && (
            <p className="mt-1.5 text-sm text-[--color-muted]">{preview.summary}</p>
          )}

          <label className="mt-3 block text-sm">
            <span className="text-[--color-muted]">Cleaned Markdown (editable)</span>
            <textarea
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              rows={16}
              className={`${inputCls} font-mono`}
            />
          </label>

          <label className="mt-3 block text-sm">
            <span className="text-[--color-muted]">Destination space (override)</span>
            <input
              type="text"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="e.g. handbook"
              className={inputCls}
            />
          </label>

          <div className="mt-3">
            <Button type="button" variant="ok" onClick={onSave} disabled={saving || !markdown.trim()}>
              <Save size={14} aria-hidden />
              {saving ? "Saving…" : "Save doc"}
            </Button>
          </div>

          {error && <p className="mt-3 text-sm text-[--color-bad]">{error}</p>}
        </Card>
      )}
    </div>
  );
}
