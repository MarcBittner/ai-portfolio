"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Check, Eye, Pencil, Sparkles, Trash2, Type, X } from "lucide-react";

import { Button } from "./ui";
import { Wysiwyg } from "./wysiwyg";
import { deleteDocAction, saveDocAction } from "@/app/actions/docs";
import { assistAction } from "@/app/actions/ai";
import { collabTicket } from "@/app/actions/collab";
import { getRoutingConfig } from "@/app/actions/routing";
import { colorForName, type CollabTicket } from "@/lib/collab/provider";
import { probeOllama, pickOllamaModel, completeWithOllama } from "@/app/lib/ollama";
import type { AssistKind } from "@/lib/ai/actions";

type Mode = "wysiwyg" | "write" | "preview";

const ASSISTS: { kind: AssistKind; label: string }[] = [
  { kind: "expand", label: "Expand" },
  { kind: "proofread", label: "Proofread" },
  { kind: "draft", label: "Draft" },
];

export function Editor({
  path,
  initialContent,
  baseSha,
  title,
  userName,
}: {
  path: string;
  initialContent: string;
  baseSha: string;
  title: string;
  userName?: string;
}) {
  // Live collaboration: ask the server for a per-doc ticket. It returns null
  // unless the collab WS server is configured AND this principal may edit the
  // doc — so the editor is a plain local WYSIWYG otherwise. The secret never
  // reaches the client; the ticket is HMAC-bound to this doc's room.
  const [ticket, setTicket] = useState<CollabTicket | null>(null);
  const [ticketResolved, setTicketResolved] = useState(false);
  useEffect(() => {
    let live = true;
    collabTicket(path)
      .then((t) => {
        if (live) {
          setTicket(t);
          setTicketResolved(true);
        }
      })
      .catch(() => {
        // collaboration stays off on error
        if (live) setTicketResolved(true);
      });
    return () => {
      live = false;
    };
  }, [path]);
  const collabUser =
    ticket && userName ? { name: userName, color: colorForName(userName) } : undefined;

  // Routing preference — when "prefer local" is on, AI assists try the user's
  // browser Ollama before the server providers.
  const [preferLocal, setPreferLocal] = useState(false);
  useEffect(() => {
    let live = true;
    getRoutingConfig()
      .then((c) => live && setPreferLocal(c.preferLocal))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const [content, setContent] = useState(initialContent);
  const [savedContent, setSavedContent] = useState(initialContent);
  const [sha, setSha] = useState(baseSha);
  const [mode, setMode] = useState<Mode>("wysiwyg");
  const [status, setStatus] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [proposal, setProposal] = useState<{ text: string; provider: string } | null>(null);
  const [saving, startSave] = useTransition();
  const [assisting, startAssist] = useTransition();
  const [deleting, startDelete] = useTransition();
  const router = useRouter();

  const dirty = content !== savedContent;

  function remove() {
    if (!confirm(`Delete ${path}? This commits a removal.`)) return;
    startDelete(async () => {
      const res = await deleteDocAction({ path });
      if (res.ok) router.push("/app");
      else setStatus(res.error ?? "Delete failed");
    });
  }

  function save() {
    startSave(async () => {
      const res = await saveDocAction({ path, content, baseSha: sha });
      if (res.ok) {
        setSavedContent(content);
        setSha(res.sha);
        setSavedAt(Date.now());
        setStatus(null);
      } else {
        setStatus(res.error ?? "Save failed");
      }
    });
  }

  // Debounced autosave: commit ~1.2s after edits settle. On a conflict/failure it
  // surfaces the error and stops (waits for the next edit) rather than retry-looping.
  useEffect(() => {
    if (!dirty || saving) return;
    const t = setTimeout(save, 1200);
    return () => clearTimeout(t);
    // save closes over the current content/sha; re-created each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, dirty, saving]);

  // ⌘S / Ctrl+S forces an immediate save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && !saving) save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, saving]);

  // Run the completion on local Ollama with a server-built prompt. Returns the
  // text, or null if Ollama isn't reachable / the call failed.
  async function tryLocalOllama(prompt?: string, system?: string): Promise<string | null> {
    if (!prompt) return null;
    try {
      const { url, models } = await probeOllama();
      if (!url) return null;
      const model = pickOllamaModel(undefined, models);
      const text = await completeWithOllama({ prompt, system, model, base: url });
      return text.trim() ? text : null;
    } catch {
      return null;
    }
  }

  function runAssist(kind: AssistKind) {
    setStatus(null);
    startAssist(async () => {
      // Prefer-local: fetch the prompt cheaply (mode "offline" skips cloud) and
      // run it on the browser's Ollama first.
      if (preferLocal) {
        const seed = await assistAction(kind, content, "offline");
        if (seed.ok) {
          const local = await tryLocalOllama(seed.prompt, seed.system);
          if (local) {
            setProposal({ text: local, provider: "ollama (local)" });
            return;
          }
        }
      }

      const res = await assistAction(kind, content);
      if (!res.ok || res.text === undefined) {
        setStatus(res.error ?? "AI unavailable");
        return;
      }
      // Server had no cloud provider → try the user's LOCAL Ollama from the
      // browser (a cloud server can't reach it, but we can).
      if (res.provider === "offline") {
        const local = await tryLocalOllama(res.prompt, res.system);
        if (local) {
          setProposal({ text: local, provider: "ollama (local)" });
          return;
        }
      }
      setProposal({ text: res.text, provider: res.provider ?? "offline" });
    });
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link href={`/app/doc/${path}`} className="text-sm text-[--color-muted] hover:text-[--color-ink]">
          ← {title}
        </Link>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant={mode === "wysiwyg" ? "primary" : "ghost"}
            onClick={() => setMode("wysiwyg")}
          >
            <Type size={14} /> Rich
          </Button>
          <Button
            variant={mode === "write" ? "primary" : "ghost"}
            onClick={() => setMode("write")}
          >
            <Pencil size={14} /> Source
          </Button>
          <Button
            variant={mode === "preview" ? "primary" : "ghost"}
            onClick={() => setMode("preview")}
          >
            <Eye size={14} /> Preview
          </Button>
          {ASSISTS.map((a) => (
            <Button key={a.kind} variant="secondary" disabled={assisting} onClick={() => runAssist(a.kind)}>
              <Sparkles size={14} /> {a.label}
            </Button>
          ))}
          <span className="flex items-center gap-1.5 px-1 text-xs text-[--color-muted]" aria-live="polite">
            {saving ? (
              <>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[--color-accent]" /> Saving…
              </>
            ) : dirty ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-[--color-muted]" /> Unsaved
              </>
            ) : savedAt ? (
              <>
                <Check size={13} className="text-[--color-accent]" /> Saved
              </>
            ) : null}
          </span>
          {ticket && (
            <span className="flex items-center gap-1 rounded-md bg-[--color-accent]/10 px-2 py-1 text-xs text-[--color-accent]">
              <span className="h-1.5 w-1.5 rounded-full bg-[--color-accent]" /> Live
            </span>
          )}
          <Button variant="danger" disabled={deleting} onClick={remove}>
            <Trash2 size={14} /> {deleting ? "…" : "Delete"}
          </Button>
        </div>
      </div>

      {status && <p className="mb-3 text-sm text-[--color-muted]">{status}</p>}

      {proposal && (
        <div className="glass mb-4 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm">
            <Sparkles size={14} className="text-[--color-accent]" />
            <b>AI proposal</b>
            <span className="text-xs text-[--color-muted]">via {proposal.provider}</span>
            <span className="ml-auto flex gap-2">
              <Button
                variant="ok"
                onClick={() => {
                  setContent(proposal.text);
                  setProposal(null);
                  setMode("write");
                }}
              >
                <Check size={14} /> Accept
              </Button>
              <Button variant="ghost" onClick={() => setProposal(null)}>
                <X size={14} /> Reject
              </Button>
            </span>
          </div>
          <div className="prose-doc max-h-72 overflow-auto rounded-md border border-[--color-line] p-3">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
              {proposal.text}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {mode === "wysiwyg" &&
        (ticketResolved ? (
          // Mount the editor ONCE, after the collab decision is known, so it never
          // rebuilds from local→collab mid-session (which briefly unmounted it).
          <Wysiwyg value={content} onChange={setContent} ticket={ticket ?? undefined} user={collabUser} />
        ) : (
          <div className="glass min-h-[55vh] animate-pulse" aria-hidden />
        ))}

      {mode === "write" && (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck
          className="h-[60vh] w-full resize-y rounded-md border border-[--color-line] bg-[color-mix(in_oklch,_var(--color-ink)_3%,_transparent)] p-4 font-mono text-sm leading-relaxed text-[--color-ink] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--color-accent]/40"
        />
      )}

      {mode === "preview" && (
        <div className="prose-doc glass min-h-[60vh] p-6">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
            {content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
