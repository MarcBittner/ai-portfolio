import { getPrincipal } from "../../../lib/auth";
import { listAudit } from "../../../lib/models";
import { ActivityClient, type Entry } from "./ActivityClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server component (RSC) for the read-only Activity/audit feed (perf-plan §Area 3 /
// P1). Resolves the operator and fetches the first page of audit entries server-
// side, handing them to the client as SWR fallbackData so first paint is content.
//
// AUTH GATE PRESERVED: prefetch only when getPrincipal() resolves (withOperator's
// default read floor). Unauthenticated → no fallback; the client's /api/audit GET
// (401) + middleware redirect handle it exactly as before.
export default async function ActivityPage() {
  let fallbackEntries: Entry[] | undefined;
  try {
    const principal = await getPrincipal();
    if (principal) {
      const rows = await listAudit(200);
      fallbackEntries = rows.map((r) => ({
        ts: r.ts,
        actor: r.actor,
        action: r.action,
        target: r.target,
        detail: r.detail,
      }));
    }
  } catch {
    // Store/auth unreachable — fall through to the client, which fetches + degrades.
  }
  return <ActivityClient fallbackEntries={fallbackEntries} />;
}
