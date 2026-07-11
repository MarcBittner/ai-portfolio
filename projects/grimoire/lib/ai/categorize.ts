// AI document categorization (FR-30) — classifies an ingested document into the
// existing Space taxonomy and proposes docType / tags / a one-line summary, built
// on the standardized LLM router (lib/llm). Claude-first, with a deterministic
// offline heuristic so import never blocks when no provider is configured. Pure +
// injectable for tests. The result is PROPOSED metadata (front-matter), not a
// permission decision — it never routes around access control.

import { complete, type Mode, type RouterDeps } from "../llm";
import { extractHeadings } from "../markdown";

export const DOC_TYPES = [
  "guide",
  "reference",
  "spec",
  "runbook",
  "policy",
  "onboarding",
  "overview",
  "faq",
  "notes",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface CategorizeInput {
  title: string;
  content: string;
  /** Candidate Space keys to choose from (the classifier won't invent new ones). */
  spaces: string[];
}

export interface CategorySuggestion {
  spaceKey: string;
  docType: DocType;
  tags: string[];
  summary: string;
  status: string;
  provider: string;
}

const FALLBACK_SPACES = ["engineering", "onboarding", "product", "reference"];

const SYSTEM =
  "You are a documentation librarian for an internal company wiki. You file documents " +
  "into the EXISTING taxonomy. Respond with ONLY a compact JSON object — no prose, no " +
  "code fences, no commentary.";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function bodyText(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function firstSentence(md: string): string {
  const text = bodyText(md)
    .replace(/^#.*$/gm, "") // drop heading lines
    .replace(/[*_`>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const cut = text.slice(0, 200);
  const stop = cut.search(/[.!?]\s/);
  return (stop > 20 ? cut.slice(0, stop + 1) : cut).trim().slice(0, 180);
}

function candidateSpaces(spaces: string[]): string[] {
  const cleaned = spaces.filter((s) => s && s !== "root");
  return cleaned.length > 0 ? cleaned : FALLBACK_SPACES;
}

/** Heuristic classification — used offline and as the validator's floor. Scores
 *  each candidate space by how often its name appears in the title + body. */
function heuristic(input: CategorizeInput): CategorySuggestion {
  const spaces = candidateSpaces(input.spaces);
  const hay = `${input.title}\n${bodyText(input.content)}`.toLowerCase();
  let best = spaces.includes("reference") ? "reference" : spaces[0];
  let bestScore = -1;
  for (const s of spaces) {
    const token = s.toLowerCase();
    const score = (hay.match(new RegExp(`\\b${token.replace(/[^a-z0-9]/g, "")}\\b`, "g")) ?? []).length;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  const tags = extractHeadings(input.content)
    .filter((h) => h.depth >= 2)
    .map((h) => slugify(h.text))
    .filter(Boolean)
    .slice(0, 5);
  return {
    spaceKey: best,
    docType: "reference",
    tags,
    summary: firstSentence(input.content),
    status: "imported",
    provider: "offline",
  };
}

function buildPrompt(input: CategorizeInput): string {
  const spaces = candidateSpaces(input.spaces);
  const outline = extractHeadings(input.content)
    .slice(0, 14)
    .map((h) => `${"#".repeat(h.depth)} ${h.text}`)
    .join("\n");
  const excerpt = bodyText(input.content).slice(0, 2000);
  return [
    `Candidate spaces (pick the single best fit — do NOT invent new ones): ${spaces.join(", ")}`,
    `Candidate docTypes: ${DOC_TYPES.join(", ")}`,
    `Return exactly this JSON shape:`,
    `{"spaceKey": "<one candidate space>", "docType": "<one docType>", "tags": ["3-6 short lowercase kebab-case topics"], "summary": "one sentence, <=160 chars, no markdown"}`,
    `Title: ${input.title}`,
    outline ? `Outline:\n${outline}` : "",
    `Excerpt:\n${excerpt}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Classify a document. Always returns a usable suggestion (model output validated
 *  against the candidate taxonomy; heuristic fills any gaps). Never throws. */
export async function categorizeDoc(
  input: CategorizeInput,
  opts: { mode?: Mode; deps?: RouterDeps } = {},
): Promise<CategorySuggestion> {
  const floor = heuristic(input);
  const res = await complete(
    { prompt: buildPrompt(input), system: SYSTEM, maxTokens: 300, mode: opts.mode, offline: () => "" },
    opts.deps,
  );
  const parsed = res.text ? parseJson(res.text) : null;
  if (!parsed) return { ...floor, provider: res.provider };

  const spaces = candidateSpaces(input.spaces);
  const spaceKey =
    typeof parsed.spaceKey === "string" && spaces.includes(parsed.spaceKey)
      ? parsed.spaceKey
      : floor.spaceKey;
  const docType =
    typeof parsed.docType === "string" && (DOC_TYPES as readonly string[]).includes(parsed.docType)
      ? (parsed.docType as DocType)
      : floor.docType;
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((t) => slugify(String(t))).filter(Boolean).slice(0, 6)
    : floor.tags;
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.replace(/\s+/g, " ").trim().slice(0, 180)
      : floor.summary;

  return { spaceKey, docType, tags, summary, status: "imported", provider: res.provider };
}
