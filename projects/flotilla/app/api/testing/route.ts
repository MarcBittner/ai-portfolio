import { z } from "zod";
import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { listTestRuns, toRunView, appendLog, recordAudit } from "@/lib/models";
import { enqueueTest } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /api/testing (B-9) — the TEST RUNNER surface the testing page codes against.
//
//   POST { instanceId?, kind }  → { runId }   (enqueues an async run; self needs no instanceId)
//   GET  ?instanceId=…          → { runs: [{ runId, instanceId, kind, status, checks, startedAt, finishedAt }], wired: true }
//
// Runs are READ-ONLY against instances (goto/fetch only) and execute in the
// worker; this route only enqueues + reads back, and audits each run start.

const RunBody = z.object({
  kind: z.enum(["smoke", "regression", "security", "self"]),
  // Required for every kind except "self" (validated in enqueueTest).
  instanceId: z.string().min(1).optional(),
});

// GET — recent runs for the given instance (or the recent set for self, which the
// UI filters client-side). `wired: true` tells the page the runner is live.
export async function GET(req: Request) {
  return withOperator(() => {
    const instanceId = new URL(req.url).searchParams.get("instanceId") ?? undefined;
    return safeRead("test runs unavailable", { runs: [], wired: true }, async () => {
      const runs = await listTestRuns(instanceId);
      return ok({ runs: runs.map(toRunView), wired: true });
    });
  });
}

// POST — create a queued run + enqueue the worker job; return { runId }.
export async function POST(req: Request) {
  return withOperator(async (principal) => {
    const { kind, instanceId } = RunBody.parse(await req.json().catch(() => ({})));
    const res = await enqueueTest(instanceId, kind);
    if ("error" in res) return bad(res.error);

    const target = kind === "self" ? "dashboard (self)" : instanceId!;
    await recordAudit(principal.id, "testing.run", target, `kind=${kind}, runId=${res.runId}`).catch(() => {});
    await appendLog({
      source: "orchestrator",
      level: "info",
      ts: Date.now(),
      msg: `AUDIT: operator ${principal.id} started ${kind} test run ${res.runId} against ${target}`,
      jobId: res.jobId,
      instanceId: kind === "self" ? undefined : instanceId,
    }).catch(() => {});
    return ok({ runId: res.runId });
  }, "write");
}
