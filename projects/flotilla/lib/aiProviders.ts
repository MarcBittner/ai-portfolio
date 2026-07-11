// lib/aiProviders.ts — live status probes for the Ask-AI provider chain.
//
// SPLIT-BY-REACHABILITY (the whole reason this file exists): the providers in the
// fallback chain (see lib/aiRouter.ts CHAIN) do NOT all live in the same place, so
// they cannot all be probed from the same place:
//   - CLOUD providers (anthropic, openai, free=OpenRouter) + the built-in
//     `deterministic` map are reachable from the SERVER — the server holds the
//     keys and can reach those public HTTPS APIs. They are probed HERE.
//   - `ollama` runs on the OPERATOR'S OWN machine (localhost:11434). A server on
//     Vercel cannot reach the operator's localhost, so a server-side probe would
//     always read "unreachable" and be MISLEADING. Ollama is therefore probed
//     CLIENT-side, in the operator's browser — see app/app/config/page.tsx. This
//     module deliberately does NOT probe Ollama.
//
// SECURITY: keys are read from env and sent ONLY as the documented auth header on
// a GET; they are never returned to a caller, never logged, never interpolated
// into a status/detail. Each probe is wrapped so a failure DEGRADES (a status),
// never throws — the whole panel is read-only advice.

import { CHAIN, type AiProvider } from "./aiRouter.ts";

// Per-provider liveness. `not_configured` = no key in env (nothing to probe);
// `unreachable` = the request threw (network / timeout / DNS); `error` = the API
// answered but not 200 (e.g. a bad/expired key → 401). `live` = a 200.
export type CloudProviderStatus =
  | "live"
  | "not_configured"
  | "unreachable"
  | "error";

// A cloud provider probed on the server. `order` is the provider's index in the
// router's fallback CHAIN, so the UI can render the chain-order label ("1st"…)
// and keep every surface in the same canonical order.
export type CloudProviderId = "anthropic" | "openai" | "free" | "deterministic";
export type CloudProviderProbe = {
  id: CloudProviderId;
  label: string;
  status: CloudProviderStatus;
  detail?: string;
  order: number;
};

// A minimal fetch surface so tests can inject a stub without pulling in DOM libs.
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

const PROBE_TIMEOUT_MS = 3500;

const LABELS: Record<CloudProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  free: "OpenRouter (free tier)",
  deterministic: "Deterministic (built-in)",
};

// The provider's canonical position in the router fallback chain.
function orderOf(id: AiProvider): number {
  return CHAIN.indexOf(id as Exclude<AiProvider, "auto">);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A bounded GET that NEVER throws: resolves to the response summary, or an
// `{ error }` marker when the request throws (network / timeout / abort).
async function timedGet(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number } | { error: string }> {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { error: reason(err) };
  }
}

// Map a GET result to a status: a throw ⇒ unreachable; a non-200 ⇒ error (with
// the status code as detail, never the key); a 200 ⇒ live.
function classify(
  r: { ok: boolean; status: number } | { error: string },
): { status: CloudProviderStatus; detail?: string } {
  if ("error" in r) return { status: "unreachable", detail: r.error };
  if (r.ok) return { status: "live" };
  return { status: "error", detail: `HTTP ${r.status}` };
}

// Run one probe, wrapped so any unexpected throw still degrades to a status.
async function safeProbe(
  id: CloudProviderId,
  fn: () => Promise<{ status: CloudProviderStatus; detail?: string }>,
): Promise<CloudProviderProbe> {
  const base = { id, label: LABELS[id], order: orderOf(id) };
  try {
    return { ...base, ...(await fn()) };
  } catch (err) {
    return { ...base, status: "error", detail: reason(err) };
  }
}

// anthropic — GET /v1/models with the x-api-key + anthropic-version headers.
async function probeAnthropic(
  fetchImpl: FetchLike,
  env: NodeJS.ProcessEnv,
): Promise<CloudProviderProbe> {
  return safeProbe("anthropic", async () => {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) return { status: "not_configured" };
    return classify(
      await timedGet(fetchImpl, "https://api.anthropic.com/v1/models", {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      }),
    );
  });
}

// openai — GET /v1/models with the Authorization bearer header.
async function probeOpenai(
  fetchImpl: FetchLike,
  env: NodeJS.ProcessEnv,
): Promise<CloudProviderProbe> {
  return safeProbe("openai", async () => {
    const key = env.OPENAI_API_KEY;
    if (!key) return { status: "not_configured" };
    return classify(
      await timedGet(fetchImpl, "https://api.openai.com/v1/models", {
        authorization: `Bearer ${key}`,
      }),
    );
  });
}

// free = OpenRouter — GET /api/v1/key (a cheap authed endpoint) with the bearer.
async function probeFree(
  fetchImpl: FetchLike,
  env: NodeJS.ProcessEnv,
): Promise<CloudProviderProbe> {
  return safeProbe("free", async () => {
    const key = env.OPENROUTER_API_KEY;
    if (!key) return { status: "not_configured" };
    return classify(
      await timedGet(fetchImpl, "https://openrouter.ai/api/v1/key", {
        authorization: `Bearer ${key}`,
      }),
    );
  });
}

// probeCloudAiProviders — probe every SERVER-reachable provider in parallel and
// return them in fallback-chain order. `deterministic` (the local keyword map) is
// always live. `fetchImpl` is injectable for tests; `env` defaults to process.env.
// Ollama is intentionally absent — it is probed client-side (see the panel UI).
export async function probeCloudAiProviders(
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CloudProviderProbe[]> {
  const [anthropic, openai, free] = await Promise.all([
    probeAnthropic(fetchImpl, env),
    probeOpenai(fetchImpl, env),
    probeFree(fetchImpl, env),
  ]);
  const deterministic: CloudProviderProbe = {
    id: "deterministic",
    label: LABELS.deterministic,
    status: "live",
    order: orderOf("deterministic"),
  };
  // Return in canonical chain order (anthropic 0, openai 1, [ollama 2], free 3,
  // deterministic 4) — ollama is the gap the client fills in.
  return [anthropic, openai, free, deterministic].sort(
    (a, b) => a.order - b.order,
  );
}
