import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
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
  createPersona,
  HEXACO_LABELS,
  previewRedaction,
  type HexacoProfile,
  type PersonaCreated,
  type RedactionPreview,
} from "~/lib/api";
import { cn } from "~/lib/utils";
import { Nav } from "~/components/nav";

interface DocDraft {
  name: string;
  text: string;
}

const DEFAULT_HEXACO: HexacoProfile = {
  honesty_humility: 0.5,
  emotionality: 0.5,
  extraversion: 0.5,
  agreeableness: 0.5,
  conscientiousness: 0.5,
  openness: 0.5,
};

const FIELD =
  "w-full rounded-md border border-border bg-card px-3 py-2 text-sm shadow-xs " +
  "placeholder:text-muted-foreground focus-visible:outline-2 " +
  "focus-visible:outline-offset-1 focus-visible:outline-primary";

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function band(v: number): "low" | "mid" | "high" {
  if (v > 0.7) return "high";
  if (v < 0.4) return "low";
  return "mid";
}

export default function Builder() {
  const [name, setName] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [personaId, setPersonaId] = useState("");
  const [tagline, setTagline] = useState("");
  const [bio, setBio] = useState("");
  const [hexaco, setHexaco] = useState<HexacoProfile>(DEFAULT_HEXACO);
  const [voiceNotes, setVoiceNotes] = useState<string[]>([""]);
  const [docs, setDocs] = useState<DocDraft[]>([{ name: "", text: "" }]);
  const [preview, setPreview] = useState<RedactionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<PersonaCreated | null>(null);

  const effectiveId = idEdited ? personaId : slugify(name);

  // Debounced live redaction preview over documents with content.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    const filled = docs.filter((d) => d.text.trim());
    if (filled.length === 0) {
      setPreview(null);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      previewRedaction(
        filled.map((d) => ({ name: d.name, text: d.text })),
        ctrl.signal,
      )
        .then(setPreview)
        .catch(() => {
          /* aborted or transient; ignore */
        });
    }, 500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [docs]);

  function setDoc(i: number, patch: Partial<DocDraft>) {
    setDocs((prev) => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  }
  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    const read = await Promise.all(
      Array.from(files).map(
        (f) =>
          new Promise<DocDraft>((resolve) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                name: f.name.replace(/\.[^.]+$/, ""),
                text: String(reader.result ?? ""),
              });
            reader.readAsText(f);
          }),
      ),
    );
    setDocs((prev) => {
      const kept = prev.filter((d) => d.text.trim()); // drop empty placeholders
      return [...kept, ...read];
    });
  }
  function setVoice(i: number, value: string) {
    setVoiceNotes((prev) => prev.map((v, j) => (j === i ? value : v)));
  }

  const canSubmit =
    !!name.trim() &&
    !!tagline.trim() &&
    !!bio.trim() &&
    !!effectiveId &&
    docs.some((d) => d.text.trim()) &&
    !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createPersona({
        persona_id: effectiveId,
        name: name.trim(),
        tagline: tagline.trim(),
        bio: bio.trim(),
        hexaco,
        voice_notes: voiceNotes.map((v) => v.trim()).filter(Boolean),
        documents: docs
          .filter((d) => d.text.trim())
          .map((d) => ({ name: d.name, text: d.text })),
      });
      setCreated(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <main className="mx-auto max-w-3xl space-y-6 p-6 md:p-10">
        <Nav active="build" />
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>{created.persona.name} is live</CardTitle>
              <Badge variant="accent">{created.chunks} chunks ingested</Badge>
            </div>
            <CardDescription>{created.persona.tagline}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <RedactionSummary
              counts={created.redactions}
              empty="No PII detected in the source documents."
              prefix="Removed before anything was stored or embedded:"
            />
            <div className="flex gap-3">
              <Link to="/chat">
                <Button>Chat with {created.persona.name.split(" ")[0]}</Button>
              </Link>
              <Button
                variant="ghost"
                onClick={() => {
                  setCreated(null);
                  setName("");
                  setIdEdited(false);
                  setPersonaId("");
                  setTagline("");
                  setBio("");
                  setHexaco(DEFAULT_HEXACO);
                  setVoiceNotes([""]);
                  setDocs([{ name: "", text: "" }]);
                  setPreview(null);
                }}
              >
                Build another
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 md:p-10">
      <Nav active="build" />
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">build a twin</h1>
        <p className="text-sm text-muted-foreground">
          Define a synthetic persona, paste its documents, and watch PII get
          redacted live before anything is stored. On submit it's ingested and
          immediately queryable. Use fictional content only.
        </p>
      </header>

      <section className="space-y-3">
        <Field label="Name">
          <input
            className={FIELD}
            value={name}
            placeholder="Jo Rivera"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Persona id" hint="lowercase slug; used in chunk ids">
          <input
            className={cn(FIELD, "font-mono")}
            value={effectiveId}
            placeholder="jo-rivera"
            onChange={(e) => {
              setIdEdited(true);
              setPersonaId(slugify(e.target.value));
            }}
          />
        </Field>
        <Field label="Tagline">
          <input
            className={FIELD}
            value={tagline}
            placeholder="Trail runner, data engineer, reluctant sourdough evangelist"
            onChange={(e) => setTagline(e.target.value)}
          />
        </Field>
        <Field label="Bio">
          <Textarea
            value={bio}
            placeholder="A few sentences in the third person…"
            onChange={(e) => setBio(e.target.value)}
          />
        </Field>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase text-muted-foreground">
          HEXACO personality
        </h2>
        <p className="text-xs text-muted-foreground">
          Each dimension shapes the twin's voice (style never overrides
          grounding). Bands: &lt;0.4 low · 0.4–0.7 mid · &gt;0.7 high.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(Object.keys(HEXACO_LABELS) as (keyof HexacoProfile)[]).map((key) => (
            <div key={key} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span>{HEXACO_LABELS[key]}</span>
                <span className="font-mono text-muted-foreground">
                  {hexaco[key].toFixed(2)} · {band(hexaco[key])}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={hexaco[key]}
                onChange={(e) =>
                  setHexaco((prev) => ({ ...prev, [key]: Number(e.target.value) }))
                }
                className="w-full accent-primary"
              />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase text-muted-foreground">
          Voice notes
        </h2>
        {voiceNotes.map((v, i) => (
          <div key={i} className="flex gap-2">
            <input
              className={FIELD}
              value={v}
              placeholder="Dry, understated; quantifies everything"
              onChange={(e) => setVoice(i, e.target.value)}
            />
            <Button
              variant="ghost"
              onClick={() =>
                setVoiceNotes((prev) => prev.filter((_, j) => j !== i))
              }
              disabled={voiceNotes.length === 1}
            >
              ✕
            </Button>
          </div>
        ))}
        <Button variant="ghost" onClick={() => setVoiceNotes((p) => [...p, ""])}>
          + voice note
        </Button>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase text-muted-foreground">
            Documents <span className="normal-case">(the twin's grounding corpus)</span>
          </h2>
          {preview && (
            <RedactionBadges counts={preview.total_counts} total={preview.total} />
          )}
        </div>
        {docs.map((d, i) => (
          <Card key={i}>
            <CardContent className="space-y-2 pt-4">
              <div className="flex gap-2">
                <input
                  className={cn(FIELD, "font-mono")}
                  value={d.name}
                  placeholder={`document-${i + 1}`}
                  onChange={(e) => setDoc(i, { name: e.target.value })}
                />
                <Button
                  variant="ghost"
                  onClick={() => setDocs((prev) => prev.filter((_, j) => j !== i))}
                  disabled={docs.length === 1}
                >
                  ✕
                </Button>
              </div>
              <Textarea
                className="min-h-28"
                value={d.text}
                placeholder="Paste a journal entry, FAQ, notes… (fictional only)"
                onChange={(e) => setDoc(i, { text: e.target.value })}
              />
            </CardContent>
          </Card>
        ))}
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            onClick={() => setDocs((p) => [...p, { name: "", text: "" }])}
          >
            + document
          </Button>
          <label className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
            or upload .txt / .md
            <input
              type="file"
              multiple
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              className="hidden"
              onChange={(e) => void uploadFiles(e.target.files)}
            />
          </label>
        </div>
      </section>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="pt-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <div className="flex items-center gap-3 pb-10">
        <Button onClick={() => void submit()} disabled={!canSubmit}>
          {busy ? "creating…" : "Create twin"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Documents are redacted before they're stored or embedded.
        </span>
      </div>
    </main>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">
        {label}
        {hint && <span className="ml-2 font-normal italic">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function RedactionBadges({
  counts,
  total,
  quiet,
}: {
  counts: Record<string, number>;
  total: number;
  quiet?: boolean;
}) {
  if (total === 0) {
    return quiet ? null : (
      <span className="text-xs text-muted-foreground">no PII detected</span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {Object.entries(counts).map(([type, n]) => (
        <Badge key={type} variant="destructive">
          {n} {type.toLowerCase()}
        </Badge>
      ))}
    </div>
  );
}

function RedactionSummary({
  counts,
  prefix,
  empty,
}: {
  counts: Record<string, number>;
  prefix: string;
  empty: string;
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return <p className="text-muted-foreground">{empty}</p>;
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground">{prefix}</p>
      <RedactionBadges counts={counts} total={total} />
    </div>
  );
}
