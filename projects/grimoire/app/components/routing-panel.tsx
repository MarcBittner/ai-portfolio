"use client";

import { useEffect, useState, useTransition } from "react";

import { Badge, Button, Card } from "./ui";
import { probeOllama } from "@/app/lib/ollama";
import { setRoutingConfig, type RoutingConfig } from "@/app/actions/routing";
import type { RoutingStatus } from "@/app/actions/ai";
import type { Mode } from "@/lib/llm";

const LABEL: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  ollama: "Ollama (local)",
  openrouter: "OpenRouter",
};

const MODE_OPTS: { value: Mode; label: string }[] = [
  { value: "auto", label: "Auto — Anthropic → OpenAI → local → OpenRouter → offline" },
  { value: "paid", label: "Paid only — Anthropic → OpenAI" },
  { value: "free", label: "Free — OpenRouter" },
  { value: "local", label: "Local only — your Ollama (in browser)" },
  { value: "offline", label: "Offline — deterministic, no network" },
];

type Row = { key: string; available: boolean; detail: string };

/** LLM routing status + configuration. Cloud providers come from the server (env
 *  keys); local Ollama is probed HERE, in the browser — a cloud server can't
 *  reach a model on your machine, but this page can.
 *  Admins can change the mode + prefer-local preference. */
export function RoutingPanel({
  cloud,
  embeddings,
  config,
  editable,
}: RoutingStatus & { config: RoutingConfig; editable: boolean }) {
  const [ollama, setOllama] = useState<{ reachable: boolean; models: string[] } | null>(null);
  const [mode, setMode] = useState<Mode>(config.mode);
  const [preferLocal, setPreferLocal] = useState(config.preferLocal);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  useEffect(() => {
    let live = true;
    probeOllama()
      .then((p) => live && setOllama({ reachable: !!p.url, models: p.models }))
      .catch(() => live && setOllama({ reachable: false, models: [] }));
    return () => {
      live = false;
    };
  }, []);

  const dirty = mode !== config.mode || preferLocal !== config.preferLocal;
  function save() {
    setStatus(null);
    startSave(async () => {
      const res = await setRoutingConfig({ mode, preferLocal });
      setStatus(res.ok ? "Saved ✓ — new requests use this routing." : res.error ?? "Save failed");
    });
  }

  const rows: Row[] = [
    { key: "anthropic", available: cloud.anthropic, detail: cloud.anthropic ? "configured" : "no key" },
    { key: "openai", available: cloud.openai, detail: cloud.openai ? "configured" : "no key" },
    {
      key: "ollama",
      available: !!ollama?.reachable,
      detail:
        ollama === null
          ? "probing your browser…"
          : ollama.reachable
            ? `reachable · ${ollama.models.slice(0, 3).join(", ") || "no models pulled"}`
            : "not reachable from this browser",
    },
    { key: "openrouter", available: cloud.openrouter, detail: cloud.openrouter ? "configured" : "no key" },
  ];
  const active = rows.find((r) => r.available)?.key ?? "offline";

  return (
    <Card className="mt-6">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">AI routing</h2>
        <Badge tone={active === "offline" ? "warn" : "ok"}>
          {active === "offline" ? "offline (deterministic)" : `active: ${LABEL[active] ?? active}`}
        </Badge>
      </div>

      {/* Configuration */}
      <div className="mb-4 space-y-3">
        <label className="block text-sm">
          <span className="text-[--color-muted]">Routing mode</span>
          <select
            value={mode}
            disabled={!editable || saving}
            onChange={(e) => setMode(e.target.value as Mode)}
            className="mt-1 w-full rounded-md border border-[--color-line] bg-[--color-surface] px-2 py-1.5 text-sm disabled:opacity-60"
          >
            {MODE_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={preferLocal}
            disabled={!editable || saving}
            onChange={(e) => setPreferLocal(e.target.checked)}
            className="mt-0.5 accent-[--color-accent]"
          />
          <span>
            <span className="font-medium text-[--color-ink]">Prefer local Ollama when available</span>
            <span className="block text-xs text-[--color-muted]">
              AI surfaces that can reach your browser Ollama use it first (private, no cost)
              before falling back to the server providers.
            </span>
          </span>
        </label>
        {editable ? (
          <div className="flex items-center gap-3">
            <Button variant="primary" disabled={!dirty || saving} onClick={save}>
              {saving ? "Saving…" : "Save routing"}
            </Button>
            {status && <span className="text-xs text-[--color-muted]">{status}</span>}
          </div>
        ) : (
          <p className="text-xs text-[--color-muted]">Admins can change these settings.</p>
        )}
      </div>

      <p className="mb-2 text-xs text-[--color-muted]">
        The chain below is walked in order; the first available provider handles the request.
        Cloud keys are set via environment; <b>local Ollama is detected in your browser</b> (run{" "}
        <code>OLLAMA_ORIGINS=* ollama serve</code> so this origin is allowed).
      </p>
      <ol className="space-y-1.5">
        {rows.map((r, i) => (
          <li key={r.key} className="flex items-center gap-2 text-sm">
            <span className="w-4 text-xs text-[--color-muted]">{i + 1}.</span>
            <span
              className={"h-2 w-2 shrink-0 rounded-full " + (r.available ? "bg-[--color-ok]" : "bg-[--color-line]")}
              aria-hidden
            />
            <span className={r.available ? "text-[--color-ink]" : "text-[--color-muted]"}>
              {LABEL[r.key] ?? r.key}
            </span>
            {r.key === active && <Badge tone="accent">in use</Badge>}
            <span className="ml-auto truncate pl-2 text-xs text-[--color-muted]">{r.detail}</span>
          </li>
        ))}
        <li className="flex items-center gap-2 text-sm">
          <span className="w-4 text-xs text-[--color-muted]">5.</span>
          <span className="h-2 w-2 shrink-0 rounded-full bg-[--color-ok]" aria-hidden />
          <span className="text-[--color-ink]">Offline fallback</span>
          <span className="ml-auto text-xs text-[--color-muted]">always on</span>
        </li>
      </ol>
      <div className="mt-3 border-t border-[--color-line] pt-3 text-xs text-[--color-muted]">
        Embeddings: <span className="text-[--color-ink]">{embeddings.provider}</span> ({embeddings.dim}-dim)
      </div>
    </Card>
  );
}
