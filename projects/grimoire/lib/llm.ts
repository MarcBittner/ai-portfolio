// Standardized multi-provider LLM router with a deterministic offline fallback.
// One reviewable chain, used by every AI feature:
//
//     paid (Anthropic / OpenAI)  →  local (Ollama)  →  free (OpenRouter)  →  offline
//
// A provider is *available* only when its key is set (or, for Ollama, when a probe
// succeeds), so the chain self-selects from the environment. The app always runs
// with zero keys: the offline path is a caller-supplied deterministic function, the
// last-resort safety net (never the design centre). `complete()` walks the chain,
// records which providers it fell back through, and returns the first success.
//
// Pure + dependency-free (uses global fetch), so it's unit-testable with an
// injected env / fetch and reusable from any Convex action.

export type Provider = "anthropic" | "openai" | "ollama" | "openrouter";
export type Mode = "auto" | "paid" | "local" | "free" | "offline";

export interface LLMResult {
  text: string;
  provider: Provider | "offline";
  model: string;
  mode: Mode;
  latencyMs: number;
  costUsd: number;
  fallbacks: Provider[]; // providers tried, then skipped/failed
}

export interface CompleteArgs {
  prompt: string;
  system?: string;
  maxTokens?: number;
  mode?: Mode;
  /** Deterministic last resort; always runs offline so the app never hard-fails. */
  offline: (prompt: string, system?: string) => string;
}

// Order within each tier. "auto" is the full standardized chain.
const CHAIN: Record<Mode, Provider[]> = {
  auto: ["anthropic", "openai", "ollama", "openrouter"],
  paid: ["anthropic", "openai"],
  local: ["ollama"],
  free: ["openrouter"],
  offline: [],
};

// Indicative blended $/Mtok (input, output) for the cost estimate. Free + local = 0.
const PRICE: Record<Provider, [number, number]> = {
  anthropic: [1.0, 5.0], // haiku-class
  openai: [0.15, 0.6], // gpt-4o-mini-class
  openrouter: [0, 0],
  ollama: [0, 0],
};

// ---- environment-driven configuration (injectable for tests) ----
export interface LLMEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OLLAMA_BASE_URL?: string;
  OLLAMA_MODEL?: string;
}

function envOf(e?: LLMEnv): LLMEnv {
  if (e) return e;
  // process.env at runtime (Convex action); guarded for non-Node test contexts.
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  return (p ?? {}) as LLMEnv;
}

function modelFor(provider: Provider, env: LLMEnv): string {
  switch (provider) {
    case "anthropic":
      return env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
    case "openai":
      return env.OPENAI_MODEL ?? "gpt-4o-mini";
    case "openrouter":
      return env.OPENROUTER_MODEL ?? "google/gemma-4-31b-it:free";
    case "ollama":
      return env.OLLAMA_MODEL ?? "llama3.1:8b";
  }
}

function ollamaUrl(env: LLMEnv): string {
  return (env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/+$/, "");
}

// ---- availability ----

export type Probe = (provider: Provider, env: LLMEnv) => Promise<boolean>;

async function defaultProbe(provider: Provider, env: LLMEnv): Promise<boolean> {
  switch (provider) {
    case "anthropic":
      return !!env.ANTHROPIC_API_KEY;
    case "openai":
      return !!env.OPENAI_API_KEY;
    case "openrouter":
      return !!env.OPENROUTER_API_KEY;
    case "ollama":
      try {
        const r = await fetch(`${ollamaUrl(env)}/api/tags`, {
          signal: AbortSignal.timeout(1500),
        });
        return r.ok;
      } catch {
        return false;
      }
  }
}

export function resolveMode(mode: Mode | undefined): Mode {
  return mode ?? "auto";
}

function estimateCost(provider: Provider, inTok: number, outTok: number): number {
  const [pi, po] = PRICE[provider];
  return (inTok / 1e6) * pi + (outTok / 1e6) * po;
}

// ---- per-provider call (returns text or throws) ----

type Caller = (
  provider: Provider,
  model: string,
  args: CompleteArgs,
  env: LLMEnv,
) => Promise<string>;

