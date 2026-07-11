import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { getFeatureFlags, listMonitors, listAllStates } from "@/lib/models";
import type { MonitorState } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/monitoring/overview — the tactical rollup for the Monitoring tab.
// read-only. Joins each monitor with its per-target state and totals the fleet.
export async function GET() {
  return withOperator(async () => {
    const empty = { totals: { ok: 0, warn: 0, crit: 0, unknown: 0 }, monitors: [] as unknown[] };
    return safeRead("monitoring overview unavailable", empty, async () => {
      // Fold the flag read into the data batch so the gate check no longer serializes
      // ahead of the (independent) reads (performance-plan §Area 1 / P1). The gate is
      // still enforced BEFORE any monitor data leaves the handler — the speculative
      // reads are read-only and their results are discarded when the flag is off.
      const [flags, monitors, states] = await Promise.all([getFeatureFlags(), listMonitors(), listAllStates()]);
      if (!flags.monitoring) return bad("monitoring feature is disabled", 403);
      const byMonitor = new Map<string, typeof states>();
      for (const s of states) {
        const arr = byMonitor.get(s.monitorId) ?? [];
        arr.push(s);
        byMonitor.set(s.monitorId, arr);
      }
      const totals: Record<MonitorState, number> = { ok: 0, warn: 0, crit: 0, unknown: 0 };
      const rows = monitors.map((m) => {
        const targets = byMonitor.get(m.id) ?? [];
        const counts: Record<MonitorState, number> = { ok: 0, warn: 0, crit: 0, unknown: 0 };
        for (const t of targets) {
          counts[t.status] += 1;
          totals[t.status] += 1;
        }
        return {
          id: m.id,
          name: m.name,
          checkType: m.checkType,
          target: m.target,
          enabled: m.enabled,
          intervalSec: m.intervalSec,
          notify: m.notify,
          lastRunAt: m.lastRunAt,
          nextRunAt: m.nextRunAt,
          counts,
          targets: targets.map((t) => ({
            targetId: t.targetId,
            label: t.targetLabel,
            status: t.status,
            softCount: t.softCount,
            since: t.since,
            lastCheckedAt: t.lastCheckedAt,
            lastOutput: t.lastOutput,
          })),
        };
      });
      return ok({ totals, monitors: rows });
    });
  });
}
