import { withOperator, ok, bad, safeRead } from "@/lib/api";
import {
  queueHealthSnapshot,
  listDeadJobs,
  requeueDeadJob,
  getFeatureFlags,
  DEFAULT_FEATURES,
  recordAudit,
} from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /api/queue — the operator-gated worker/queue health surface (round-3 P0
// observability). GET returns one aggregate snapshot the /app/queue panel renders;
// POST { action:"requeue", id } revives a dead-lettered job. Reads straight from
// the jobs collection — no external SaaS. Degrades cleanly if Mongo is unreachable.
//
// NEVER emits secrets: a snapshot is job ids/types/statuses/timings + the DLQ
// list; no tokens, no env values.

const EMPTY = {
  depth: {},
  oldestUnstartedAgeMs: null,
  oldestUnstarted: null,
  stalledCount: 0,
  dlqCount: 0,
  types: [],
  dlq: [],
  recent: [],
  lockTimeoutMs: 0,
  maxAttempts: 0,
  queuePanelEnabled: DEFAULT_FEATURES.queuePanel,
  deadLetterEnabled: DEFAULT_FEATURES.deadLetterQueue,
  stalledReclaimEnabled: DEFAULT_FEATURES.stalledReclaim,
};

// GET /api/queue — queue depth, oldest-un-started age, per-type RED metrics,
// stalled count, the DLQ list, recent outcomes, and the relevant feature flags.
export async function GET() {
  return withOperator(() =>
    safeRead("queue unavailable", EMPTY, async () => {
      const [snap, flags, dlq] = await Promise.all([queueHealthSnapshot(), safeFlags(), listDeadJobs(100)]);
      return ok({
        ...snap,
        dlq: dlq.map((d) => ({
          id: d.id,
          type: d.type,
          instanceId: d.instanceId,
          deadReason: d.deadReason,
          deadAt: d.deadAt,
          attempts: d.attempts,
          error: d.error,
          idempotencyKey: d.idempotencyKey,
        })),
        queuePanelEnabled: flags.queuePanel,
        deadLetterEnabled: flags.deadLetterQueue,
        stalledReclaimEnabled: flags.stalledReclaim,
      });
    }),
  );
}

// POST /api/queue — { action:"requeue", id } revives a dead-lettered job back to
// the live queue. Mutating → audited.
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    const body = (await req.json().catch(() => ({}))) as { action?: string; id?: string };
    if (body.action !== "requeue" || !body.id) return bad("expected { action:'requeue', id }");
    const res = await requeueDeadJob(body.id);
    if ("error" in res) return bad(res.error, 404);
    await recordAudit(principal.id, "queue.requeue", res.job.id, `type=${res.job.type}`).catch(() => {});
    return ok({ ok: true, job: res.job });
  }, "write");
}

// Feature flags are resilient (getFeatureFlags never throws), but keep an extra
// guard so a flag read never turns a healthy snapshot into a degrade.
async function safeFlags() {
  try {
    return await getFeatureFlags();
  } catch {
    return DEFAULT_FEATURES;
  }
}
