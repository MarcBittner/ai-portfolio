// Browser-side Ollama client. Server actions run in Render's cloud and can't
// reach a model on your machine — but the browser can. So Ollama is detected AND
// invoked here (localhost): the
// cloud router handles paid/hosted providers; local Ollama is a client-side
// fallback the page probes and calls directly.
//
// Direct localhost works when Ollama allows this origin (OLLAMA_ORIGINS=* ollama
// serve); the :11435 candidate is a host-side CORS-injecting proxy that always
// allows it, so a cloud-served page can reach host Ollama without reconfiguring.

const CANDIDATES = ["http://localhost:11434", "http://localhost:11435"];
const DEFAULT_MODEL = "llama3.1:8b";

export interface OllamaProbe {
  url: string | null; // reachable base URL, or null if not detected
  models: string[]; // models actually pulled locally
}

let cached: { probe: OllamaProbe; at: number } | null = null;

/** Probe local Ollama from the browser: returns the reachable base URL (direct,
 *  else the CORS proxy) and the installed models. Cached for 30s. */
export async function probeOllama(): Promise<OllamaProbe> {
  const now = Date.now();
  if (cached && now - cached.at < 30_000) return cached.probe;
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
  const probe = { url, models };
  cached = { probe, at: now };
  return probe;
}

/** Choose a model to call: the configured one if installed (exact or by family
 *  prefix like "llama3.1"), else whatever's installed, else a sane default. */
export function pickOllamaModel(configured: string | undefined, available: string[]): string {
  if (configured) {
    const fam = configured.split(":")[0];
    const hit = available.find((m) => m === configured || m.split(":")[0] === fam);
    if (hit) return hit;
  }
  return available[0] ?? configured ?? DEFAULT_MODEL;
}

/** Run a chat completion against local Ollama and return the text. Throws on a
 *  non-OK response so callers can fall back. */
export async function completeWithOllama(args: {
  prompt: string;
  system?: string;
  model: string;
  base: string;
}): Promise<string> {
  const res = await fetch(`${args.base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: args.model,
      stream: false,
      messages: [
        ...(args.system ? [{ role: "system", content: args.system }] : []),
        { role: "user", content: args.prompt },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return data?.message?.content ?? "";
}
