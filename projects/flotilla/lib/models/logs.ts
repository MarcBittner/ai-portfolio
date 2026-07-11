import { z } from "zod";
import type { LogEvent } from "../_contract.ts";
import { col, ensureIndexesFor, now, NO_ID } from "./base.ts";

// The consolidated event log (plan §5 / SP-1): every LogEvent from Vercel,
// Convex, Clerk, and the orchestrator lands here, keyed by job/instance, ordered
// by (ts, seq) so a burst within the same millisecond still renders in order.
export const LogQuery = z.object({
  jobId: z.string().optional(),
  instanceId: z.string().optional(),
  source: z.enum(["vercel", "convex", "clerk", "orchestrator"]).optional(),
  level: z.enum(["info", "warn", "error"]).optional(),
  since: z.number().optional(),
  limit: z.number().min(1).max(2000).optional(),
});
export type LogQuery = z.infer<typeof LogQuery>;

export type LogDoc = {
  seq: number;
  ts: number;
  source: LogEvent["source"];
  level: LogEvent["level"];
  msg: string;
  jobId?: string;
  instanceId?: string;
  createdAt: number;
};

// Monotonic per-process sequence so events sharing a ts stay ordered.
let seqCounter = 0;

export async function appendLog(
  event: LogEvent & { instanceId?: string },
): Promise<void> {
  const c = await col<LogDoc>("logs");
  const doc: LogDoc = {
    seq: ++seqCounter,
    ts: event.ts ?? now(),
    source: event.source,
    level: event.level,
    msg: event.msg,
    jobId: event.jobId,
    instanceId: event.instanceId,
    createdAt: now(),
  };
  await c.insertOne(doc);
}

export async function queryLogs(q: LogQuery): Promise<LogDoc[]> {
  const parsed = LogQuery.parse(q);
  const filter: Record<string, unknown> = {};
  if (parsed.jobId) filter.jobId = parsed.jobId;
  if (parsed.instanceId) filter.instanceId = parsed.instanceId;
  if (parsed.source) filter.source = parsed.source;
  if (parsed.level) filter.level = parsed.level;
  if (parsed.since) filter.ts = { $gt: parsed.since };
  await ensureIndexesFor("logs");
  const c = await col<LogDoc>("logs");
  // Sort DESCENDING under the limit so we return the FRESHEST window (was ascending,
  // which returned the OLDEST rows ever + then truncated — a stale window, and a
  // full scan). Backed by the {jobId,ts}/{instanceId,ts} indexes. We reverse the
  // capped window back to ascending (ts,seq) so callers keep the same chronological
  // display order they had before. See performance-plan §Area 2.
  const rows = await c
    .find(filter, NO_ID)
    .sort({ ts: -1, seq: -1 })
    .limit(parsed.limit ?? 500)
    .toArray();
  return rows.reverse();
}
