// Browser-side Ollama client. The extract action runs in Convex's cloud and
// can't reach a model on your machine — but the browser can. So when local
// Ollama is reachable we extract here (localhost) and submit the lines to Convex
// via `submitExtraction`. Requires Ollama to allow this origin, e.g.:
//   OLLAMA_ORIGINS=* ollama serve

// Try Ollama directly first (works when OLLAMA_ORIGINS allows this origin), then a
// CORS-injecting proxy on :11435 (a host-side container) which always allows it —
// so a cloud-served page can reach the host's Ollama without reconfiguring it.
const CANDIDATES = ["http://localhost:11434", "http://localhost:11435"];

const SYSTEM =
  "You extract line items from a vendor invoice into strict JSON. You ONLY read " +
  "values that appear in the document — never invent or compute. Return a JSON " +
  'object {"lines": [...]} where each line is ' +
  '{"description": string, "sku": string|null, "quantity": number, "unit": string, ' +
  '"unitPrice": number, "extension": number, "confidence": number (0..1), ' +
  '"sourceQuote": string}. Output JSON only.';

export interface OllamaLine {
  description: string;
  sku?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  extension: number;
  confidence: number;
  sourceQuote: string;
}

let probe: { url: string | null; models: string[]; at: number } | null = null;

// Probe Ollama: returns the reachable base URL (direct, else the CORS proxy) AND the
// list of models it actually has pulled, so callers can use a model that exists
// instead of guessing a name that 404s and forces a fallback.
export async function probeOllama(): Promise<{ url: string | null; models: string[] }> {
  const now = Date.now();
  if (probe && now - probe.at < 30_000) return { url: probe.url, models: probe.models };
  let url: string | null = null;
  let models: string[] = [];
  for (const base of CANDIDATES) {
    try {
      const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        url = base;
        const data = (await r.json()) as { models?: { name?: string; model?: string }[] };
        models = (data?.models ?? [])
          .map((m) => m.name ?? m.model ?? "")
          .filter((n): n is string => n.length > 0);
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  probe = { url, models, at: now };
  return { url, models };
}

// Choose the model to call: the user's configured model if Ollama actually has it
// (exact, or by family prefix like "llama3.1"), else whatever's installed, else the
// configured/default name as a last resort. Prevents a silent fallback when the
// configured/default model isn't pulled locally.
export function pickOllamaModel(configured: string | undefined, available: string[]): string {
  if (configured) {
    const fam = configured.split(":")[0];
    const hit = available.find((m) => m === configured || m.split(":")[0] === fam);
    if (hit) return hit;
  }
  return available[0] ?? configured ?? "llama3.1:8b";
}

function num(x: unknown): number {
  const n = typeof x === "string" ? parseFloat(x.replace(/[$,]/g, "")) : Number(x);
  return Number.isFinite(n) ? n : 0;
}

function parseLines(text: string): OllamaLine[] {
  let s = text.trim();
  if (s.includes("```")) s = s.split("```")[1]?.replace(/^json/i, "").trim() ?? s;
  const start = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0).concat(s.length));
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { lines?: unknown[] })?.lines)
      ? (parsed as { lines: unknown[] }).lines
      : [];
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
        confidence: Math.max(0, Math.min(1, num(o.confidence ?? 0.8))),
        sourceQuote: String(o.sourceQuote ?? o.source_quote ?? "").slice(0, 280),
      } satisfies OllamaLine;
    })
    .filter((l) => l.description.length > 0);
}

export async function extractWithOllama(
  rawText: string,
  model: string,
  base: string,
): Promise<OllamaLine[]> {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Extract every line item from this invoice:\n\n${rawText}` },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = await res.json();
  return parseLines(data?.message?.content ?? "");
}
