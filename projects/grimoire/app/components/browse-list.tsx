"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpDown, FileText, Search, Tag, User } from "lucide-react";

import type { BrowseDoc } from "@/app/actions/browse";
import { Badge, Card, cn } from "@/app/components/ui";

type SortKey = "title" | "updated";

// Relative timestamp, e.g. "3m ago" / "2d ago". Mirrors the activity page.
function relativeTime(at: number): string {
  if (!at) return "unknown";
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  const mins = Math.round(secs / 60);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

const STATUS_TONE: Record<string, "accent" | "ok" | "warn" | "muted"> = {
  published: "ok",
  draft: "warn",
  imported: "accent",
  archived: "muted",
};

const selectCls =
  "rounded-md border border-[--color-line] bg-[--color-surface] px-2.5 py-2 text-sm text-[--color-ink]";

/** Unique, sorted values of a doc field (skipping empties). */
function uniqueValues(docs: BrowseDoc[], pick: (d: BrowseDoc) => string | undefined): string[] {
  const set = new Set<string>();
  for (const d of docs) {
    const v = pick(d);
    if (v) set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function BrowseList({ docs }: { docs: BrowseDoc[] }) {
  const [query, setQuery] = useState("");
  const [space, setSpace] = useState("");
  const [status, setStatus] = useState("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState<SortKey>("title");

  const spaces = useMemo(() => uniqueValues(docs, (d) => d.spaceKey), [docs]);
  const statuses = useMemo(() => uniqueValues(docs, (d) => d.status), [docs]);
  const tags = useMemo(
    () =>
      Array.from(new Set(docs.flatMap((d) => d.tags ?? []))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [docs],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = docs.filter((d) => {
      if (q && !d.title.toLowerCase().includes(q) && !d.path.toLowerCase().includes(q)) {
        return false;
      }
      if (space && d.spaceKey !== space) return false;
      if (status && d.status !== status) return false;
      if (tag && !(d.tags ?? []).includes(tag)) return false;
      return true;
    });
    out.sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title)
        : b.updatedAt - a.updatedAt,
    );
    return out;
  }, [docs, query, space, status, tag, sort]);

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative flex-1 basis-56">
          <Search
            size={15}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[--color-muted]"
            aria-hidden
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title or path…"
            aria-label="Filter docs"
            className="w-full rounded-md border border-[--color-line] bg-[--color-surface] py-2 pl-8 pr-3 text-sm text-[--color-ink]"
          />
        </label>

        <select
          value={space}
          onChange={(e) => setSpace(e.target.value)}
          aria-label="Filter by space"
          className={selectCls}
        >
          <option value="">All spaces</option>
          {spaces.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        {statuses.length > 0 && (
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by status"
            className={selectCls}
          >
            <option value="">Any status</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}

        {tags.length > 0 && (
          <select
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            aria-label="Filter by tag"
            className={selectCls}
          >
            <option value="">Any tag</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                #{t}
              </option>
            ))}
          </select>
        )}

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort docs"
          className={cn(selectCls, "inline-flex items-center gap-1")}
        >
          <option value="title">Title A–Z</option>
          <option value="updated">Recently updated</option>
        </select>
      </div>

      <div className="mb-3 flex items-center gap-2 text-xs text-[--color-muted]">
        <ArrowUpDown size={13} aria-hidden />
        {visible.length} of {docs.length} {docs.length === 1 ? "doc" : "docs"}
      </div>

      {visible.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-12 text-center">
          <FileText size={22} className="text-[--color-muted]" aria-hidden />
          <p className="text-sm text-[--color-muted]">
            {docs.length === 0
              ? "No docs you can read yet."
              : "No docs match these filters."}
          </p>
        </Card>
      ) : (
        <ul className="grid gap-2.5 sm:grid-cols-2">
          {visible.map((d) => {
            const tone = d.status ? STATUS_TONE[d.status] ?? "muted" : "muted";
            return (
              <li key={d.path}>
                <Link href={`/app/doc/${d.path}`} prefetch className="block h-full">
                  <Card className="h-full transition-colors hover:border-[--color-accent]">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="min-w-0 font-medium text-[--color-ink]">
                        <span className="line-clamp-2">{d.title}</span>
                      </h3>
                      <Badge tone="accent" className="shrink-0">
                        {d.spaceKey}
                      </Badge>
                    </div>

                    {d.summary && (
                      <p className="mt-1 line-clamp-2 text-sm text-[--color-muted]">
                        {d.summary}
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-[--color-muted]">
                      {d.status && <Badge tone={tone}>{d.status}</Badge>}
                      {(d.tags ?? []).slice(0, 4).map((t) => (
                        <span key={t} className="inline-flex items-center gap-0.5">
                          <Tag size={11} aria-hidden /> {t}
                        </span>
                      ))}
                    </div>

                    <div className="mt-3 flex items-center gap-3 border-t border-[--color-line] pt-2 text-xs text-[--color-muted]">
                      <span>updated {relativeTime(d.updatedAt)}</span>
                      {d.owner && (
                        <span className="inline-flex items-center gap-1">
                          <User size={11} aria-hidden /> {d.owner}
                        </span>
                      )}
                    </div>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
