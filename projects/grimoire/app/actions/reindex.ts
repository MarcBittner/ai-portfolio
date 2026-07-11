"use server";

import { canGlobal } from "@/lib/permissions";
import { reindexDocChunks } from "@/lib/rag/pipeline";
import { repos } from "@/lib/repos";
import { currentPrincipal, db } from "@/lib/server/data";

/**
 * Backfill embeddings for the WHOLE corpus (Admin/Super only). Re-chunks + re-embeds every
 * indexed doc into the `chunks` collection so semantic search + Ask-the-docs cover docs that
 * predate the pipeline (or a provider/model change). Idempotent: each doc's prior chunks are
 * replaced. Returns how many docs were processed and how many chunks were (re)written.
 */
export async function reindexEmbeddings(): Promise<{ docs: number; chunks: number } | { error: string }> {
  const principal = await currentPrincipal();
  if (!principal || !canGlobal(principal, "managePermissions")) {
    return { error: "Admins only." };
  }

  const database = await db();
  const docs = await repos(database).docs.find();
  let chunks = 0;
  for (const doc of docs) {
    chunks += await reindexDocChunks(database, doc.path, doc.body, doc.spaceKey);
  }
  return { docs: docs.length, chunks };
}
