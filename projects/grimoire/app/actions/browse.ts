"use server";

import { repos } from "@/lib/repos";
import { currentPrincipal, db, listReadableDocs } from "@/lib/server/data";

/** A doc as shown on the Browse page — the readable listing enriched with the
 *  metadata fields (status/owner/tags/updatedAt/summary) that live on DocRow. */
export interface BrowseDoc {
  path: string;
  title: string;
  spaceKey: string;
  status?: string;
  owner?: string;
  tags?: string[];
  updatedAt: number;
  summary?: string;
}

/**
 * Every doc the current principal may read, with browse metadata. The readable
 * set from `listReadableDocs()` is the security boundary — we only ever return
 * docs in that set, enriched from their DocRow. (No principal → nothing.)
 */
export async function getBrowseDocs(): Promise<BrowseDoc[]> {
  const principal = await currentPrincipal();
  if (!principal) return [];

  const readable = await listReadableDocs();
  if (readable.length === 0) return [];

  const rows = await repos(await db()).docs.find();
  const byPath = new Map(rows.map((d) => [d.path, d]));

  const out: BrowseDoc[] = [];
  for (const { path, title, spaceKey } of readable) {
    const row = byPath.get(path);
    out.push({
      path,
      title,
      spaceKey,
      status: row?.status,
      owner: row?.owner,
      tags: row?.tags,
      updatedAt: row?.updatedAt ?? 0,
      summary: row?.summary,
    });
  }
  return out;
}
