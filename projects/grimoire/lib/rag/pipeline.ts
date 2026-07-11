// Chunk-and-embed pipeline — keeps the `chunks` vector collection in sync with a
// doc. Runs whenever a doc is indexed/saved (per-path), so semantic search +
// Ask-the-docs stay current. Uses the local embedder by default (zero-key); a
// Voyage/OpenAI key upgrades quality transparently.

import { chunkMarkdown } from "./chunker";
import { embed } from "./embeddings";
import { repos } from "../repos";
import type { Database } from "../db/types";

/** Re-chunk + re-embed a doc, replacing its prior chunks. Returns the chunk count. */
export async function reindexDocChunks(
  db: Database,
  path: string,
  content: string,
  spaceKey: string,
): Promise<number> {
  const r = repos(db);
  await r.chunks.delete({ path });
  const chunks = chunkMarkdown(path, content, { spaceKey });
  if (chunks.length === 0) return 0;
  const vectors = await embed(chunks.map((c) => c.text));
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    await r.chunks.insert({
      path,
      spaceKey: c.spaceKey,
      headingPath: c.headingPath,
      charStart: c.charStart,
      charEnd: c.charEnd,
      text: c.text,
      vector: vectors[i],
    });
  }
  return chunks.length;
}

export async function removeDocChunks(db: Database, path: string): Promise<void> {
  await repos(db).chunks.delete({ path });
}
