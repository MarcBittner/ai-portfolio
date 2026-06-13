"use client";

import { useEffect, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Nav } from "@/app/components/nav";

type Mode = "auto" | "local" | "free" | "paid" | "offline";

const MODES: { id: Mode; label: string; blurb: string }[] = [
  { id: "auto", label: "Auto", blurb: "Local if reachable, else paid, else free, else offline." },
  { id: "local", label: "Local", blurb: "Ollama on your machine (if reachable). Private; no cost." },
  { id: "free", label: "Free", blurb: "OpenRouter free models. No cost; rate-limited." },
  { id: "paid", label: "Paid", blurb: "Anthropic / Claude. Best quality; your key." },
  { id: "offline", label: "Offline", blurb: "Deterministic engine. No model, no network." },
];

// The provider chain each mode tries, in order (offline always terminal).
const CHAIN: Record<Mode, string[]> = {
  auto: ["Ollama (local)", "Anthropic (paid)", "OpenRouter (free)", "Offline (deterministic)"],
  local: ["Ollama (local)", "Offline (deterministic)"],
  free: ["OpenRouter (free)", "Offline (deterministic)"],
  paid: ["Anthropic (paid)", "Offline (deterministic)"],
  offline: ["Offline (deterministic)"],
};

export default function Configuration() {
  const { isAuthenticated } = useConvexAuth();
  const cfg = useQuery(api.routing.get);
  const save = useMutation(api.routing.set);

  const [mode, setMode] = useState<Mode>("auto");
  const [model, setModel] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (cfg) {
      setMode(cfg.mode);
      setModel(cfg.model ?? "");
    }
  }, [cfg]);

  if (!isAuthenticated || cfg === undefined) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-8">
        <Nav />
        <p className="text-sm text-[--color-muted]">connecting…</p>
      </main>
    );
  }

  const placeholder =
    mode === "paid"
      ? cfg.defaultPaidModel
      : mode === "free"
        ? cfg.defaultFreeModel
        : mode === "local"
          ? cfg.defaultLocalModel
          : "—";

  async function onSave() {
    await save({ mode, model: model.trim() || undefined });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <Nav />
      <h1 className="text-lg font-semibold">LLM routing configuration</h1>
      <p className="mb-5 mt-1 text-sm text-[--color-muted]">
        Define how invoice extraction is routed. The model only reads the document into
        structured JSON; all math and flagging is deterministic code regardless of mode.
      </p>

      {/* mode selector */}
      <section className="glass p-5">
        <div className="text-sm font-semibold">Mode</div>
        <div className="mt-3 grid gap-2 sm:grid-cols-5">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className="rounded-lg border p-3 text-left transition-colors"
              style={{
                borderColor: mode === m.id ? "var(--color-accent)" : "var(--color-line)",
                background:
                  mode === m.id ? "color-mix(in oklab, var(--color-accent) 14%, transparent)" : "transparent",
              }}
            >
              <div className="text-sm font-medium">{m.label}</div>
              <div className="mt-0.5 text-xs text-[--color-muted]">{m.blurb}</div>
            </button>
          ))}
        </div>

        <div className="mt-4">
          <label className="text-xs text-[--color-muted]">
            Model override {mode === "offline" ? "(not used in offline mode)" : "(blank = default)"}
          </label>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={placeholder}
            disabled={mode === "offline"}
            className="mt-1 w-full rounded-md border border-[--color-line] bg-black/20 px-3 py-2 text-sm disabled:opacity-40"
          />
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={onSave}
            className="rounded-md bg-[--color-accent] px-4 py-2 text-sm font-medium text-[--color-accent-ink]"
          >
            Save routing
          </button>
          {saved && <span className="text-sm text-[--color-ok]">✓ saved</span>}
        </div>
      </section>

      {/* explicit routing chain */}
      <section className="glass mt-4 p-5">
        <div className="text-sm font-semibold">Resolved routing — “{mode}”</div>
        <ol className="mt-3 space-y-1 text-sm">
          {CHAIN[mode].map((step, i) => (
            <li key={step} className="flex items-center gap-2">
              <span className="grid h-5 w-5 place-items-center rounded-full bg-white/10 text-xs">
                {i + 1}
              </span>
              <span>{step}</span>
              {i < CHAIN[mode].length - 1 && (
                <span className="text-[--color-muted]">→ on failure</span>
              )}
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-[--color-muted]">
          Right now a run resolves to <b className="text-[--color-ink]">{cfg.activeMode}</b>.
        </p>
      </section>

      {/* provider status */}
      <section className="glass mt-4 p-5">
        <div className="text-sm font-semibold">Provider status</div>
        <div className="mt-3 space-y-2 text-sm">
          <Row
            ok={cfg.keys.local}
            label="Local — Ollama"
            detail={
              cfg.keys.local
                ? `reachable · ${cfg.defaultLocalModel}`
                : "set OLLAMA_BASE_URL (to a reachable host) to enable"
            }
          />
          <Row
            ok={cfg.keys.paid}
            label="Paid — Anthropic / Claude"
            detail={cfg.keys.paid ? `key set · ${cfg.defaultPaidModel}` : "no ANTHROPIC_API_KEY"}
          />
          <Row
            ok={cfg.keys.free}
            label="Free — OpenRouter"
            detail={
              cfg.keys.free
                ? `key set · ${cfg.defaultFreeModel} (50 req/day free cap)`
                : "no OPENROUTER_API_KEY"
            }
          />
          <Row ok label="Offline — deterministic engine" detail="always available · no network" />
        </div>
        <p className="mt-3 text-xs text-[--color-muted]">
          Provider API keys are set server-side on the Convex deployment (never in the browser).
          This page selects which of the available providers a run uses.
        </p>
      </section>
    </main>
  );
}

function Row({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-2">
      <span style={{ color: ok ? "#43c98a" : "#8b93a7" }}>{ok ? "●" : "○"}</span>
      <span className="font-medium">{label}</span>
      <span className="text-xs text-[--color-muted]">— {detail}</span>
    </div>
  );
}
