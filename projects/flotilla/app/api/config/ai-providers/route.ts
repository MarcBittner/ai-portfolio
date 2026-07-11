import { withOperator, ok, safeRead } from "@/lib/api";
import { probeCloudAiProviders } from "@/lib/aiProviders";
import { getConfigValues } from "@/lib/models";
import { CHAIN } from "@/lib/aiRouter";
import { OLLAMA_DEFAULT_BASE_URL } from "@/lib/ollamaSetup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/config/ai-providers — a live status snapshot of the Ask-AI provider
// chain for the Config → AI Providers panel. Operator-gated, READ-ONLY.
//
// It probes only the SERVER-reachable providers (cloud APIs + the built-in
// deterministic map — see lib/aiProviders.ts) and returns the RESOLVED ollamaUrl
// so the browser can probe the local Ollama daemon itself. It deliberately does
// NOT probe Ollama: a server on Vercel cannot reach the operator's localhost, so
// a server-side result would always read "unreachable" and mislead. `safeRead`
// degrades to an empty-but-honest payload if the config store is unreachable.
export async function GET() {
  const ollamaOrder = CHAIN.indexOf("ollama");
  const fallback = {
    cloud: [],
    ollama: {
      id: "ollama",
      label: "Ollama (local)",
      order: ollamaOrder,
      url: OLLAMA_DEFAULT_BASE_URL,
    },
    selected: "auto",
  };
  return withOperator(() =>
    safeRead("ai-providers unavailable", fallback, async () => {
      // The cloud probes need no store; the resolved config gives us the Ollama
      // URL (stored ?? OLLAMA_URL ?? default) and the configured chain-start.
      const [cloud, values] = await Promise.all([
        probeCloudAiProviders(),
        getConfigValues(),
      ]);
      return ok({
        cloud,
        ollama: {
          id: "ollama",
          label: "Ollama (local)",
          order: ollamaOrder,
          url: values.ollamaUrl,
        },
        selected: values.aiProvider ?? "auto",
      });
    }),
  );
}
