"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronRight, Lightbulb, X } from "lucide-react";

import {
  acceptSuggestion,
  listSuggestions,
  rejectSuggestion,
  type SuggestionView,
} from "@/app/actions/suggestions";
import { Badge, Button, Card, cn } from "./ui";

/** Relative-time helper (no new dep). */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

function localPart(email: string): string {
  return email.split("@")[0];
}

/** Open suggestions for a doc. Editors get Accept/Reject; everyone else sees the
 *  pending proposals read-only (so authors can watch their own). All actions are
 *  permission-checked server-side — this UI is a convenience, not the gate. */
export function SuggestionsReview({ path, canEdit }: { path: string; canEdit: boolean }) {
  const [items, setItems] = useState<SuggestionView[] | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    listSuggestions(path).then((rows) => {
      if (alive) setItems(rows);
    });
    return () => {
      alive = false;
    };
  }, [path]);

  function toggle(id: string) {
    setExpanded((e) => ({ ...e, [id]: !e[id] }));
  }

  function remove(id: string) {
    setItems((cur) => (cur ? cur.filter((s) => s.id !== id) : cur));
  }

  function accept(id: string) {
    setBusyId(id);
    setNotice(null);
    startTransition(async () => {
      const res = await acceptSuggestion(id);
      if (res.ok) {
        remove(id);
        router.refresh();
      } else if (res.conflict) {
        // The doc moved on under this proposal — keep it in the list and tell the
        // reviewer to re-review rather than silently clobbering the newer edits.
        setNotice(res.error ?? "This doc changed — re-review before accepting.");
        router.refresh();
      } else {
        setNotice(res.error ?? "Could not apply the suggestion.");
      }
      setBusyId(null);
    });
  }

  function reject(id: string) {
    setBusyId(id);
    startTransition(async () => {
      const res = await rejectSuggestion(id);
      if (res.ok) remove(id);
      setBusyId(null);
    });
  }

  if (!items || items.length === 0) return null;

  return (
    <section className="mt-8 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium text-[--color-ink]">
        <Lightbulb size={16} className="text-[--color-accent]" />
        Suggested edits
        <Badge tone="accent">{items.length}</Badge>
      </div>

      {notice && (
        <div
          role="status"
          className="rounded-md border border-[--color-warn] bg-[--color-warn]/10 px-3 py-2 text-sm text-[--color-ink]"
        >
          {notice}
        </div>
      )}

      {items.map((s) => {
        const open = !!expanded[s.id];
        const busy = busyId === s.id;
        return (
          <Card key={s.id} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-[--color-ink]">{localPart(s.authorEmail)}</span>
              <span className="text-xs text-[--color-muted]">{relativeTime(s.createdAt)}</span>
            </div>
            {s.note && <p className="text-sm text-[--color-ink]">{s.note}</p>}

            <button
              type="button"
              onClick={() => toggle(s.id)}
              className="flex w-fit items-center gap-1 text-xs text-[--color-muted] hover:text-[--color-ink]"
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {open ? "Hide proposed source" : "Preview proposed source"}
            </button>
            {open && (
              <pre className="max-h-80 overflow-auto rounded-md border border-[--color-line] bg-[--color-surface] p-3 font-mono text-xs leading-relaxed text-[--color-ink]">
                {s.proposedContent}
              </pre>
            )}

            {canEdit && (
              <div className={cn("flex items-center gap-2", busy && "opacity-60")}>
                <Button variant="ok" onClick={() => accept(s.id)} disabled={busy}>
                  <Check size={14} /> Accept
                </Button>
                <Button variant="danger" onClick={() => reject(s.id)} disabled={busy}>
                  <X size={14} /> Reject
                </Button>
              </div>
            )}
          </Card>
        );
      })}
    </section>
  );
}
