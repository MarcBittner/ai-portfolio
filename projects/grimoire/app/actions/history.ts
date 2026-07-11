"use server";

// Per-doc change history — a "version history" lite, sourced from the audit log.
// SECURITY: this app must never leak docs. We resolve the acting principal and
// return history ONLY when that principal may READ the doc (via getReadableDoc,
// which is null when the doc isn't readable). Anonymous/unauthorized callers, or
// callers without read access, always get an empty list.

import { repos, type AuditRow } from "@/lib/repos";
import { currentPrincipal, db, getReadableDoc } from "@/lib/server/data";

export interface HistoryItem {
  actorEmail: string;
  action: string;
  at: number;
}

/** The change timeline for a single doc, newest first (capped). Returns `[]` for
 *  anonymous callers or when the principal can't read the doc. */
export async function getDocHistory(path: string): Promise<HistoryItem[]> {
  const principal = await currentPrincipal();
  if (!principal) return [];

  // Must be able to READ the doc to see who changed it (never leak).
  const doc = await getReadableDoc(path);
  if (!doc) return [];

  const rows = (await repos(await db()).audit.find({
    targetType: "doc",
    targetId: path,
  })) as AuditRow[];

  // The audit collection has no server-side sort — order in JS (newest first).
  return rows
    .sort((a, b) => b.at - a.at)
    .slice(0, 30)
    .map((r) => ({ actorEmail: r.actorEmail, action: r.action, at: r.at }));
}
