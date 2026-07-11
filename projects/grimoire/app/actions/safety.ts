"use server";

import { canGlobal } from "@/lib/permissions";
import { scanContent, worstSeverity, type SafetyHit, type Severity } from "@/lib/safety";
import { repos } from "@/lib/repos";
import { currentPrincipal, db, listReadableDocs } from "@/lib/server/data";

// Content-safety audit — scans the corpus for material that shouldn't be exposed
// team-wide (secrets, PII/HR, offensive language). Admin-only, and scoped to the
// caller's readable set (never surfaces a doc outside their read scope). Read-only.

export interface SafetyFinding {
  path: string;
  title: string;
  spaceKey: string;
  worst: Severity;
  hits: SafetyHit[]; // contexts already redacted by the scanner
}

export interface SafetyReport {
  scanned: number;
  findings: SafetyFinding[];
}

const ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export async function safetyAudit(): Promise<SafetyReport | { error: string }> {
  const principal = await currentPrincipal();
  if (!principal) return { error: "Not signed in." };
  if (!canGlobal(principal, "managePermissions")) return { error: "Admins only." };

  const readable = new Set((await listReadableDocs()).map((d) => d.path));
  const rows = (await repos(await db()).docs.find()).filter((d) => readable.has(d.path));

  const findings: SafetyFinding[] = [];
  for (const d of rows) {
    const hits = scanContent(d.body ?? "");
    if (hits.length === 0) continue;
    findings.push({
      path: d.path,
      title: d.title,
      spaceKey: d.spaceKey,
      worst: worstSeverity(hits) as Severity,
      hits: hits.slice(0, 10),
    });
  }
  findings.sort((a, b) => ORDER[a.worst] - ORDER[b.worst]);
  return { scanned: rows.length, findings };
}
