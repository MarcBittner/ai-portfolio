"use server";

import { askDocs, type AskResult } from "@/lib/rag/ask";
import { getRoutingConfig } from "@/app/actions/routing";
import { bootstrapIndexIfEmpty, currentPrincipal, db } from "@/lib/server/data";

export type AskResponse = AskResult | { answer: string; sources: []; provider: "none" };

/** Ask-the-docs: permission-scoped RAG answer with citations. */
export async function askAction(question: string): Promise<AskResponse> {
  const principal = await currentPrincipal();
  if (!principal) return { answer: "Not signed in.", sources: [], provider: "none" };
  if (!question.trim()) return { answer: "Ask a question.", sources: [], provider: "none" };
  await bootstrapIndexIfEmpty();
  const { mode } = await getRoutingConfig();
  return askDocs(await db(), principal, question, { mode });
}
