// The LLM only *reads* the invoice into a strict JSON shape — it never computes
// money or makes the flag decision (that is reconcile.ts, deterministic code).
// Plain fetch, so it runs in Convex's default runtime. Provider order:
// Anthropic (the paid path) → OpenRouter free models → deterministic
// mock, so the pipeline always completes, even with zero API keys.

import { type ExtractedLine, parsePipeInvoice } from "./parse";

export type { ExtractedLine };

export interface ExtractResult {
  lines: ExtractedLine[];
  provider: string;
  model: string;
}

const SYSTEM =
  "You extract line items from a vendor invoice into strict JSON. You ONLY read " +
  "values that appear in the document — never invent or compute. Return a JSON " +
  'object {"lines": [...]} where each line is ' +
  '{"description": string, "sku": string|null, "quantity": number, "unit": string, ' +
  '"unitPrice": number, "extension": number, "confidence": number (0..1), ' +
  '"sourceQuote": string}. confidence reflects how legible/certain the source was. ' +
  "sourceQuote is the verbatim snippet the numbers came from. Output JSON only.";

function coerceLines(raw: unknown): ExtractedLine[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { lines?: unknown[] })?.lines)
      ? (raw as { lines: unknown[] }).lines
      : [];
  const num = (x: unknown) => {
    const n = typeof x === "string" ? parseFloat(x.replace(/[$,]/g, "")) : Number(x);
    return Number.isFinite(n) ? n : 0;
  };
  return arr
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      return {
        description: String(o.description ?? "").trim(),
        sku: o.sku ? String(o.sku).trim() : undefined,
        quantity: num(o.quantity),
        unit: String(o.unit ?? "ea").trim(),
        unitPrice: num(o.unitPrice ?? o.unit_price),
        extension: num(o.extension),
        confidence: Math.max(0, Math.min(1, num(o.confidence ?? 0.75))),
        sourceQuote: String(o.sourceQuote ?? o.source_quote ?? "").slice(0, 280),
      } satisfies ExtractedLine;
    })
    .filter((l) => l.description.length > 0);
}

function parseJsonLoose(text: string): unknown {
  const fenced = text.includes("```") ? text.split("```")[1]?.replace(/^json/i, "") : text;
  const s = (fenced ?? text).trim();
  const candidates = [s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0);
  const start = candidates.length ? Math.min(...candidates) : 0;
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function post(url: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export const DEFAULT_FREE_MODEL = process.env.OPENROUTER_MODEL ?? "google/gemma-4-31b-it:free";
export const DEFAULT_PAID_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
export const DEFAULT_LOCAL_MODEL = process.env.OLLAMA_MODEL ?? "llama3.1:8b";
// Autodetected: we probe this base URL and use local Ollama whenever it answers.
// Defaults to localhost so a self-hosted / co-located deployment needs zero
// config; override with OLLAMA_BASE_URL (e.g. a tunnel).
export const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

export type RoutingMode = "auto" | "local" | "free" | "paid" | "offline";

export function keyStatus() {
  return {
    free: !!process.env.OPENROUTER_API_KEY, // OpenRouter free models
    paid: !!process.env.ANTHROPIC_API_KEY, // Anthropic / Claude
  };
}

// Cached reachability probe (GET /api/tags) so a run doesn't pay the network
// cost every time; ~60s TTL. Returns false fast if the host can't be reached.
let _ollamaProbe: { ok: boolean; at: number } | null = null;
export async function ollamaReachable(): Promise<boolean> {
  const now = Date.now();
  if (_ollamaProbe && now - _ollamaProbe.at < 60_000) return _ollamaProbe.ok;
  let ok = false;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    ok = r.ok;
  } catch {
    ok = false;
  }
  _ollamaProbe = { ok, at: now };
  return ok;
}

async function callOllama(model: string, userMsg: string): Promise<ExtractedLine[]> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMsg },
      ],
    }),
    signal: AbortSignal.timeout(8000), // fail fast if the host isn't reachable
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = await res.json();
  return coerceLines(parseJsonLoose(data?.message?.content ?? ""));
}

async function callAnthropic(model: string, userMsg: string): Promise<ExtractedLine[]> {
  const data = await post(
    "https://api.anthropic.com/v1/messages",
    { model, max_tokens: 2048, system: SYSTEM, messages: [{ role: "user", content: userMsg }] },
    { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
  );
  return coerceLines(parseJsonLoose(data?.content?.[0]?.text ?? ""));
}

async function callOpenRouter(model: string, userMsg: string): Promise<ExtractedLine[]> {
  const data = await post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMsg },
      ],
    },
    { authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` },
  );
  return coerceLines(parseJsonLoose(data?.choices?.[0]?.message?.content ?? ""));
}

// Honor the tenant's explicit routing config. The deterministic offline engine
// is always the terminal fallback, so a run completes even with no/failed model.
export async function extractLineItems(
  rawText: string,
  routing: { mode?: RoutingMode; model?: string } = {},
): Promise<ExtractResult> {
  const mode = routing.mode ?? "auto";
  const userMsg = `Extract every line item from this invoice:\n\n${rawText}`;
  const { free, paid } = keyStatus();
  // autodetect local Ollama (cached probe) when the mode could use it
  const localUp = mode === "auto" || mode === "local" ? await ollamaReachable() : false;

  // provider attempt order, defined explicitly by mode. auto prefers detected
  // local Ollama → paid → free → offline.
  const order: ("ollama" | "anthropic" | "openrouter")[] =
    mode === "offline"
      ? []
      : mode === "local"
        ? localUp
          ? ["ollama"]
          : []
        : mode === "free"
          ? ["openrouter"]
          : mode === "paid"
            ? ["anthropic"]
            : localUp
              ? ["ollama", "anthropic", "openrouter"]
              : ["anthropic", "openrouter"]; // auto

  for (const provider of order) {
    try {
      if (provider === "ollama") {
        const model = routing.model || DEFAULT_LOCAL_MODEL;
        const lines = await callOllama(model, userMsg);
        if (lines.length) return { lines, provider, model };
      }
      if (provider === "anthropic" && paid) {
        const model = routing.model || DEFAULT_PAID_MODEL;
        const lines = await callAnthropic(model, userMsg);
        if (lines.length) return { lines, provider, model };
      }
      if (provider === "openrouter" && free) {
        const model = routing.model || DEFAULT_FREE_MODEL;
        const lines = await callOpenRouter(model, userMsg);
        if (lines.length) return { lines, provider, model };
      }
    } catch {
      /* try the next provider, then the offline fallback */
    }
  }

  return { lines: parsePipeInvoice(rawText), provider: "mock", model: "deterministic" };
}
