// lib/clients/anthropic.ts — a thin, SDK-free client for the Anthropic Messages
// API, used by the read-only AI failure-triage feature (lib/aiTriage.ts).
//
// WHY direct fetch (no @anthropic-ai/sdk): this dashboard has exactly one AI
// surface and one call shape (a single forced-tool request). Pulling in the SDK
// would add a dependency + bundle weight for no benefit. We POST straight to
// `/v1/messages` with the documented headers.
//
// SECURITY: the API key is read from ANTHROPIC_API_KEY and sent ONLY as the
// `x-api-key` header. It is never logged, never echoed in an error message, and
// never returned to a caller. Error text from the API is truncated and the key
// (which never appears in a response body anyway) is not interpolated anywhere.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// The triage feature runs on Sonnet by default (a single structured call, not an
// agent — good grounding/cost balance), overridable per-deploy without a code
// change via ANTHROPIC_TRIAGE_MODEL.
const DEFAULT_TRIAGE_MODEL = "claude-sonnet-4-6";

export function anthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Resolve the model to use: explicit override → env → shipped default. Exported so
// callers (aiTriage) can report which model produced a diagnosis.
export function resolveTriageModel(override?: string): string {
  return override?.trim() || process.env.ANTHROPIC_TRIAGE_MODEL?.trim() || DEFAULT_TRIAGE_MODEL;
}

// A tool definition in the Messages-API shape. `input_schema` is a JSON Schema
// object describing the tool's arguments.
export type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AnthropicMessage = { role: "user" | "assistant"; content: string };

export type CallAnthropicToolArgs = {
  system: string;
  messages: AnthropicMessage[];
  tool: AnthropicTool;
  model?: string;
  maxTokens?: number;
};

// A `tool_use` content block as returned by the API.
type ToolUseBlock = { type: "tool_use"; name: string; input: unknown };
type ContentBlock = { type: string } & Partial<ToolUseBlock>;
type MessagesResponse = { content?: ContentBlock[]; stop_reason?: string };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Force the model to call exactly one tool and return that tool's typed `input`.
// tool_choice: {type:"tool", name} guarantees the model emits our schema rather
// than free text, so we never parse prose. Retries ONCE on 429 (rate limit) /
// 529 (overloaded) with a short backoff; other non-2xx statuses fail fast.
export async function callAnthropicTool<T>(args: CallAnthropicToolArgs): Promise<T> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const model = resolveTriageModel(args.model);
  const body = JSON.stringify({
    model,
    max_tokens: args.maxTokens ?? 1024,
    system: args.system,
    messages: args.messages,
    tools: [args.tool],
    // Force the structured output: the model MUST call submit_* and can't reply
    // with free text.
    tool_choice: { type: "tool", name: args.tool.name },
  });

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };

  let lastErr: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(500 * attempt); // backoff before the single retry

    const res = await fetch(ANTHROPIC_URL, { method: "POST", headers, body });
    if (res.ok) {
      const json = (await res.json()) as MessagesResponse;
      const block = (json.content ?? []).find(
        (b): b is ContentBlock & ToolUseBlock => b.type === "tool_use" && b.name === args.tool.name,
      );
      if (!block) {
        throw new Error(
          `Anthropic returned no ${args.tool.name} tool call (stop_reason: ${json.stop_reason ?? "?"})`,
        );
      }
      return block.input as T;
    }

    // Only 429 / 529 are worth retrying; everything else is a hard failure.
    const retryable = res.status === 429 || res.status === 529;
    lastErr = `Anthropic ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
    if (!retryable) throw new Error(lastErr);
  }
  throw new Error(lastErr ?? "Anthropic request failed");
}
