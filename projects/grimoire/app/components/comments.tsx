"use client";

import { Fragment, useCallback, useEffect, useState, useTransition } from "react";
import { Check, MessageSquare, Send } from "lucide-react";

import { Badge, Button, cn } from "./ui";
import {
  addComment,
  listComments,
  resolveComment,
  type CommentView,
} from "@/app/actions/comments";

/** Compact relative time ("just now", "5m", "3h", "2d", else a date). */
function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 604800) return `${Math.round(s / 86400)}d`;
  return new Date(ts).toISOString().slice(0, 10);
}

/** Render a body with @mentions emphasized in the accent color. */
function Body({ text }: { text: string }) {
  const parts = text.split(/(@[a-zA-Z0-9._-]+)/g);
  return (
    <p className="whitespace-pre-wrap break-words text-sm text-[--color-ink]">
      {parts.map((part, i) =>
        /^@[a-zA-Z0-9._-]+$/.test(part) ? (
          <span key={i} className="font-semibold text-[--color-accent]">
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </p>
  );
}

/** Comments panel for a doc: threaded list + composer. Reads/writes are
 *  permission-gated server-side, so an empty list may simply mean no read access. */
export function Comments({ path }: { path: string }) {
  const [comments, setComments] = useState<CommentView[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, start] = useTransition();

  const reload = useCallback(async () => {
    setComments(await listComments(path));
    setLoading(false);
  }, [path]);

  // Load on mount / when the doc changes. The fetch is async (setState runs after
  // the await), and a guard drops results if the path changed mid-flight.
  useEffect(() => {
    let active = true;
    (async () => {
      const list = await listComments(path);
      if (active) {
        setComments(list);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [path]);

  function submit() {
    const body = draft.trim();
    if (!body) return;
    start(async () => {
      const added = await addComment(path, body);
      if (added) setDraft("");
      await reload();
    });
  }

  function resolve(id: string) {
    start(async () => {
      await resolveComment(id);
      await reload();
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-2 pb-2 pt-1 text-xs text-[--color-muted]">
        Discuss this doc. Type <span className="text-[--color-accent]">@name</span> to mention a teammate.
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {loading ? (
          <p className="py-3 text-xs text-[--color-muted]">Loading…</p>
        ) : comments.length === 0 ? (
          <p className="flex items-center gap-1.5 py-3 text-xs text-[--color-muted]">
            <MessageSquare size={13} /> No comments yet.
          </p>
        ) : (
          <ul className="space-y-3 py-1">
            {comments.map((c) => (
              <li
                key={c.id}
                className={cn(
                  "rounded-md border border-[--color-line] p-2.5",
                  c.resolved && "opacity-60",
                )}
              >
                <div className="mb-1 flex items-center gap-2 text-xs text-[--color-muted]">
                  <span className="font-medium text-[--color-ink]">{c.authorEmail}</span>
                  <span>·</span>
                  <span>{timeAgo(c.createdAt)}</span>
                  {c.resolved && (
                    <Badge tone="ok" className="ml-auto">
                      <Check size={11} /> Resolved
                    </Badge>
                  )}
                </div>
                <Body text={c.body} />
                {!c.resolved && (
                  <div className="mt-1.5 flex">
                    <button
                      type="button"
                      onClick={() => resolve(c.id)}
                      disabled={pending}
                      className="flex items-center gap-1 text-xs text-[--color-muted] hover:text-[--color-accent] disabled:opacity-50"
                    >
                      <Check size={12} /> Resolve
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-2 px-2 pb-1">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder="Add a comment…"
          className="w-full resize-none rounded-md border border-[--color-line] bg-transparent p-2 text-sm outline-none focus:border-[--color-accent]"
        />
        <Button
          type="button"
          variant="primary"
          onClick={submit}
          disabled={pending || !draft.trim()}
          className="mt-1 w-full"
        >
          {pending ? "Saving…" : <>Comment <Send size={13} /></>}
        </Button>
      </div>
    </div>
  );
}
