import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  listPersonas,
  runInterview,
  type InterviewTranscript,
  type Persona,
} from "~/lib/api";
import { cn } from "~/lib/utils";
import { Nav } from "~/components/nav";

export async function clientLoader() {
  return { personas: await listPersonas() };
}

export default function Interview({
  loaderData,
}: {
  loaderData: { personas: Persona[] };
}) {
  const { personas } = loaderData;
  const [interviewer, setInterviewer] = useState(personas[0]?.persona_id ?? "");
  const [subject, setSubject] = useState(personas[1]?.persona_id ?? "");
  const [rounds, setRounds] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<InterviewTranscript | null>(null);

  const byId = Object.fromEntries(personas.map((p) => [p.persona_id, p]));
  const sameTwin = interviewer === subject;

  async function run() {
    if (sameTwin || busy) return;
    setBusy(true);
    setError(null);
    try {
      setTranscript(await runInterview(interviewer, subject, rounds));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 md:p-10">
      <Nav active="interview" />
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">twin vs twin</h1>
        <p className="text-sm text-muted-foreground">
          One twin interviews another. The subject answers in character,
          grounded in its own documents with citations — questions are drawn
          from the subject's corpus, then asked in the interviewer's voice.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <PersonaSelect
          label="Interviewer"
          personas={personas}
          value={interviewer}
          onChange={setInterviewer}
        />
        <PersonaSelect
          label="Subject (answers, grounded)"
          personas={personas}
          value={subject}
          onChange={setSubject}
        />
      </section>

      <section className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Rounds</span>
          <input
            type="number"
            min={1}
            max={6}
            value={rounds}
            onChange={(e) => setRounds(Number(e.target.value))}
            className="w-16 rounded-md border border-border bg-card px-2 py-1 text-sm"
          />
        </label>
        <Button onClick={() => void run()} disabled={busy || sameTwin}>
          {busy ? "interviewing…" : "Run interview"}
        </Button>
        {sameTwin && (
          <span className="text-xs text-destructive">
            pick two different twins
          </span>
        )}
      </section>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="pt-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {transcript && (
        <section className="space-y-4">
          {transcript.rounds.map((round, i) => (
            <Card key={i}>
              <CardHeader>
                <CardDescription className="text-xs uppercase">
                  {byId[transcript.interviewer_id]?.name ?? "interviewer"} asks
                </CardDescription>
                <CardTitle className="text-base font-medium">
                  {round.question}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs uppercase text-muted-foreground">
                    {byId[transcript.subject_id]?.name ?? "subject"}
                  </span>
                  {round.answered ? (
                    <Badge variant="accent">
                      grounded · {round.citations.length} citations
                    </Badge>
                  ) : (
                    <Badge variant="destructive">not in the record</Badge>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {round.answer}
                </p>
                {round.citations.length > 0 && (
                  <div className="space-y-1">
                    {round.citations.map((c) => (
                      <div
                        key={c.chunk_id}
                        className="rounded-md bg-muted p-2 text-xs"
                      >
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {c.chunk_id} · score {c.score.toFixed(3)}
                        </div>
                        <div className="mt-1">{c.excerpt}</div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      <footer className="pt-2 text-xs text-muted-foreground">
        All personas are synthetic. Offline mode uses the deterministic mock —
        questions are the corpus seeds; a real provider phrases them in voice.
      </footer>
    </main>
  );
}

function PersonaSelect({
  label,
  personas,
  value,
  onChange,
}: {
  label: string;
  personas: Persona[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "w-full rounded-md border border-border bg-card px-3 py-2 text-sm",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
        )}
      >
        {personas.map((p) => (
          <option key={p.persona_id} value={p.persona_id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
