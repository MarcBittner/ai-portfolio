import { col, now, NO_ID } from "./base.ts";
import type { GateOutcome } from "../aiSmokeGate.ts";

// Cache of computed AI smoke-gate verdicts. A terminal test run is immutable, so
// its advisory verdict is memoized here keyed by (runId, version) — the billable
// Anthropic call runs at most once per run version, and GET /api/testing/gate is
// always free (it reads the cache, never computes). See app/api/testing/gate.
export type GateVerdictCacheDoc = {
  runId: string;
  version: number; // the run's `updatedAt` at compute time — invalidates if the run changes
  outcome: GateOutcome;
  at: number;
};

export async function getCachedGateVerdict(runId: string, version: number): Promise<GateOutcome | null> {
  const c = await col<GateVerdictCacheDoc>("gateVerdicts");
  const doc = await c.findOne({ runId, version }, NO_ID);
  return doc?.outcome ?? null;
}

export async function putCachedGateVerdict(runId: string, version: number, outcome: GateOutcome): Promise<void> {
  const c = await col<GateVerdictCacheDoc>("gateVerdicts");
  // One cache doc per run; a newer version overwrites the prior verdict.
  await c.updateOne(
    { runId },
    { $set: { runId, version, outcome, at: now() } },
    { upsert: true },
  );
}
