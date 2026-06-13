// Browser-side Ollama client. The extract action runs in Convex's cloud and
// can't reach a model on your machine — but the browser can. So when local
// Ollama is reachable we extract here (localhost) and submit the lines to Convex
// via `submitExtraction`. Requires Ollama to allow this origin, e.g.:
//   OLLAMA_ORIGINS=* ollama serve

const OLLAMA = "http://localhost:11434";

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

let probe: { ok: boolean; at: number } | null = null;

// Cached reachability check from the browser (CORS-gated by OLLAMA_ORIGINS).
export async function probeOllama(): Promise<boolean> {
  const now = Date.now();
  if (probe && now - probe.at < 30_000) return probe.ok;
  let ok = false;
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) });
    ok = r.ok;
  } catch {
    ok = false;
  }
  probe = { ok, at: now };
  return ok;
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

export async function extractWithOllama(rawText: string, model: string): Promise<OllamaLine[]> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
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
