"use client";

import { useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Search as SearchIcon, Sparkles } from "lucide-react";

import { Badge, Button, Card } from "@/app/components/ui";
import { searchAction } from "@/app/actions/search";
import { askAction, type AskResponse } from "@/app/actions/ask";
import type { SearchResult } from "@/lib/search";

type Mode = "search" | "ask";

export default function SearchPage() {
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>(params.get("mode") === "ask" ? "ask" : "search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [pending, start] = useTransition();

  function run(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      if (mode === "ask") {
        setAnswer(await askAction(query));
        setResults(null);
      } else {
        setResults(await searchAction(query));
        setAnswer(null);
      }
    });
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{mode === "ask" ? "Ask the docs" : "Search"}</h1>
        <div className="ml-auto flex gap-2">
          <Button variant={mode === "search" ? "primary" : "ghost"} onClick={() => setMode("search")}>
            <SearchIcon size={14} /> Search
          </Button>
          <Button variant={mode === "ask" ? "primary" : "ghost"} onClick={() => setMode("ask")}>
            <Sparkles size={14} /> Ask
          </Button>
        </div>
      </div>

      <form onSubmit={run} className="mb-6 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === "ask" ? "Ask a question about the docs…" : "Search docs (keyword + semantic)…"}
          aria-label={mode === "ask" ? "Ask a question" : "Search docs"}
          className="w-full rounded-md border border-[--color-line] bg-[color-mix(in_oklch,_var(--color-ink)_3%,_transparent)] px-3 py-2 text-sm text-[--color-ink] placeholder:text-[--color-muted] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--color-accent]/40"
        />
        <Button type="submit" variant="primary" disabled={pending || !query.trim()}>
          {pending ? "…" : mode === "ask" ? "Ask" : "Search"}
        </Button>
      </form>

      {/* Ask-the-docs answer */}
      {answer && (
        <Card>
          <div className="prose-doc">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
              {answer.answer}
            </ReactMarkdown>
          </div>
          {answer.sources.length > 0 && (
            <div className="mt-4 border-t border-[--color-line] pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[--color-muted]">Sources</p>
              <ol className="space-y-1 text-sm">
                {answer.sources.map((s) => (
                  <li key={s.path} className="flex items-center gap-2">
                    <Badge tone="accent">{s.n}</Badge>
                    <Link href={`/app/doc/${s.path}`} className="text-[--color-ink] hover:text-[--color-accent]">
                      {s.title}
                    </Link>
                    {s.headingPath && <span className="text-xs text-[--color-muted]">› {s.headingPath}</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
          <p className="mt-3 text-xs text-[--color-muted]">answered via {answer.provider}</p>
        </Card>
      )}

      {/* Search results */}
      {results !== null && (
        <>
          <p className="mb-3 text-sm text-[--color-muted]">
            {results.length} result{results.length === 1 ? "" : "s"}
          </p>
          <div className="space-y-3">
            {results.map((r) => (
              <Card key={r.path}>
                <div className="flex items-center gap-2">
                  <Link href={`/app/doc/${r.path}`} className="text-sm font-semibold text-[--color-ink] hover:text-[--color-accent]">
                    {r.title}
                  </Link>
                  <Badge tone="muted">{r.spaceKey}</Badge>
                  <Badge tone={r.kind === "semantic" ? "accent" : "ok"}>{r.kind}</Badge>
                </div>
                <p className="mt-1.5 text-sm text-[--color-muted]">{r.snippet}</p>
              </Card>
            ))}
            {results.length === 0 && <p className="text-sm text-[--color-muted]">No matches.</p>}
          </div>
        </>
      )}
    </div>
  );
}
