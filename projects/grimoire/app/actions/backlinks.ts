"use server";

// Backlinks server action — "which docs link to this one", permission-scoped.
// SECURITY: this app must never leak docs. We resolve the acting principal and
// compute backlinks ONLY over the docs that principal may READ (via the shared,
// permission-filtered listReadableDocs). A doc the caller can't read can never
// appear as a backlink source — even if it links to the target.

import { computeBacklinks } from "@/lib/backlinks";
import { repos } from "@/lib/repos";
import { currentPrincipal, db, listReadableDocs } from "@/lib/server/data";

/** Inbound links to `path`, restricted to docs the current principal can read.
 *  Returns `[]` for anonymous/unauthorized callers. */
export async function getBacklinks(path: string): Promise<{ path: string; title: string }[]> {
  const principal = await currentPrincipal();
  if (!principal) return [];

  // The permission-filtered universe: only docs this principal may read.
  const readable = await listReadableDocs();
  const titleByPath = new Map(readable.map((d) => [d.path, d.title]));

  // Fetch bodies for just those readable docs (no unfiltered doc scan).
  const docsRepo = repos(await db()).docs;
  const bodies = await Promise.all(
    readable.map(async (d) => {
      const row = await docsRepo.findOne({ path: d.path });
      return { path: d.path, body: row?.body ?? "" };
    }),
  );

  const sourcePaths = computeBacklinks(bodies, path);
  return sourcePaths.map((p) => ({ path: p, title: titleByPath.get(p) ?? p }));
}
