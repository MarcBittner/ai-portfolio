// Browser→host Ollama bridge.
//
// persona-twin's chat answer is just prose generation from a SYSTEM + user
// prompt. The cloud server (Render/Cloud Run) can never reach a model on YOUR
// machine — only the browser can. So for the local tier the browser asks the
// server to /chat/prepare (retrieval + prompt build, NO provider call → the
// exact SYSTEM + user prompt), runs that prompt on the host's Ollama from this
// page, and POSTs the completion back to /chat as `client_completion`, where
// the server still validates citations against the same retrieved set.
//
// We try Ollama directly on :11434 (works when OLLAMA_ORIGINS allows this
// origin), then a CORS-injecting proxy on :11435 — so even a cloud-served page
// can reach a host Ollama. Any failure (no host, model error) is non-fatal:
// the caller falls back to the normal server chat request.

const OLLAMA_CANDIDATES = ["http://localhost:11434", "http://localhost:11435"];
const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_500;
const NARRATE_TIMEOUT_MS = 120_000;

export interface OllamaProbe {
  base: string | null; // reachable base URL, or null when no host Ollama
  models: string[]; // installed model names
  at: number; // probe timestamp (for caching)
}

let cached: OllamaProbe = { base: null, models: [], at: 0 };

// Probe the host's Ollama (cached for PROBE_TTL_MS). Returns the first
// reachable candidate and its installed models, or {base:null} if none answers.
export async function probeOllama(force = false): Promise<OllamaProbe> {
  const now = Date.now();
  if (!force && now - cached.at < PROBE_TTL_MS) return cached;
  let base: string | null = null;
  let models: string[] = [];
  for (const candidate of OLLAMA_CANDIDATES) {
    try {
      const r = await fetch(`${candidate}/api/tags`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (r.ok) {
        base = candidate;
        const data = await r.json();
        models = (data.models ?? [])
          .map((m: { name?: string; model?: string }) => m.name ?? m.model)
          .filter(Boolean);
        break;
      }
    } catch {
      // candidate unreachable — try the next
    }
  }
  cached = { base, models, at: now };
  return cached;
}

// Pick a host model: the configured one if Ollama actually has it (exact or by
// family prefix), else whatever's installed, else a sensible default name.
export function pickModel(configured: string | null, available: string[]): string {
  if (configured) {
    const family = configured.split(":")[0];
    const hit = available.find((m) => m === configured || m.split(":")[0] === family);
    if (hit) return hit;
  }
  return available[0] ?? configured ?? "llama3.1:8b";
}

// Run ONE generation on the host's Ollama: send the server-built SYSTEM + user
// prompt verbatim with stream:false and return the assistant's plain text.
export async function ollamaChat(
  base: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const r = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(NARRATE_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}`);
  const data = await r.json();
  const text = data?.message?.content ?? "";
  if (!text) throw new Error("ollama returned empty content");
  return text;
}
