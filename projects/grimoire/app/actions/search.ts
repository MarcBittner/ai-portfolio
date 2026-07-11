"use server";

import { searchReadable, type SearchResult } from "@/lib/search";
import { sweepExpiredDocs } from "@/lib/reaper";
import { bootstrapIndexIfEmpty, currentPrincipal, db } from "@/lib/server/data";

/** Permission-scoped search (keyword + semantic). Returns only readable hits. */
export async function searchAction(query: string): Promise<SearchResult[]> {
  const principal = await currentPrincipal();
  if (!principal) return [];
  const database = await db();
  await bootstrapIndexIfEmpty();
  // Reap expired guest docs before searching so a stale ephemeral doc can never
  // surface as a search hit.
  try {
    await sweepExpiredDocs(database);
  } catch {
    /* best-effort */
  }
  return searchReadable(database, principal, query);
}
