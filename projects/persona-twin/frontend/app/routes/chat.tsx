import { useRef, useState } from "react";
import type { Route } from "./+types/chat";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import {
  listPersonas,
  streamChat,
  type Citation,
  type Persona,
  type RoutingDecision,
} from "~/lib/api";
import { cn } from "~/lib/utils";
import { Nav } from "~/components/nav";

export async function clientLoader() {
  return { personas: await listPersonas() };
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  answered?: boolean;
  citations?: Citation[];
  routing?: RoutingDecision | null;
  streaming?: boolean;
}

export default function Chat({ loaderData }: Route.ComponentProps) {
  const { personas } = loaderData;
  const [selected, setSelected] = useState<Persona>(personas[0]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionId = useRef<string | null>(null);

  function pickPersona(p: Persona) {
    setSelected(p);
    setMessages([]);
    setError(null);
    sessionId.current = null; // new persona ⇒ fresh conversation
  }

  // Patch the in-flight assistant message (always the last one).
  function patchLast(patch: Partial<ChatMessage>) {
    setMessages((prev) =>
      prev.map((m, i) => (i === prev.length - 1 ? { ...m, ...patch } : m)),
    );
  }

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setError(null);
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: message },
      { role: "assistant", content: "", streaming: true },
    ]);

    try {
      await streamChat(
        {
          persona_id: selected.persona_id,
          message,
          session_id: sessionId.current ?? undefined,
        },
        {
          onMeta: (sid) => (sessionId.current = sid),
          onToken: (text) =>
            setMessages((prev) =>
              prev.map((m, i) =>
                i === prev.length - 1 ? { ...m, content: m.content + text } : m,
              ),
            ),
          onCitations: (c) =>
            patchLast({ answered: c.answered, citations: c.citations }),
          onDone: (routing) => patchLast({ routing }),
          onError: (detail) => setError(detail),
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      patchLast({ streaming: false });
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 md:p-10">
      <Nav active="chat" />
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">chat with a twin</h1>
        <p className="text-sm text-muted-foreground">
          A multi-turn conversation: the twin answers in character, streamed
          token-by-token and grounded in its retrieved documents — citations
          attached once each answer lands.
        </p>
      </header>

      <section className="flex flex-wrap gap-2">
        {personas.map((p) => (
          <button
            key={p.persona_id}
            onClick={() => pickPersona(p)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm transition-colors hover:border-primary/50",
              selected.persona_id === p.persona_id
                ? "border-primary bg-primary/10 font-medium"
                : "border-border",
            )}
          >
            {p.name}
          </button>
        ))}
      </section>

      <section className="space-y-4">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Say hello to {selected.name} — ask about their work, then follow up.
          </p>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} personaName={selected.name} />
        ))}
      </section>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="pt-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <section className="sticky bottom-4 space-y-2">
        <Textarea
          value={input}
          placeholder={`Message ${selected.name}…`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex items-center gap-3">
          <Button onClick={() => void send()} disabled={busy || !input.trim()}>
            {busy ? "…" : "Send"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {sessionId.current
              ? "conversation in progress — the twin remembers this thread"
              : "new conversation"}
          </span>
        </div>
      </section>

      <footer className="pt-2 text-xs text-muted-foreground">
        All personas are synthetic. Offline mode streams the deterministic mock
        provider; conversation memory is in-process for this demo.
      </footer>
    </main>
  );
}

function MessageBubble({
  message,
  personaName,
}: {
  message: ChatMessage;
  personaName: string;
}) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}>
      <span className="px-1 text-[10px] uppercase text-muted-foreground">
        {isUser ? "you" : personaName}
      </span>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-2 text-sm leading-relaxed",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        <p className="whitespace-pre-wrap">
          {message.content}
          {message.streaming && <span className="animate-pulse">▍</span>}
        </p>
      </div>

      {!isUser && !message.streaming && message.answered === false && (
        <Badge variant="destructive">refused — not in the record</Badge>
      )}

      {!isUser && message.citations && message.citations.length > 0 && (
        <div className="max-w-[85%] space-y-1">
          {message.citations.map((c) => (
            <div key={c.chunk_id} className="rounded-md bg-muted/60 p-2 text-xs">
              <div className="font-mono text-[10px] text-muted-foreground">
                {c.chunk_id} · score {c.score.toFixed(3)}
              </div>
              <div className="mt-1">{c.excerpt}</div>
            </div>
          ))}
        </div>
      )}

      {!isUser && message.routing && (
        <span className="px-1 font-mono text-[10px] text-muted-foreground">
          {message.routing.provider}/{message.routing.model}
        </span>
      )}
    </div>
  );
}
