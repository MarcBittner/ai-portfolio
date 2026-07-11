"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "./ui";
import { useConfig, Badge, type Degradable } from "./kit";

// AskAiBar — the global assistant, surfaced as a PROMINENT, full-width entry bar
// at the top of every section's content (rendered by Nav, directly above the
// page). It reads as an inviting "✨ Ask AI — …" click-to-open input; opening it
// expands the glass chat panel below the bar. Questions POST to /api/ask with the
// current route as grounding context, and the answer shows which provider
// answered (with the same provider-fallback chain as before).
//
// SELF-GATING: it reads /api/config and renders NOTHING unless the `askAi`
// feature flag is on, so it's safe to mount once in the nav on every page.
// Read-only — it only asks; it never triggers a mutation. This relocation changes
// only WHERE/HOW the assistant is surfaced, not the engine below.

type ConfigResp = { features?: { askAi?: boolean } } & Degradable;

type Turn = {
  role: "you" | "ai";
  text: string;
  provider?: string;
  fellBackFrom?: string[];
};

export function AskAiBar() {
  const pathname = usePathname();
  // Cheap poll-free read; the flag rarely changes within a session. Routed
  // through the shared session config so it does not re-fetch on every route.
  const { data } = useConfig<ConfigResp>();
  const enabled = Boolean(data?.features?.askAi);

  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Esc closes the panel; focus the input when it opens.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    inputRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Keep the transcript scrolled to the newest turn.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns, busy]);

  if (!enabled) return null;

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setTurns((t) => [...t, { role: "you", text: q }]);
    setQuestion("");
    setBusy(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, page: pathname }),
      });
      const json = (await res.json()) as {
        answer?: string;
        provider?: string;
        fellBackFrom?: string[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "request failed");
      setTurns((t) => [
        ...t,
        {
          role: "ai",
          text: json.answer ?? "(no answer)",
          provider: json.provider,
          fellBackFrom: json.fellBackFrom,
        },
      ]);
    } catch (e) {
      setTurns((t) => [
        ...t,
        { role: "ai", text: e instanceof Error ? e.message : String(e), provider: "error" },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter for a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  };

  return (
    <section aria-label="Ask AI" className="mb-6">
      {/* Collapsed entry bar — a full-width, inviting click-to-open prompt. When
          open it becomes the panel's header row (still closes it). */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls="askai-panel"
        onClick={() => setOpen((o) => !o)}
        className="glass flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:border-[--color-accent]"
      >
        <span aria-hidden className="text-lg leading-none text-[--color-accent]">
          ✨
        </span>
        <span className="flex-1 truncate text-sm text-[--color-muted]">
          <span className="font-medium text-[--color-ink]">Ask AI</span>
          <span className="hidden sm:inline">
            {" "}
            — ask about your instances, logs, config…
          </span>
        </span>
        <span
          aria-hidden
          className="rounded-md border border-[--color-accent] px-2 py-0.5 text-xs font-medium text-[--color-accent]"
        >
          {open ? "Close" : "Ask"}
        </span>
      </button>

      {open && (
        <div
          id="askai-panel"
          className="glass mt-2 flex max-h-[28rem] flex-col p-3 shadow-xl"
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">Ask AI</span>
              <Badge tone="muted" title="Answers are grounded to this dashboard">
                dashboard help
              </Badge>
            </div>
            <button
              type="button"
              aria-label="Close Ask AI"
              onClick={() => setOpen(false)}
              className="rounded px-1.5 text-[--color-muted] hover:text-[--color-ink]"
            >
              ✕
            </button>
          </div>

          <div
            ref={logRef}
            className="mb-2 min-h-[6rem] flex-1 space-y-2 overflow-y-auto pr-1 text-sm"
          >
            {turns.length === 0 && (
              <p className="text-xs text-[--color-muted]">
                Ask about provisioning, backups, drift, the queue, share links, cost
                estimates, masking — anything on the dashboard. Read-only: I explain,
                I never act.
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i} className={t.role === "you" ? "text-right" : "text-left"}>
                <div
                  className={
                    t.role === "you"
                      ? "inline-block rounded-lg bg-[--color-accent]/15 px-2.5 py-1.5 text-[--color-ink]"
                      : "inline-block rounded-lg bg-[color-mix(in_oklch,var(--color-ink)_8%,transparent)] px-2.5 py-1.5 text-[--color-ink]"
                  }
                >
                  <div className="whitespace-pre-wrap leading-relaxed">{t.text}</div>
                  {t.role === "ai" && t.provider && (
                    <div
                      className="mt-1 text-[0.65rem] text-[--color-muted]"
                      title={t.fellBackFrom?.length ? `fell back from: ${t.fellBackFrom.join("; ")}` : undefined}
                    >
                      via {t.provider}
                      {t.fellBackFrom?.length ? ` (fell back ${t.fellBackFrom.length}x)` : ""}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && <div className="text-xs text-[--color-muted]">thinking…</div>}
          </div>

          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              rows={2}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask about the dashboard…"
              className="min-h-0 flex-1 resize-none rounded-md border border-[--color-line] bg-[--color-surface] px-2.5 py-1.5 text-sm text-[--color-ink] outline-none focus:border-[--color-accent]"
            />
            <Button variant="primary" disabled={busy || !question.trim()} onClick={ask}>
              {busy ? "…" : "Ask"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
