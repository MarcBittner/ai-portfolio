import { useState } from "react";
import type { Route } from "./+types/home";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import {
  ask,
  HEXACO_LABELS,
  listPersonas,
  type AskResponse,
  type HexacoProfile,
  type Persona,
} from "~/lib/api";
import { cn } from "~/lib/utils";
import { Nav } from "~/components/nav";
import { loadPrefs } from "~/lib/prefs";

export async function clientLoader() {
  return { personas: await listPersonas() };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { personas } = loaderData;
  const [selected, setSelected] = useState<Persona | null>(() => {
    const pref = loadPrefs().defaultPersona;
    return personas.find((p) => p.persona_id === pref) ?? personas[0] ?? null;
  });
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<AskResponse | null>(null);

  async function submit() {
    if (!selected || !question.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResponse(await ask(selected.persona_id, question.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 md:p-10">
      <Nav active="home" />
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">persona-twin</h1>
        <p className="text-sm text-muted-foreground">
          Ask a question; the twin answers in character, grounded in its
          retrieved documents — with citations, or an honest refusal.
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2">
        {personas.map((p) => (
          <button
            key={p.persona_id}
            onClick={() => {
              setSelected(p);
              setResponse(null);
            }}
            className="text-left"
          >
            <Card
              className={cn(
                "h-full transition-colors hover:border-primary/50",
                selected?.persona_id === p.persona_id &&
                  "border-primary ring-1 ring-primary",
              )}
            >
              <CardHeader>
                <CardTitle>{p.name}</CardTitle>
                <CardDescription>{p.tagline}</CardDescription>
              </CardHeader>
              <CardContent>
                <HexacoBars hexaco={p.hexaco} />
              </CardContent>
            </Card>
          </button>
        ))}
      </section>

      {selected && (
        <section className="space-y-3">
          <Textarea
            value={question}
            placeholder={`Ask ${selected.name} something…`}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="flex items-center gap-3">
            <Button onClick={() => void submit()} disabled={busy || !question.trim()}>
              {busy ? "asking…" : `Ask ${selected.name.split(" ")[0]}`}
            </Button>
            <span className="text-xs text-muted-foreground">
              {selected.doc_count} documents in this twin's corpus
            </span>
          </div>
        </section>
      )}

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="pt-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {response && <AnswerPanel response={response} />}

      <footer className="pt-4 text-xs text-muted-foreground">
        All personas are synthetic and fictional. Offline mode answers
        extractively via the deterministic mock provider.
      </footer>
    </main>
  );
}

function HexacoBars({ hexaco }: { hexaco: HexacoProfile }) {
  return (
    <div className="space-y-1">
      {(Object.keys(HEXACO_LABELS) as (keyof HexacoProfile)[]).map((key) => (
        <div key={key} className="flex items-center gap-2">
          <span className="w-7 text-[10px] uppercase text-muted-foreground">
            {HEXACO_LABELS[key].slice(0, 2)}
          </span>
          <div className="h-1.5 flex-1 rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary/70"
              style={{ width: `${hexaco[key] * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function AnswerPanel({ response }: { response: AskResponse }) {
  const [showDebug, setShowDebug] = useState(() => loadPrefs().debug);
  const routing = response.debug?.routing ?? null;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Answer</CardTitle>
          {response.answered ? (
            <Badge variant="accent">grounded · {response.citations.length} citations</Badge>
          ) : (
            <Badge variant="destructive">refused — not in the record</Badge>
          )}
        </div>
        <CardDescription>{response.question}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{response.answer}</p>

        {response.citations.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase text-muted-foreground">
              Citations
            </div>
            {response.citations.map((c) => (
              <div key={c.chunk_id} className="rounded-md bg-muted p-2 text-xs">
                <div className="font-mono text-[10px] text-muted-foreground">
                  {c.chunk_id} · score {c.score.toFixed(3)}
                </div>
                <div className="mt-1">{c.excerpt}</div>
              </div>
            ))}
          </div>
        )}

        {response.debug && (
          <div>
            <Button variant="ghost" onClick={() => setShowDebug(!showDebug)}>
              {showDebug ? "hide" : "show"} routing & timings
            </Button>
            {showDebug && (
              <div className="mt-2 space-y-1 rounded-md bg-muted p-3 font-mono text-xs">
                {routing && (
                  <>
                    <div>
                      provider: {routing.provider}/{routing.model} (objective:{" "}
                      {routing.objective})
                    </div>
                    {routing.estimated_cost_usd !== null && (
                      <div>cost: ${routing.estimated_cost_usd.toFixed(6)}</div>
                    )}
                    {routing.fallbacks_taken.length > 0 && (
                      <div>fallbacks: {routing.fallbacks_taken.join(" → ")}</div>
                    )}
                  </>
                )}
                {Object.entries(response.debug.stage_timings_ms).map(([stage, ms]) => (
                  <div key={stage}>
                    {stage}: {ms.toFixed(1)}ms
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
