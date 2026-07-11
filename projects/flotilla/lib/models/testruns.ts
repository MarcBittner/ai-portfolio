import { z } from "zod";
import { col, newId, now, NO_ID } from "./base.ts";

// flotilla_testruns — one persisted TEST RUN against a single tracked instance (or
// the dashboard itself for kind:"self"). The runner (lib/testRunner.ts) executes
// asynchronously in the worker; each run holds the per-check results + status +
// timestamps so the testing page can poll GET /api/testing and stream progress.
//
// Contract the UI codes against (must match exactly):
//   { runId, instanceId?, kind, status, checks:[{name,pass,detail}], startedAt?, finishedAt? }
export const TestKind = z.enum(["smoke", "regression", "security", "self", "all"]);
export type TestKind = z.infer<typeof TestKind>;

// Lifecycle: queued (enqueued) → running (worker claimed) → passed | failed.
export const TestStatus = z.enum(["queued", "running", "passed", "failed"]);
export type TestStatus = z.infer<typeof TestStatus>;

// One assertion result. `pass=false` with the error/context in `detail` is how a
// thrown check surfaces — a check never crashes the run (see lib/testRunner.ts).
export type TestCheck = { name: string; pass: boolean; detail?: string };

export const NewTestRun = z.object({
  // Absent for kind:"self" (the dashboard tests itself — no target instance).
  instanceId: z.string().min(1).optional(),
  kind: TestKind,
});
export type NewTestRun = z.infer<typeof NewTestRun>;

export type TestRunDoc = {
  // `id` is the runId the API returns and the UI keys rows on.
  id: string;
  instanceId?: string;
  kind: TestKind;
  status: TestStatus;
  checks: TestCheck[];
  // The worker job that executes this run (async plumbing; not in the UI shape).
  jobId?: string;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export async function createTestRun(input: NewTestRun): Promise<TestRunDoc> {
  const parsed = NewTestRun.parse(input);
  const ts = now();
  const doc: TestRunDoc = {
    id: newId("run"),
    instanceId: parsed.instanceId,
    kind: parsed.kind,
    status: "queued",
    checks: [],
    createdAt: ts,
    updatedAt: ts,
  };
  const c = await col<TestRunDoc>("testruns");
  await c.insertOne(doc);
  return doc;
}

export async function getTestRun(id: string): Promise<TestRunDoc | null> {
  const c = await col<TestRunDoc>("testruns");
  return c.findOne({ id }, NO_ID);
}

// Most-recent-first runs. Filtered to one instance when `instanceId` is given;
// otherwise the recent set across every target (the UI filters self runs client-side).
export async function listTestRuns(instanceId?: string, limit = 50): Promise<TestRunDoc[]> {
  const c = await col<TestRunDoc>("testruns");
  const filter = instanceId ? { instanceId } : {};
  return c.find(filter, NO_ID).sort({ createdAt: -1 }).limit(limit).toArray();
}

export async function updateTestRun(
  id: string,
  patch: Partial<Omit<TestRunDoc, "id" | "createdAt">>,
): Promise<void> {
  const c = await col<TestRunDoc>("testruns");
  await c.updateOne({ id }, { $set: { ...patch, updatedAt: now() } });
}

// Project a stored run into the exact shape the testing page consumes.
export function toRunView(doc: TestRunDoc): {
  runId: string;
  instanceId?: string;
  kind: TestKind;
  status: TestStatus;
  checks: TestCheck[];
  startedAt?: number;
  finishedAt?: number;
} {
  return {
    runId: doc.id,
    instanceId: doc.instanceId,
    kind: doc.kind,
    status: doc.status,
    checks: doc.checks ?? [],
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
  };
}
