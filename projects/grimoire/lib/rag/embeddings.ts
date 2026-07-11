// Embeddings adapter — the vectorizer behind RAG/semantic search (FR-28/29). Mirrors
// lib/llm.ts: an env-driven, injectable, telemetry-light router that self-selects a
// provider from whichever key is present and ALWAYS has a deterministic, key-free offline
// path so the app runs (and tests pass) with zero configuration.
//
//     voyage (Anthropic-recommended)  →  openai  →  local hash embedder (offline)
//
// Anthropic ships no first-party embeddings, so Voyage AI is the recommended paid provider
// (architecture.md §5.1). The local fallback is a hashing bag-of-words embedder: token →
// stable hash → dimension bucket, L2-normalized. It's intentionally crude (no semantics
// beyond lexical overlap) but deterministic and dependency-free — good enough to keep
// semantic search degraded-but-working, and to make retrieval tests reproducible.
//
// Pure aside from `fetch` (injectable), so it's unit-testable with a stubbed env + fetch.

export type EmbeddingProvider = "voyage" | "openai" | "local";

/** Output dimensionality per provider. `local` is fixed; the remote dims match the
 *  default models below (a switch to another model must update these in lockstep). */
export const EMBED_DIM: Record<EmbeddingProvider, number> = {
  voyage: 1024, // voyage-3
  openai: 1536, // text-embedding-3-small
  local: 256, // fixed hash-embedder dimension
};

// ---- environment-driven configuration (injectable for tests) ----
export interface EmbeddingsEnv {
  EMBEDDINGS_PROVIDER?: string;
  VOYAGE_API_KEY?: string;
  VOYAGE_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_EMBED_MODEL?: string;
}

function envOf(e?: EmbeddingsEnv): EmbeddingsEnv {
  if (e) return e;
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  return (p ?? {}) as EmbeddingsEnv;
}

/**
 * Pick the active provider from the environment. An explicit `EMBEDDINGS_PROVIDER` is
 * honored only when its key is present (otherwise it'd fail at call time); failing that we
 * take the first remote provider whose key is set; failing that, the always-available
 * local embedder. So the app self-selects and never hard-requires a key.
 */
export function embeddingProvider(env?: EmbeddingsEnv): EmbeddingProvider {
  const e = envOf(env);
  const want = e.EMBEDDINGS_PROVIDER?.toLowerCase();
  if (want === "voyage" && e.VOYAGE_API_KEY) return "voyage";
  if (want === "openai" && e.OPENAI_API_KEY) return "openai";
  if (want === "local") return "local";
  if (e.VOYAGE_API_KEY) return "voyage";
  if (e.OPENAI_API_KEY) return "openai";
  return "local";
}

function modelFor(provider: EmbeddingProvider, env: EmbeddingsEnv): string {
  switch (provider) {
    case "voyage":
      return env.VOYAGE_MODEL ?? "voyage-3";
    case "openai":
      return env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small";
    case "local":
      return "hash-256";
  }
}

// ---- local deterministic hash embedder ----

/** FNV-1a 32-bit hash — stable across runs/processes (no Math.random, no Date). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

/** Lexical bag-of-words → fixed-dim vector, L2-normalized. Deterministic. */
function localEmbed(text: string): number[] {
  const dim = EMBED_DIM.local;
  const v = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const tok of tokens) v[fnv1a(tok) % dim] += 1;
  return l2normalize(v);
}

// ---- remote callers (OpenAI-compatible response shape) ----

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

interface EmbeddingsResponse {
  data?: { embedding?: number[] }[];
}

async function remoteEmbed(
  provider: "voyage" | "openai",
  texts: string[],
  env: EmbeddingsEnv,
  fetchImpl: FetchLike,
): Promise<number[][]> {
  const model = modelFor(provider, env);
  const url =
    provider === "voyage"
      ? "https://api.voyageai.com/v1/embeddings"
      : "https://api.openai.com/v1/embeddings";
  const key = provider === "voyage" ? env.VOYAGE_API_KEY : env.OPENAI_API_KEY;

  const r = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key ?? ""}`,
    },
    body: JSON.stringify({ input: texts, model }),
  });
  if (!r.ok) throw new Error(`${provider} embeddings ${r.status}`);
  const j = (await r.json()) as EmbeddingsResponse;
  return (j.data ?? []).map((d) => d.embedding ?? []);
}

// ---- the adapter ----

export interface EmbedOptions {
  env?: EmbeddingsEnv;
  /** Force a provider (skips env selection) — handy for tests + re-index jobs. */
  provider?: EmbeddingProvider;
  /** Injectable fetch (defaults to global fetch) for unit-testing remote providers. */
  fetchImpl?: FetchLike;
}

/**
 * Embed a batch of texts into vectors. Selects the provider from the environment (or
 * `opts.provider`); the local hash embedder is the always-available offline fallback, so
 * this never requires a key. Returns one vector per input, in order.
 */
export async function embed(
  texts: string[],
  opts: EmbedOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const env = envOf(opts.env);
  const provider = opts.provider ?? embeddingProvider(env);

  if (provider === "local") return texts.map(localEmbed);

  const fetchImpl = (opts.fetchImpl ?? (globalThis.fetch as unknown)) as FetchLike;
  return remoteEmbed(provider, texts, env, fetchImpl);
}
