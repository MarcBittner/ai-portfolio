"use client";

// TODO(lead): pass docPath={doc.path} from doc/[...path]/page.tsx

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { ListTree, Sparkles, MessageSquare, CornerDownLeft, Link2, History, GitBranch } from "lucide-react";

import { cn } from "./ui";
import { Comments } from "./comments";
import { VersionHistory } from "./version-history";
import { askAction, type AskResponse } from "@/app/actions/ask";
import { getBacklinks } from "@/app/actions/backlinks";
import { getDocHistory, type HistoryItem } from "@/app/actions/history";

export interface TocItem {
  depth: number;
  text: string;
  slug: string;
}

type Tab = "toc" | "ask" | "comments" | "versions";

function Toc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    if (items.length === 0) return;
    const els = items
      .map((i) => document.getElementById(i.slug))
      .filter((e): e is HTMLElement => !!e);
    if (els.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        // The topmost heading currently intersecting the upper band wins.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-72px 0px -70% 0px", threshold: 0 },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [items]);

  if (items.length === 0) {
    return <p className="px-2 py-3 text-xs text-[--color-muted]">No headings in this document.</p>;
  }
  return (
    <ul className="space-y-px py-1">
      {items.map((i) => (
        <li key={i.slug}>
          <a
            href={`#${i.slug}`}
            className={cn(
              "block truncate rounded-md border-l-2 py-1 pr-2 text-sm transition-colors",
              i.depth >= 3 ? "pl-6" : "pl-3",
              active === i.slug
                ? "border-[--color-accent] bg-[--color-accent]/10 text-[--color-accent]"
                : "border-transparent text-[--color-muted] hover:text-[--color-ink]",
            )}
          >
            {i.text}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Inbound links ("linked from"): OTHER docs that reference this one, so the wiki
 *  is navigable in both directions. Permission-scoped by the server action — only
 *  docs the viewer can read are ever returned. */
function Backlinks({ docPath }: { docPath: string }) {
  // Keep the resolved path alongside the result so `loaded` derives from state
  // (no synchronous reset in the effect) and stale results are ignored on nav.
  const [state, setState] = useState<{ path: string; links: { path: string; title: string }[] } | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    getBacklinks(docPath)
      .then((res) => {
        if (alive) setState({ path: docPath, links: res });
      })
      .catch(() => {
        if (alive) setState({ path: docPath, links: [] });
      });
    return () => {
      alive = false;
    };
  }, [docPath]);

  // Stay quiet until we've resolved backlinks for THIS doc; then show the section.
  if (!state || state.path !== docPath) return null;
  const links = state.links;

  return (
    <div className="mt-2 border-t border-[--color-line] px-2 py-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[--color-muted]">
        <Link2 size={12} /> Linked from
      </p>
      {links.length === 0 ? (
        <p className="text-xs text-[--color-muted]">No backlinks.</p>
      ) : (
        <ul className="space-y-1">
          {links.map((l) => (
            <li key={l.path} className="text-sm">
              <Link
                href={`/app/doc/${l.path}`}
                className="block truncate text-[--color-muted] transition-colors hover:text-[--color-accent]"
              >
                {l.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Tiny dependency-free relative-time formatter (e.g. "just now", "2h ago"). */
function relativeTime(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** Human label for an audit action on a doc. */
function actionLabel(action: string): string {
  switch (action) {
    case "doc.create":
      return "created";
    case "doc.update":
      return "edited";
    case "doc.delete":
      return "deleted";
    case "doc.restore":
      return "restored";
    default:
      return action.replace(/^doc\./, "");
  }
}

/** Compact change timeline for this doc, from the audit log. Permission-scoped by
 *  the server action — only returns history when the viewer can read the doc. */
function DocHistory({ docPath }: { docPath: string }) {
  // Keep the resolved path alongside the result so `loaded` derives from state
  // (no synchronous reset in the effect) and stale results are ignored on nav.
  const [state, setState] = useState<{ path: string; items: HistoryItem[] } | null>(null);

  useEffect(() => {
    let alive = true;
    getDocHistory(docPath)
      .then((items) => {
        if (alive) setState({ path: docPath, items });
      })
      .catch(() => {
        if (alive) setState({ path: docPath, items: [] });
      });
    return () => {
      alive = false;
    };
  }, [docPath]);

  // Stay quiet until we've resolved history for THIS doc; then show the section.
  if (!state || state.path !== docPath) return null;
  const items = state.items;

  return (
    <div className="mt-2 border-t border-[--color-line] px-2 py-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[--color-muted]">
        <History size={12} /> History
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-[--color-muted]">No history yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((h, i) => (
            <li key={`${h.at}-${i}`} className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0 truncate text-[--color-muted]">
                <span className="text-[--color-ink]">{h.actorEmail.split("@")[0]}</span>{" "}
                {actionLabel(h.action)}
              </span>
              <span className="shrink-0 text-xs text-[--color-muted]">{relativeTime(h.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AskPanel({ docTitle }: { docTitle: string }) {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    const question = q.trim();
    if (!question) return;
    start(async () => setAnswer(await askAction(question)));
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-2 pb-2 pt-1 text-xs text-[--color-muted]">
        Grounded in the docs you can read. Citations link to the source.
      </div>
      <div className="relative px-2">
        <textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder={`Ask about "${docTitle}" or anything in the docs…`}
          className="w-full resize-none rounded-md border border-[--color-line] bg-transparent p-2 text-sm outline-none focus:border-[--color-accent]"
        />
        <button
          type="button"
          onClick={submit}
          disabled={pending || !q.trim()}
          className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md bg-[--color-accent] px-3 py-1.5 text-sm font-medium text-[--color-bg] disabled:opacity-50"
        >
          {pending ? "Thinking…" : <>Ask <CornerDownLeft size={13} /></>}
        </button>
      </div>

      {answer && (
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2">
          <div className="prose-doc prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
              {answer.answer}
            </ReactMarkdown>
          </div>
          {answer.sources.length > 0 && (
            <div className="mt-3 border-t border-[--color-line] pt-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[--color-muted]">
                Sources
              </p>
              <ul className="space-y-1">
                {answer.sources.map((s) => (
                  <li key={s.n} className="text-xs">
                    <Link
                      href={`/app/doc/${s.path}`}
                      className="text-[--color-accent] hover:underline"
                    >
                      [{s.n}] {s.title}
                    </Link>
                    {s.headingPath && (
                      <span className="text-[--color-muted]"> · {s.headingPath}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-2 text-[10px] text-[--color-muted]">via {answer.provider}</p>
        </div>
      )}
    </div>
  );
}

/** Right rail for the doc view: scroll-spy outline + an Ask-the-docs panel.
 *  Hidden below xl (the spec drops the rail first on smaller viewports). */
export function DocAside({
  toc,
  docTitle,
  docPath,
  // TODO(lead): pass canEdit from doc/[...path]/page.tsx (compute edit access for
  // the acting principal there and thread it through). Defaults false → Restore hidden.
  canEdit = false,
}: {
  toc: TocItem[];
  docTitle: string;
  docPath: string;
  canEdit?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("toc");
  const tabCls = (t: Tab) =>
    cn(
      "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm transition-colors",
      tab === t
        ? "bg-[--color-accent]/15 text-[--color-accent]"
        : "text-[--color-muted] hover:text-[--color-ink]",
    );

  return (
    <aside className="sticky top-0 hidden h-[calc(100vh-3rem)] w-72 shrink-0 flex-col self-start border-l border-[--color-line] pl-4 xl:flex">
      <div className="flex gap-1 py-3">
        <button type="button" onClick={() => setTab("toc")} className={tabCls("toc")}>
          <ListTree size={14} /> On this page
        </button>
        <button type="button" onClick={() => setTab("ask")} className={tabCls("ask")}>
          <Sparkles size={14} /> Ask AI
        </button>
        <button type="button" onClick={() => setTab("comments")} className={tabCls("comments")}>
          <MessageSquare size={14} /> Comments
        </button>
        <button type="button" onClick={() => setTab("versions")} className={tabCls("versions")}>
          <GitBranch size={14} /> Versions
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "toc" ? (
          <>
            <Toc items={toc} />
            <Backlinks docPath={docPath} />
            <DocHistory docPath={docPath} />
          </>
        ) : tab === "ask" ? (
          <AskPanel docTitle={docTitle} />
        ) : tab === "comments" ? (
          <Comments path={docPath} />
        ) : (
          <VersionHistory path={docPath} canEdit={canEdit} />
        )}
      </div>
    </aside>
  );
}