async function defaultCaller(
  provider: Provider,
  model: string,
  args: CompleteArgs,
  env: LLMEnv,
): Promise<string> {
  const maxTokens = args.maxTokens ?? 1024;
  if (provider === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: args.system,
        messages: [{ role: "user", content: args.prompt }],
      }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}`);
    const j = (await r.json()) as { content?: { text?: string }[] };
    return j.content?.map((c) => c.text ?? "").join("") ?? "";
  }

  // OpenAI-compatible chat completions (OpenAI + OpenRouter).
  if (provider === "openai" || provider === "openrouter") {
    const base =
      provider === "openai"
        ? "https://api.openai.com/v1"
        : "https://openrouter.ai/api/v1";
    const key = provider === "openai" ? env.OPENAI_API_KEY : env.OPENROUTER_API_KEY;
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key ?? ""}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          ...(args.system ? [{ role: "system", content: args.system }] : []),
          { role: "user", content: args.prompt },
        ],
      }),
    });
    if (!r.ok) throw new Error(`${provider} ${r.status}`);
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? "";
  }

  // Ollama generate.
  const r = await fetch(`${ollamaUrl(env)}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: args.system ? `${args.system}\n\n${args.prompt}` : args.prompt,
      stream: false,
    }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}`);
  const j = (await r.json()) as { response?: string };
  return j.response ?? "";
}

// ---- the router ----

export interface RouterDeps {
  env?: LLMEnv;
  probe?: Probe;
  caller?: Caller;
  now?: () => number;
}

/**
 * Walk the chain for the resolved mode, skipping unavailable providers and any
 * that throw, and return the first success. Falls back to the deterministic
 * offline function when no provider yields — so this never rejects.
 */
export async function complete(
  args: CompleteArgs,
  deps: RouterDeps = {},
): Promise<LLMResult> {
  const env = envOf(deps.env);
  const probe = deps.probe ?? defaultProbe;
  const caller = deps.caller ?? defaultCaller;
  const now = deps.now ?? (() => Date.now());
  const mode = resolveMode(args.mode);

  const fallbacks: Provider[] = [];
  for (const provider of CHAIN[mode]) {
    if (!(await probe(provider, env))) {
      fallbacks.push(provider);
      continue;
    }
    const model = modelFor(provider, env);
    const start = now();
    try {
      const text = await caller(provider, model, args, env);
      if (!text) throw new Error("empty completion");
      const latencyMs = now() - start;
      const outTok = Math.ceil(text.length / 4);
      const inTok = Math.ceil((args.prompt.length + (args.system?.length ?? 0)) / 4);
      return {
        text,
        provider,
        model,
        mode,
        latencyMs,
        costUsd: estimateCost(provider, inTok, outTok),
        fallbacks,
      };
    } catch {
      fallbacks.push(provider);
    }
  }

  // Deterministic offline safety net. This is the last resort, so it must not be
  // able to reject the router's promise — the "never throws" contract callers
  // (askDocs, ingest, categorize/clean) rely on. If the caller's offline function
  // itself throws, degrade to empty text rather than propagating the rejection.
  const start = now();
  let text: string;
  try {
    text = args.offline(args.prompt, args.system);
  } catch {
    text = "";
  }
  return {
    text,
    provider: "offline",
    model: "deterministic",
    mode,
    latencyMs: now() - start,
    costUsd: 0,
    fallbacks,
  };
}

/** Which providers are configured/reachable right now — drives /health + config UI. */
export async function status(deps: RouterDeps = {}): Promise<{
  mode: Mode;
  providers: Record<Provider, boolean>;
  offlineFallback: true;
}> {
  const env = envOf(deps.env);
  const probe = deps.probe ?? defaultProbe;
  const providers = {} as Record<Provider, boolean>;
  for (const p of ["anthropic", "openai", "ollama", "openrouter"] as Provider[]) {
    providers[p] = await probe(p, env);
  }
  return { mode: "auto", providers, offlineFallback: true };
}
