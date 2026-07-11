// AI authoring assists (FR-13) — Expand / Draft / Proofread / Prose→Markdown,
// built on the standardized LLM router (lib/llm). Each returns a PROPOSED result
// the user reviews; nothing here commits or bypasses permissions. Every assist
// has a deterministic offline fallback, so the feature degrades instead of
// failing when no provider is configured. Pure + injectable for tests.

import { complete, type Mode, type RouterDeps } from "../llm";

export type AssistKind = "expand" | "draft" | "proofread" | "prose_to_markdown";

export interface AssistResult {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
  fallbacks: string[];
  // The exact prompt/system used, so a client can replay it against local Ollama
  // when the server had no cloud provider (provider === "offline").
  prompt: string;
  system: string;
}

interface PromptSpec {
  system: string;
  prompt: string;
  offline: (input: string) => string;
}

const SYSTEM_BASE =
  "You are a documentation assistant for an internal company wiki. Output clean " +
  "GitHub-Flavored Markdown only — no preamble, no code fences around the whole answer.";

function buildPrompt(kind: AssistKind, input: string): PromptSpec {
  switch (kind) {
    case "expand":
      return {
        system: SYSTEM_BASE,
        prompt: `Expand this terse note into a well-structured doc section — keep its meaning, add helpful detail, headings, and lists where useful:\n\n${input}`,
        offline: (t) =>
          `${t}\n\n_(Offline draft: no AI provider configured. Flesh out with detail, examples, and steps.)_`,
      };
    case "draft":
      return {
        system: SYSTEM_BASE,
        prompt: `Write a first-draft documentation page for the following title or outline:\n\n${input}`,
        offline: (t) =>
          `# ${t.trim().split("\n")[0] || "Untitled"}\n\n_(Offline draft scaffold — add an overview, steps, and references.)_\n`,
      };
    case "proofread":
      return {
        system:
          SYSTEM_BASE +
          " Fix grammar, clarity, and consistency. Preserve meaning and Markdown structure. Return the corrected document only.",
        prompt: `Proofread and correct this document:\n\n${input}`,
        offline: (t) => t, // no model: return unchanged (honest no-op)
      };
    case "prose_to_markdown":
      return {
        system:
          SYSTEM_BASE +
          " Convert the plain prose into well-structured Markdown (headings, lists, tables, links) without inventing content.",
        prompt: `Convert this prose into structured Markdown:\n\n${input}`,
        offline: (t) => t,
      };
  }
}

/** Run an assist. Returns the proposed text + routing telemetry. Never throws on
 *  provider failure — the offline fallback is the floor. */
export async function aiAssist(
  kind: AssistKind,
  input: string,
  opts: { mode?: Mode; deps?: RouterDeps } = {},
): Promise<AssistResult> {
  const spec = buildPrompt(kind, input);
  const res = await complete(
    { prompt: spec.prompt, system: spec.system, mode: opts.mode, offline: () => spec.offline(input) },
    opts.deps,
  );
  return {
    text: res.text,
    provider: res.provider,
    model: res.model,
    latencyMs: res.latencyMs,
    fallbacks: res.fallbacks,
    prompt: spec.prompt,
    system: spec.system,
  };
}
