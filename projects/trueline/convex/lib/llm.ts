// The LLM only *reads* the invoice into a strict JSON shape — it never computes
// money or makes the flag decision (that is reconcile.ts, deterministic code).
// Plain fetch, so it runs in Convex's default runtime. Provider order:
// Anthropic (CO-Ver's exact provider) → OpenRouter free models → deterministic
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

export async function extractLineItems(rawText: string): Promise<ExtractResult> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const userMsg = `Extract every line item from this invoice:\n\n${rawText}`;

  if (anthropicKey) {
    const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
    try {
      const data = await post(
        "https://api.anthropic.com/v1/messages",
        { model, max_tokens: 2048, system: SYSTEM, messages: [{ role: "user", content: userMsg }] },
        { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      );
      const lines = coerceLines(parseJsonLoose(data?.content?.[0]?.text ?? ""));
      if (lines.length) return { lines, provider: "anthropic", model };
    } catch {
      /* fall through */
    }
  }

  if (openrouterKey) {
    const model = process.env.OPENROUTER_MODEL ?? "google/gemma-4-31b-it:free";
    try {
      const data = await post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: userMsg },
          ],
        },
        { authorization: `Bearer ${openrouterKey}` },
      );
      const lines = coerceLines(parseJsonLoose(data?.choices?.[0]?.message?.content ?? ""));
      if (lines.length) return { lines, provider: "openrouter", model };
    } catch {
      /* fall through */
    }
  }

  return { lines: parsePipeInvoice(rawText), provider: "mock", model: "deterministic" };
}
