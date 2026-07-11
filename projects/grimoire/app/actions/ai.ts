"use server";

import { aiAssist, type AssistKind } from "@/lib/ai/actions";
import { status, type Provider, type Mode } from "@/lib/llm";
import { embeddingProvider, EMBED_DIM } from "@/lib/rag/embeddings";
import { getRoutingConfig } from "@/app/actions/routing";
import { currentPrincipal } from "@/lib/server/data";

export interface AssistResponse {
  ok: boolean;
  text?: string;
  provider?: string;
  fallbacks?: string[];
  error?: string;
  // Present so the client can replay against local Ollama when provider==="offline".
  prompt?: string;
  system?: string;
}

/** Run an AI authoring assist on the given text. Requires a signed-in principal
 *  (any role — assists never write or bypass permissions; they only propose). */
export async function assistAction(
  kind: AssistKind,
  input: string,
  modeOverride?: Mode,
): Promise<AssistResponse> {
  const principal = await currentPrincipal();
  if (!principal) return { ok: false, error: "Not signed in." };
  if (!input.trim()) return { ok: false, error: "Nothing to work on." };
  // modeOverride lets the client fetch the built prompt cheaply (mode "offline")
  // when it intends to run the completion on local Ollama in the browser.
  const mode = modeOverride ?? (await getRoutingConfig()).mode;
  const r = await aiAssist(kind, input, { mode });
  return {
    ok: true,
    text: r.text,
    provider: r.provider,
    fallbacks: r.fallbacks,
    prompt: r.prompt,
    system: r.system,
  };
}

export interface RoutingStatus {
  /** Cloud/hosted provider availability from server-side config (env keys). Ollama
   *  is intentionally NOT probed here: it runs on the user's machine and is only
   *  reachable from the browser, so the client probes it (see RoutingPanel). */
  cloud: Record<Exclude<Provider, "ollama">, boolean>;
  embeddings: { provider: string; dim: number };
}

/** Live LLM routing configuration for the config pane. Requires a signed-in
 *  principal. Cloud providers come from configured keys; local Ollama is detected
 *  client-side because a cloud server can't reach a model on your machine. */
export async function routingStatus(): Promise<RoutingStatus | { error: string }> {
  const principal = await currentPrincipal();
  if (!principal) return { error: "Not signed in." };

  const s = await status();
  const ep = embeddingProvider();
  return {
    cloud: {
      anthropic: s.providers.anthropic,
      openai: s.providers.openai,
      openrouter: s.providers.openrouter,
    },
    embeddings: { provider: ep, dim: EMBED_DIM[ep] },
  };
}
