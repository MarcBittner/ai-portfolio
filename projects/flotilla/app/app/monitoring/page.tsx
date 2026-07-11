import { getPrincipal } from "../../../lib/auth";
import { getFeatureFlags } from "../../../lib/models";
import { GET as overviewGET } from "../../api/monitoring/overview/route";
import { GET as monitorsGET } from "../../api/monitoring/monitors/route";
import { MonitoringClient } from "./MonitoringClient";
import type { OverviewResp, MonitorsResp } from "./_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server component (RSC) shell for the Monitoring tab (perf-plan §Area 3 / P1).
// The tab is one of the two heaviest dashboard pages (its sub-tab views are
// code-split via next/dynamic in MonitoringClient). This shell seeds the FIRST
// paint — the overview rollup + the monitors list — server-side, then hands them
// to the client as SWR fallbackData so first paint is content, not a blank flash.
//
// FLAG GATE (monitoring, default OFF) — flag-off behaviour is byte-identical:
//   • OFF → we do NOT touch the monitor store. We seed BOTH fallbacks with the
//     SAME 403 "monitoring feature is disabled" body the /api/monitoring/overview
//     + /monitors routes return when off. isFlagOff() matches that string, so the
//     client renders the "enable the flag" empty state on the server with no fetch
//     and no hydration mismatch (server branch === client branch).
//   • ON → we invoke the SAME route GET handlers the client would fetch (like the
//     Config page). Reusing the handlers — rather than re-deriving the join here —
//     guarantees ZERO drift: whatever the API returns is exactly what we seed
//     (same auth gate via withOperator, same rollup, same wire shape), so there is
//     no hydration mismatch.
//
// AUTH GATE PRESERVED: we prefetch ONLY when getPrincipal() resolves (the read
// floor withOperator enforces). For an unauthenticated request we pass no fallback;
// the client's own GETs (401) + middleware redirect handle it exactly as before —
// no monitor data is ever server-rendered for a caller who couldn't read it. The
// route GETs also self-gate (withOperator), so a 401/403/degraded body is discarded.
const FLAG_OFF: { error: string } = { error: "monitoring feature is disabled" };

export default async function MonitoringPage() {
  let overviewFallback: OverviewResp | undefined;
  let monitorsFallback: MonitorsResp | undefined;
  try {
    const principal = await getPrincipal();
    if (principal) {
      // Read the flag once, server-side. Only fetch the gated data when ON.
      const flags = await getFeatureFlags();
      if (!flags.monitoring) {
        // Mirror the routes' flag-off 403 body so the client renders the disabled
        // state identically, without ever touching the monitor store.
        overviewFallback = FLAG_OFF;
        monitorsFallback = FLAG_OFF;
      } else {
        const [ovRes, monRes] = await Promise.all([overviewGET(), monitorsGET()]);
        if (ovRes.ok && ovRes.status === 200) {
          const json = (await ovRes.json()) as OverviewResp;
          if (!json.degraded) overviewFallback = json;
        }
        if (monRes.ok && monRes.status === 200) {
          const json = (await monRes.json()) as MonitorsResp;
          if (!json.degraded) monitorsFallback = json;
        }
      }
    }
  } catch {
    // Store/auth unreachable in this worktree — fall through to the client, which
    // fetches and degrades gracefully (trueline "connecting…" posture).
  }
  return (
    <MonitoringClient overviewFallback={overviewFallback} monitorsFallback={monitorsFallback} />
  );
}
