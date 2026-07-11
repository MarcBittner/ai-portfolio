import { withOperator, ok, safeRead } from "@/lib/api";
import { queryLogs, listAudit, getInstance, type LogQuery } from "@/lib/models";
import {
  fromSystemLog,
  fromAudit,
  fromVercel,
  mergeEntries,
  filterBySource,
  filterByInstance,
  buildLinks,
  type UnifiedSource,
  type UnifiedEntry,
  type LogLinks,
} from "@/lib/logSources";
import { makeVercelClient } from "@/lib/clients/vercel";
import { makeLogger } from "@/lib/logtap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNIFIED_SOURCES: ReadonlySet<string> = new Set(["system", "audit", "vercel"]);

// Best-effort pull of a selected instance's live Vercel build/runtime logs.
// Convex/Clerk have no clean pull API, so they're deep-linked (see buildLinks) —
// only Vercel is fetched live. Any failure (no token, stub, API error) degrades
// to [] so the consolidated stream still renders our own events.
async function fetchVercelEntries(
  deploymentIdOrUrl: string,
  instanceId: string,
  limit: number,
): Promise<UnifiedEntry[]> {
  try {
    const vercel = makeVercelClient({ log: makeLogger(() => {}).for("vercel") });
    const raw = await vercel.getDeploymentLogs(deploymentIdOrUrl, { limit });
    return raw.map((e) => fromVercel(e, instanceId));
  } catch {
    return [];
  }
}

// GET /api/logs — the consolidated event log (B-3). Aggregates the dashboard's
// OWN events (system `flotilla_logs` + operator `flotilla_audit`) and, when a specific
// instance is selected, LIVE Vercel deployment logs for it — one ordered,
// newest-first stream. Convex + Clerk are deep-linked (`links`), not pulled
// (Convex log streams are push-only/Pro; Clerk has no general logs API).
//
// Query: ?instanceId=&source=(system|audit|vercel)&limit=
// Returns: { entries, links: { convex?, clerk? } }. The unified `entries` stream is
// the single source of truth. PERF-R2 (Tier-A A3): a legacy `logs: sysDocs` field
// (raw system LogDocs) used to be emitted ALONGSIDE `entries`, ~doubling the
// payload (measured 222KB / 500 rows, ~18× the next biggest). It has been removed
// and its only consumer (the instance-detail Live-logs panel) migrated to `entries`.
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const instanceId = sp.get("instanceId") ?? undefined;
  const sourceRaw = sp.get("source") ?? undefined;
  const source =
    sourceRaw && UNIFIED_SOURCES.has(sourceRaw) ? (sourceRaw as UnifiedSource) : undefined;
  // PERF-R2 (A3): lower the DEFAULT page size 500 → 200 (the 222KB payload was
  // mostly unread tail). The hard cap stays 2000 so an explicit ?limit= still works.
  const limitRaw = Number(sp.get("limit") ?? "200");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 2000) : 200;

  return withOperator(() =>
    safeRead("logs unavailable", { entries: [], links: {} }, async () => {
      // System logs (scoped to the instance when one is selected).
      const sysQuery: LogQuery = { instanceId, limit };
      const [sysDocs, auditDocs] = await Promise.all([queryLogs(sysQuery), listAudit(limit)]);

      const systemEntries = sysDocs.map(fromSystemLog);
      const auditEntries = auditDocs.map(fromAudit);

      // Vercel logs + Convex/Clerk deep-links only make sense scoped to one
      // instance (they target a single deployment / auth instance).
      let vercelEntries: UnifiedEntry[] = [];
      let links: LogLinks = {};
      if (instanceId) {
        const inst = await getInstance(instanceId);
        if (inst) {
          links = buildLinks(inst);
          const deploymentRef = inst.vercelDeploymentId ?? inst.url;
          // Skip the live pull when the caller filtered to a non-vercel source.
          if (deploymentRef && (!source || source === "vercel")) {
            vercelEntries = await fetchVercelEntries(deploymentRef, instanceId, limit);
          }
        }
      }

      let entries = mergeEntries(systemEntries, auditEntries, vercelEntries);
      entries = filterBySource(entries, source);
      entries = filterByInstance(entries, instanceId);
      entries = entries.slice(0, limit);

      return ok({ entries, links });
    }),
  );
}
