"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Download, FileUp, Sparkles, Upload } from "lucide-react";

import { importMarkdownAction, type ImportResult } from "@/app/actions/import";
import { Badge, Button, Card } from "@/app/components/ui";

// Import / Export console — upload Markdown (or a zip of it) into the docs repo,
// and grab download links for any doc/space. The actual import is a server
// action (authorized + committed server-side); this page is just the form.
const EXPORT_FORMATS = ["md", "txt", "zip"] as const;

export default function ImportExportPage() {
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [exportKind, setExportKind] = useState<"space" | "path">("space");
  const [exportKey, setExportKey] = useState("");
  const [exportFormat, setExportFormat] = useState<(typeof EXPORT_FORMATS)[number]>("md");

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      try {
        setResult(await importMarkdownAction(formData));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed.");
      }
    });
  }

  const exportHref =
    exportKey.trim().length === 0
      ? null
      : `/api/export?${exportKind}=${encodeURIComponent(exportKey.trim())}&format=${exportFormat}`;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Import &amp; Export</h1>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---- import ---- */}
        <Card>
          <div className="flex items-center gap-2">
            <Upload size={16} className="text-[--color-accent]" aria-hidden />
            <h2 className="text-sm font-semibold">Import Markdown</h2>
          </div>
          <p className="mt-1 text-sm text-[--color-muted]">
            Upload one or more <code>.md</code> / <code>.mdx</code> files, or a{" "}
            <code>.zip</code> bundle. A destination space prefixes bare paths.
          </p>
          <p className="mt-2 text-sm">
            <Link
              href="/app/ingest"
              className="inline-flex items-center gap-1.5 text-[--color-accent] hover:underline"
            >
              <Sparkles size={14} aria-hidden /> AI Import
            </Link>{" "}
            <span className="text-[--color-muted]">
              — paste a raw email or ClickUp task and let AI clean it into a doc.
            </span>
          </p>

          <form onSubmit={onSubmit} className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="text-[--color-muted]">Destination space (optional)</span>
              <input
                name="destination"
                type="text"
                placeholder="e.g. handbook"
                className="mt-1 w-full rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-2 text-sm"
              />
            </label>

            <label className="block text-sm">
              <span className="text-[--color-muted]">Files</span>
              <input
                name="files"
                type="file"
                multiple
                accept=".md,.mdx,.zip"
                required
                className="mt-1 block w-full text-sm text-[--color-muted] file:mr-3 file:rounded-md file:border file:border-[--color-line] file:bg-[--color-surface] file:px-3 file:py-1.5 file:text-sm file:text-[--color-ink]"
              />
            </label>

            <label className="flex items-start gap-2 rounded-md border border-[--color-line] p-2.5 text-sm">
              <input
                name="categorize"
                type="checkbox"
                value="on"
                defaultChecked
                className="mt-0.5 accent-[--color-accent]"
              />
              <span>
                <span className="font-medium text-[--color-ink]">Auto-categorize with AI</span>
                <span className="block text-xs text-[--color-muted]">
                  File each doc into the best-fit Space and add tags + a one-line
                  summary. Bare files without a destination are routed automatically;
                  an explicit destination always wins.
                </span>
              </span>
            </label>

            <Button type="submit" variant="primary" disabled={pending}>
              <FileUp size={14} aria-hidden />
              {pending ? "Importing…" : "Import"}
            </Button>
          </form>

          {error && (
            <p className="mt-3 text-sm text-[--color-bad]">{error}</p>
          )}

          {result && (
            <div className="mt-4 space-y-3">
              <div className="flex items-center gap-2">
                <Badge tone="ok">{result.imported.length} imported</Badge>
                <Badge tone={result.skipped.length ? "warn" : "muted"}>
                  {result.skipped.length} skipped
                </Badge>
              </div>
              {result.imported.length > 0 && (
                <ul className="space-y-1.5 text-sm text-[--color-ink]">
                  {result.imported.map((p) => {
                    const cat = result.categorized?.[p];
                    return (
                      <li key={p}>
                        <span>{p}</span>
                        {cat && (
                          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                            <Badge tone="accent">{cat.spaceKey}</Badge>
                            <Badge tone="muted">{cat.docType}</Badge>
                            {cat.tags.map((t) => (
                              <span key={t} className="text-[--color-muted]">
                                #{t}
                              </span>
                            ))}
                            <span className="w-full text-[--color-muted]">
                              {cat.summary}
                              <span className="opacity-60"> · via {cat.provider}</span>
                            </span>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {result.skipped.length > 0 && (
                <ul className="space-y-1 text-sm text-[--color-muted]">
                  {result.skipped.map((s) => (
                    <li key={s.path}>
                      <span className="text-[--color-ink]">{s.path}</span> — {s.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>

        {/* ---- export ---- */}
        <Card>
          <div className="flex items-center gap-2">
            <Download size={16} className="text-[--color-accent]" aria-hidden />
            <h2 className="text-sm font-semibold">Export</h2>
          </div>
          <p className="mt-1 text-sm text-[--color-muted]">
            Download a single doc or a whole space. Only docs you can read are
            served.
          </p>

          <div className="mt-4 space-y-3">
            <div className="flex gap-2 text-sm">
              <Button
                type="button"
                variant={exportKind === "space" ? "primary" : "ghost"}
                onClick={() => setExportKind("space")}
              >
                Space
              </Button>
              <Button
                type="button"
                variant={exportKind === "path" ? "primary" : "ghost"}
                onClick={() => setExportKind("path")}
              >
                Single doc
              </Button>
            </div>

            <label className="block text-sm">
              <span className="text-[--color-muted]">
                {exportKind === "space" ? "Space key" : "Doc path"}
              </span>
              <input
                type="text"
                value={exportKey}
                onChange={(e) => setExportKey(e.target.value)}
                placeholder={exportKind === "space" ? "e.g. handbook" : "e.g. handbook/intro.md"}
                className="mt-1 w-full rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-2 text-sm"
              />
            </label>

            <label className="block text-sm">
              <span className="text-[--color-muted]">Format</span>
              <select
                value={exportFormat}
                onChange={(e) =>
                  setExportFormat(e.target.value as (typeof EXPORT_FORMATS)[number])
                }
                className="mt-1 w-full rounded-md border border-[--color-line] bg-[--color-surface] px-3 py-2 text-sm"
              >
                {EXPORT_FORMATS.filter((f) => exportKind === "space" || f !== "zip").map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>

            {exportHref ? (
              <a href={exportHref} className="inline-block">
                <Button type="button" variant="ok">
                  <Download size={14} aria-hidden />
                  Download
                </Button>
              </a>
            ) : (
              <Button type="button" variant="ok" disabled>
                <Download size={14} aria-hidden />
                Download
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
