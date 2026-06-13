import { useEffect, useRef } from "react";
import { cn } from "~/lib/utils";

export type HelpSection =
  | "overview"
  | "ask"
  | "chat"
  | "interview"
  | "build"
  | "routing"
  | "analytics";

const PAGES: { id: HelpSection; title: string; body: string }[] = [
  {
    id: "ask",
    title: "Ask",
    body:
      "Pick a twin and ask a one-off question. The answer is grounded in the " +
      "twin's retrieved documents and shows its citations — or an honest refusal " +
      "when the record doesn't support an answer. Expand “routing & timings” to " +
      "see which model answered and how long each pipeline stage took.",
  },
  {
    id: "chat",
    title: "Chat",
    body:
      "A streaming, multi-turn conversation with a twin. Tokens arrive live over " +
      "Server-Sent Events; citations and the routing decision land when the turn " +
      "completes. The conversation is condensed into a standalone query before " +
      "retrieval so follow-ups stay on topic.",
  },
  {
    id: "interview",
    title: "Interview",
    body:
      "Have one twin interview another for a few rounds. Each question and answer " +
      "is grounded and cited, so you can watch two synthetic personalities probe " +
      "each other entirely from their own documents.",
  },
  {
    id: "build",
    title: "Build",
    body:
      "Create your own twin: name it, set a HEXACO personality, and paste " +
      "documents. PII is detected and redacted at ingest — the preview shows " +
      "redaction counts (never the values) before anything is embedded or stored.",
  },
  {
    id: "routing",
    title: "Routing console",
    body:
      "Inspect and edit the model routing policy: the default objective, per-task " +
      "objectives and pins, the model registry with prices and quality/speed ranks, " +
      "the resolved fallback plan per task, and any circuit that's cooling down. You " +
      "can also run a benchmark across models and tasks.",
  },
  {
    id: "analytics",
    title: "Analytics",
    body:
      "Aggregated benchmark results across runs — compare models on each task by " +
      "quality metrics, latency, and cost so routing decisions are evidence-based.",
  },
];

const GLOSSARY: { term: string; def: string }[] = [
  {
    term: "Grounding & refusal",
    def:
      "An answer is “grounded” only if it's supported by retrieved chunks; when the " +
      "record doesn't support it, the twin refuses rather than inventing.",
  },
  {
    term: "Citation",
    def:
      "A specific chunk the answer drew on, with its retrieval score and an excerpt. " +
      "Citations are validated against what was actually retrieved.",
  },
  {
    term: "Routing objective",
    def:
      "How a request picks a model — cost (cheapest capable), latency (fastest), or " +
      "quality (best). Set globally or per task in the routing console.",
  },
  {
    term: "Circuit breaker",
    def:
      "After repeated failures a provider is “cooled down” and skipped for a while, " +
      "so one flapping upstream can't stall every request.",
  },
  {
    term: "Hybrid retrieval & reranking",
    def:
      "Vector + keyword (BM25) search are fused, then a reranker re-orders the top " +
      "candidates so the most relevant chunks lead.",
  },
  {
    term: "HEXACO",
    def:
      "The six-factor personality model (Honesty-Humility, Emotionality, " +
      "Extraversion, Agreeableness, Conscientiousness, Openness) that shapes a " +
      "twin's voice.",
  },
];

export function Help({
  open,
  onClose,
  section = "overview",
}: {
  open: boolean;
  onClose: () => void;
  section?: HelpSection;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // scroll to the relevant page section when opened
  useEffect(() => {
    if (!open) return;
    const el = panelRef.current?.querySelector(`[data-help-section="${section}"]`);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
  }, [open, section]);

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/40 transition-opacity",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Help"
        aria-hidden={!open}
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-[440px] max-w-[94vw] flex-col",
          "border-l border-border bg-card text-card-foreground shadow-xl",
          "transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="text-sm font-semibold">Help &amp; guide</div>
          <button
            onClick={onClose}
            aria-label="Close help"
            className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted"
          >
            ✕
          </button>
        </header>

        <div ref={panelRef} className="space-y-6 overflow-y-auto px-5 py-5 text-sm">
          <section data-help-section="overview" className="space-y-2">
            <h3 className="font-semibold">What is persona-twin?</h3>
            <p className="text-muted-foreground">
              Query AI <strong>digital twins</strong> of synthetic personas. Each twin
              answers in character, grounded in its own documents, with citations — or
              an honest refusal. It's a reference implementation of RAG as an{" "}
              <em>architecture</em>: chunk → embed → hybrid retrieve → rerank → grounded
              generation, with multi-provider model routing and layered evaluation.
            </p>
            <p className="text-muted-foreground">
              It runs fully offline by default (deterministic embedder + mock model, no
              keys). Set a provider key to route to real models — free by default.
            </p>
          </section>

          <section data-help-section="pipeline" className="space-y-2">
            <h3 className="font-semibold">How an answer is built</h3>
            <ol className="ml-4 list-decimal space-y-1 text-muted-foreground">
              <li><strong>Chunk</strong> — documents are split into passages.</li>
              <li><strong>Embed</strong> — passages become vectors.</li>
              <li><strong>Retrieve</strong> — vector + keyword search, fused.</li>
              <li><strong>Rerank</strong> — top candidates re-ordered by relevance.</li>
              <li><strong>Generate</strong> — the model answers only from those chunks, and cites them.</li>
            </ol>
          </section>

          <section className="space-y-3">
            <h3 className="font-semibold">The pages</h3>
            {PAGES.map((p) => (
              <div key={p.id} data-help-section={p.id} className="space-y-1">
                <div className="font-medium">{p.title}</div>
                <p className="text-muted-foreground">{p.body}</p>
              </div>
            ))}
          </section>

          <section className="space-y-3">
            <h3 className="font-semibold">Glossary</h3>
            {GLOSSARY.map((g) => (
              <div key={g.term} className="space-y-0.5">
                <div className="font-medium">{g.term}</div>
                <p className="text-muted-foreground">{g.def}</p>
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <h3 className="font-semibold">Keyboard shortcuts</h3>
            <ul className="space-y-1 text-muted-foreground">
              <li><kbd className="rounded border border-border px-1">?</kbd> open this help</li>
              <li><kbd className="rounded border border-border px-1">Esc</kbd> close a panel</li>
              <li><kbd className="rounded border border-border px-1">Enter</kbd> send (Ask / Chat); <kbd className="rounded border border-border px-1">Shift</kbd>+<kbd className="rounded border border-border px-1">Enter</kbd> newline</li>
            </ul>
          </section>

          <p className="border-t border-border pt-4 text-xs text-muted-foreground">
            All personas and documents are synthetic and fictional. PII is redacted at
            ingest; redaction reports carry counts, never values.
          </p>
        </div>
      </aside>
    </>
  );
}
