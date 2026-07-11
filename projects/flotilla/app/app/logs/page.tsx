import { getPrincipal } from "../../../lib/auth";
import { queryLogs, listAudit, type LogQuery } from "../../../lib/models";
import {
  fromSystemLog,
  fromAudit,
  mergeEntries,
} from "../../../lib/logSources";
import { LogsClient, type Entry, DEFAULT_LOGS_LIMIT } from "./LogsClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server component (RSC) for the consolidated Logs stream (perf-plan §Area 3 / P1).
// Resolves the operator and fetches the FIRST (default, unfiltered) log window
// server-side — the SAME direct model reads GET /api/logs does for the no-instance
// case — then hands it to the client as SWR fallbackData so first paint is content
// instead of the blank-then-fetch waterfall. SWR keeps polling for live refresh and
// takes over the moment the operator changes a filter (that mints a new SWR key,
// which fallbackData does NOT seed — only the default key is server-seeded).
//
// SCOPE OF THE SERVER SEED: only system (`flotilla_logs`) + audit (`flotilla_audit`), the
// two feeds the route pulls when no instance is selected. Vercel logs + Convex/Clerk
// deep-links only exist scoped to ONE instance, and the default first window has no
// instance selected, so `links` is empty here — identical to what /api/logs?limit=200
// returns. Selecting an instance is a filter change → SWR fetches it live.
//
// AUTH GATE PRESERVED: we prefetch ONLY when getPrincipal() resolves (the same read
// floor withOperator enforces on /api/logs). For an unauthenticated request we pass
// no fallback; the client's own /api/logs GET (401) + middleware redirect handle it
// exactly as before — no log data is ever server-rendered for a caller who couldn't
// read it via the API.
export default async function LogsPage() {
  let fallbackEntries: Entry[] | undefined;
  try {
    const principal = await getPrincipal();
    if (principal) {
      // Mirror GET /api/logs for the default (no source, no instanceId) key: system
      // logs + operator audit, merged newest-first, sliced to the default limit.
      const sysQuery: LogQuery = { instanceId: undefined, limit: DEFAULT_LOGS_LIMIT };
      const [sysDocs, auditDocs] = await Promise.all([
        queryLogs(sysQuery),
        listAudit(DEFAULT_LOGS_LIMIT),
      ]);
      const merged = mergeEntries(sysDocs.map(fromSystemLog), auditDocs.map(fromAudit)).slice(
        0,
        DEFAULT_LOGS_LIMIT,
      );
      // Cast across the RSC→client JSON boundary — same bytes SWR would receive from
      // GET /api/logs (the client Entry view type is structurally the UnifiedEntry).
      fallbackEntries = merged as unknown as Entry[];
    }
  } catch {
    // Store/auth unreachable in this worktree — fall through to the client, which
    // fetches and degrades gracefully (trueline "connecting…" posture).
  }
  return <LogsClient fallbackEntries={fallbackEntries} />;
}
