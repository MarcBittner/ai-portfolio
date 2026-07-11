import { col, newId, now, NO_ID } from "./base.ts";
import type { FixLoopAttempt, FixPlan } from "../fixPlan.ts";

// flotilla_fixloops — the audited record of an AI validated-fix loop run against ONE
// tool-created preview instance. A worker `fix-loop` job creates one (running),
// streams progress to flotilla_logs, and converges it to succeeded/failed with the
// attempts + winning plan. The instance-detail page reads the LATEST loop for an
// instance to show the attempts and offer "Adopt this fix". Append-only history;
// we never mutate a prior loop, only add new ones.
//
// This is a RESULT/AUDIT record, not an executor — nothing here provisions or
// mutates an instance. The only executor is applyFixPlan (lib/aiFixLoop.ts).
export type FixLoopStatus = "running" | "succeeded" | "failed";

export type FixLoopDoc = {
  id: string;
  instanceId: string;
  jobId: string;
  status: FixLoopStatus;
  // The propose→apply→verify attempts, each carrying the plan + its DETERMINISTIC
  // verdict (from the real re-provision, never the model's narrative).
  attempts: FixLoopAttempt[];
  // The first plan whose real re-provision passed, or null if none did.
  winningPlan: FixPlan | null;
  // When the loop finished (mirrors FixLoopResult.checkedAt).
  checkedAt?: number;
  // Populated when the loop job itself threw (guard refusal, provider error).
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export async function createFixLoop(input: { instanceId: string; jobId: string }): Promise<FixLoopDoc> {
  const ts = now();
  const doc: FixLoopDoc = {
    id: newId("fixloop"),
    instanceId: input.instanceId,
    jobId: input.jobId,
    status: "running",
    attempts: [],
    winningPlan: null,
    createdAt: ts,
    updatedAt: ts,
  };
  const c = await col<FixLoopDoc>("fixloops");
  await c.insertOne(doc);
  return doc;
}

export async function updateFixLoop(
  id: string,
  patch: Partial<Omit<FixLoopDoc, "id" | "instanceId" | "jobId" | "createdAt">>,
): Promise<void> {
  const c = await col<FixLoopDoc>("fixloops");
  await c.updateOne({ id }, { $set: { ...patch, updatedAt: now() } });
}

export async function getFixLoop(id: string): Promise<FixLoopDoc | null> {
  const c = await col<FixLoopDoc>("fixloops");
  return c.findOne({ id }, NO_ID);
}

// The instance-detail read: the most recent loop for an instance (or null).
export async function getLatestFixLoopForInstance(instanceId: string): Promise<FixLoopDoc | null> {
  const c = await col<FixLoopDoc>("fixloops");
  const [doc] = await c.find({ instanceId }, NO_ID).sort({ createdAt: -1 }).limit(1).toArray();
  return doc ?? null;
}

// The loop that a given job produced (used when the worker persists results).
export async function getFixLoopByJob(jobId: string): Promise<FixLoopDoc | null> {
  const c = await col<FixLoopDoc>("fixloops");
  return c.findOne({ jobId }, NO_ID);
}
