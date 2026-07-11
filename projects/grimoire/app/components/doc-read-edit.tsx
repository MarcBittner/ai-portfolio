"use client";

import type { ReactNode } from "react";
import { useState, useTransition } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, FolderInput, Lightbulb, Pencil, Star } from "lucide-react";

import { Badge, Button, buttonCls, cn } from "./ui";
import { DocAside, type TocItem } from "./doc-aside";
import { SuggestionsReview } from "./suggestions-review";

// The editor pulls in TipTap (×6) + Yjs + y-websocket; the suggest panel is its
// own leaf. Neither renders on the read path, so code-split both out of the doc-
// READ bundle — they load only when the reader clicks Edit / Suggest edit. TipTap
// runs client-only via immediatelyRender:false inside Wysiwyg, so ssr:false here
// is unnecessary (and would forfeit the components' own SSR shells).
const Editor = dynamic(() => import("./editor").then((m) => m.Editor));
const SuggestPanel = dynamic(() => import("./suggest-panel").then((m) => m.SuggestPanel));
import { toggleFavorite } from "@/app/actions/favorites";
import { moveDocAction } from "@/app/actions/docs";

export interface DocViewData {
  path: string;
  title: string;
  spaceKey: string;
  raw: string; // full markdown incl. front-matter (what the editor saves)
  blobSha: string;
  updatedAt: number;
  source?: string;
  status?: string;
  owner?: string;
  tags?: string[];
  summary?: string;
}

/** Reading + editing in ONE view. With edit rights, "Edit" swaps the rendered
 *  article for the live editor in place — no route change (Notion/Outline style).
 *  Autosave persists edits; "Done" refreshes so the rendered view reflects them. */
export function DocReadEdit({
  doc,
  toc,
  canEdit,
  userName,
  favorite: initialFavorite,
  article,
}: {
  doc: DocViewData;
  toc: TocItem[];
  canEdit: boolean;
  userName?: string;
  favorite?: boolean;
  /** Server-rendered doc body (RSC). Passed in so the markdown toolchain never
   *  ships to the client — reading is pure server HTML + thin client chrome. */
  article: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [favorite, setFavorite] = useState(!!initialFavorite);
  const [, startFav] = useTransition();
  const router = useRouter();

  function toggleFav() {
    setFavorite((f) => !f); // optimistic
    startFav(async () => {
      const res = await toggleFavorite(doc.path);
      setFavorite(res.favorite);
    });
  }

  function done() {
    setEditing(false);
    router.refresh(); // re-fetch so the rendered article shows the saved content
  }

  const [moving, setMoving] = useState(false);
  const [dest, setDest] = useState(doc.path);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  const [movePending, startMove] = useTransition();
  function submitMove() {
    setMoveErr(null);
    startMove(async () => {
      const res = await moveDocAction({ from: doc.path, to: dest });
      if (res.ok && res.path) router.push(`/app/doc/${res.path}`);
      else setMoveErr(res.error ?? "Move failed");
    });
  }

  return (
    <div className="flex gap-8">
      <article className="min-w-0 max-w-[72ch] flex-1">
        <div className="mb-5 flex items-center gap-3">
          <Link
            href="/app"
            className="flex items-center gap-1 text-sm text-[--color-muted] hover:text-[--color-ink]"
          >
            <ChevronLeft size={15} aria-hidden /> Docs
          </Link>
          <Badge tone="muted">{doc.spaceKey}</Badge>
          <span className="truncate text-xs text-[--color-muted]">{doc.path}</span>
          <button
            type="button"
            onClick={toggleFav}
            aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
            title={favorite ? "Starred" : "Star this doc"}
            className={cn(
              "ml-auto rounded-md p-1.5 hover:bg-[--color-accent]/10",
              favorite ? "text-[--color-warn]" : "text-[--color-muted] hover:text-[--color-ink]",
            )}
          >
            <Star size={15} className={favorite ? "fill-current" : ""} />
          </button>
          {!editing && !suggesting && (
            <button
              type="button"
              onClick={() => setSuggesting(true)}
              className={buttonCls("ghost")}
            >
              <Lightbulb size={14} /> Suggest edit
            </button>
          )}
          {canEdit && !editing && !suggesting && (
            <button
              type="button"
              onClick={() => {
                setMoving((m) => !m);
                setDest(doc.path);
                setMoveErr(null);
              }}
              className={buttonCls("ghost")}
            >
              <FolderInput size={14} /> Move
            </button>
          )}
          {canEdit &&
            (editing ? (
              <button type="button" onClick={done} className={buttonCls("primary")}>
                <Check size={14} /> Done
              </button>
            ) : (
              <button type="button" onClick={() => setEditing(true)} className={buttonCls("ghost")}>
                <Pencil size={14} /> Edit
              </button>
            ))}
        </div>

        {moving && !editing && (
          <div className="glass mb-5 flex flex-wrap items-center gap-2 p-3">
            <span className="text-xs text-[--color-muted]">Move / rename to:</span>
            <input
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              placeholder="space/new-name.md"
              className="min-w-0 flex-1 rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1 text-sm"
            />
            <Button variant="primary" disabled={movePending} onClick={submitMove}>
              {movePending ? "Moving…" : "Move"}
            </Button>
            <Button variant="ghost" onClick={() => setMoving(false)}>
              Cancel
            </Button>
            {moveErr && <span className="w-full text-xs text-[--color-bad]">{moveErr}</span>}
          </div>
        )}

        {editing ? (
          <Editor
            path={doc.path}
            initialContent={doc.raw}
            baseSha={doc.blobSha}
            title={doc.title}
            userName={userName}
          />
        ) : suggesting ? (
          <SuggestPanel
            path={doc.path}
            initialContent={doc.raw}
            baseSha={doc.blobSha}
            onDone={() => {
              setSuggesting(false);
              router.refresh();
            }}
          />
        ) : (
          <>
            {doc.summary && (
              <p className="mb-4 border-l-2 border-[--color-accent] pl-3 text-sm italic text-[--color-muted]">
                {doc.summary}
              </p>
            )}

            {(doc.source || doc.status || doc.tags?.length) && (
              <div className="glass mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 p-3 text-xs text-[--color-muted]">
                {doc.source && (
                  <span>
                    <span className="font-medium text-[--color-ink]">Source:</span> {doc.source}
                  </span>
                )}
                {doc.status && (
                  <Badge tone={doc.status === "published" ? "ok" : "muted"}>{doc.status}</Badge>
                )}
                {doc.owner && (
                  <span>
                    <span className="font-medium text-[--color-ink]">Owner:</span> {doc.owner}
                  </span>
                )}
                {doc.tags?.map((t) => (
                  <Badge key={t} tone="accent">
                    {t}
                  </Badge>
                ))}
                <span className="ml-auto">
                  Updated {new Date(doc.updatedAt).toISOString().slice(0, 10)}
                </span>
              </div>
            )}

            {article}

            <SuggestionsReview path={doc.path} canEdit={canEdit} />
          </>
        )}
      </article>

      <DocAside toc={toc} docTitle={doc.title} docPath={doc.path} canEdit={canEdit} />
    </div>
  );
}
