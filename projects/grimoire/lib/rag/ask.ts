// Ask-the-docs (FR-28) — RAG question-answering with citations. Retrieves the
// asker's readable chunks (permission-first — never sees or cites a doc they
// can't read), synthesizes an answer via the LLM router with inline [n] citations,
// and degrades to a "here are the relevant docs" listing when no provider is
// configured. Read-only; never writes or commits.

import { complete, type RouterDeps, type Mode } from "../llm";
import { retrieveReadableChunks } from "../search";
import type { Database } from "../db/types";
import type { Principal } from "../permissions";

export interface AskSource {
  n: number;
  path: string;
  title: string;
  headingPath: string;
}

export interface AskResult {
  answer: string;
  sources: AskSource[];
  provider: string;
}

const SYSTEM =
  "You answer questions using ONLY the provided context from the company's internal " +
  "docs. Cite the sources you use inline as [n]. If the context doesn't contain the " +
  "answer, say so plainly — do not invent. Respond in concise GitHub-Flavored Markdown.";

export async function askDocs(
  db: Database,
  principal: Principal,
  question: string,
  opts: { k?: number; deps?: RouterDeps; mode?: Mode } = {},
): Promise<AskResult> {
  const chunks = await retrieveReadableChunks(db, principal, question, opts.k ?? 6);

  // Stable, de-duplicated source list (by path), numbered for citations.
  const sources: AskSource[] = [];
  const seen = new Map<string, number>();
  for (const c of chunks) {
    if (!seen.has(c.path)) {
      seen.set(c.path, sources.length + 1);
      sources.push({ n: sources.length + 1, path: c.path, title: c.title, headingPath: c.headingPath });
    }
  }

  if (chunks.length === 0) {
    return {
      answer: "I couldn’t find anything relevant in the docs you have access to.",
      sources: [],
      provider: "none",
    };
  }

  const context = chunks
    .map((c) => {
      const n = seen.get(c.path);
      const where = c.headingPath ? `${c.path} › ${c.headingPath}` : c.path;
      return `[${n}] (${where})\n${c.text}`;
    })
    .join("\n\n");

  const offline = () =>
    "_(No AI provider configured — showing the most relevant docs instead of a synthesized answer.)_\n\n" +
    sources.map((s) => `${s.n}. **${s.title}** — \`${s.path}\``).join("\n");

  const res = await complete(
    { prompt: `Question: ${question}\n\nContext:\n${context}`, system: SYSTEM, offline, mode: opts.mode },
    opts.deps,
  );

  return { answer: res.text, sources, provider: res.provider };
}
