"use server";

import { canGlobal } from "@/lib/permissions";
import { repos, type AuditRow } from "@/lib/repos";
import { currentPrincipal, db, listReadableDocs } from "@/lib/server/data";

// Recent activity, permission-filtered so it can never leak doc names: doc
// entries are shown only for docs the principal can read; non-doc entries
// (roles/grants) only to admins who can manage permissions.
export interface ActivityItem {
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string;
  at: number;
  title?: string;
}

export async function getActivity(limit?: number): Promise<ActivityItem[]> {
  const principal = await currentPrincipal();
  if (!principal) return [];

  const readable = await listReadableDocs();
  const titleByPath = new Map(readable.map((d) => [d.path, d.title]));
  const isManager = canGlobal(principal, "managePermissions");

  const rows = await repos(await db()).audit.find();
  const items: ActivityItem[] = [];
  for (const row of rows as AuditRow[]) {
    if (row.targetType === "doc") {
      // Never leak names of docs the principal can't read.
      if (!titleByPath.has(row.targetId)) continue;
    } else if (!isManager) {
      // Permission/role changes are admin-only.
      continue;
    }
    items.push({
      actorEmail: row.actorEmail,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      at: row.at,
      title: row.targetType === "doc" ? titleByPath.get(row.targetId) : undefined,
    });
  }

  return items.sort((a, b) => b.at - a.at).slice(0, limit ?? 50);
}
