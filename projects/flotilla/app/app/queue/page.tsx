import { getPrincipal } from "../../../lib/auth";
import {
  queueHealthSnapshot,
  listDeadJobs,
  getFeatureFlags,
  DEFAULT_FEATURES,
} from "../../../lib/models";
import { QueueClient, type Resp } from "./QueueClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server component (RSC) for the worker/queue health panel (perf-plan §Area 3 / P1).
// It resolves the operator and computes the SAME aggregate snapshot GET /api/queue
// returns — straight from the jobs store — then hands it to the client as SWR
// fallbackData, so first paint is the panel instead of a blank-then-fetch flash.
// SWR keeps polling (5s) for live refresh + the Requeue interaction.
//
// AUTH GATE PRESERVED: we prefetch ONLY when getPrincipal() resolves (the same
// read floor as the API's withOperator default). For an unauthenticated request we
// pass no fallback; the client's own /api/queue GET (401) + middleware redirect
// handle it exactly as before — no queue data is ever server-rendered for a caller
// who couldn't read it via the API. Only job ids/types/statuses/timings + the DLQ
// list are rendered — never any secret (mirrors the route's contract).
export default async function QueuePage() {
  let fallback: Resp | undefined;
  try {
    const principal = await getPrincipal();
    if (principal) {
      const [snap, flags, dlq] = await Promise.all([
        queueHealthSnapshot(),
        safeFlags(),
        listDeadJobs(100),
      ]);
      // Same wire shape the /api/queue GET emits (route.ts): the snapshot spread,
      // the projected DLQ rows, and the three relevant feature flags.
      fallback = {
        ...snap,
        dlq: dlq.map((d) => ({
          id: d.id,
          type: d.type,
          instanceId: d.instanceId,
          deadReason: d.deadReason,
          deadAt: d.deadAt,
          attempts: d.attempts,
          error: d.error,
        })),
        queuePanelEnabled: flags.queuePanel,
        deadLetterEnabled: flags.deadLetterQueue,
        stalledReclaimEnabled: flags.stalledReclaim,
      };
    }
  } catch {
    // Store/auth unreachable in this worktree — fall through to the client, which
    // fetches and degrades gracefully (trueline "connecting…" posture).
  }
  return <QueueClient fallback={fallback} />;
}

// Feature flags are resilient (getFeatureFlags never throws), but keep an extra
// guard so a flag read never turns a healthy snapshot into a degrade — mirrors the
// route's safeFlags().
async function safeFlags() {
  try {
    return await getFeatureFlags();
  } catch {
    return DEFAULT_FEATURES;
  }
}
