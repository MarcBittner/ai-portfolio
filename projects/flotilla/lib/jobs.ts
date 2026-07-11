import type { LogEvent } from "./_contract.ts";
import { executeProvision, executeTeardown, type ExecOpts, type ExecTeardownOpts } from "./executor.ts";
import { notify } from "./notify.ts";
import { syncPrComment } from "./prComment.ts";
import { onInstanceReady, onInstanceTeardown } from "./monitoring/materialize.ts";
import {
  enqueueJob,
  claimJob,
  updateJob,
  getJob,
  createInstance,
  updateInstance,
  getInstance,
  appendLog,
  createTestRun,
  getTestRun,
  updateTestRun,
  createFixLoop,
  updateFixLoop,
  getFixLoopByJob,
  type JobOpts,
  type JobDoc,
  type JobDimension,
  type InstanceDoc,
  type TestKind,
  type TestCheck,
} from "./models/index.ts";
import { runFixLoop, fixLoopGuard, type Stream } from "./aiFixLoop.ts";
import { runPatchPush, patchPushGuard, validatePatch } from "./patchPush.ts";

// The job layer (plan B-4), re-shaped for the ASYNC worker architecture:
//
//   API route  → enqueue*() → writes a `queued` job to flotilla_jobs → returns {jobId}
//   worker     → nextQueuedJob() → runJob() → executeProvision() (all-HTTP engine)
//              → streams every LogEvent to flotilla_logs → converges instance/job status
//
// The serverless API never runs a provision inline (it can't: the engine streams
// tens of MB and, for PII scrub / Playwright, needs a filesystem + browser). It
// only enqueues. `FLOTILLA_INLINE_WORKER=1` opts into in-process execution for local
// dev / a single-process deploy. Idempotent throughout: enqueue converges on
// idempotencyKey; claimJob ensures a single runner; a finished job re-run no-ops.

export type EnqueueProvisionInput = {
  name?: string;
  branch: string;
  kind?: "preview" | "staging";
  // WRITE target: omit / "fresh" => provision a NEW isolated Convex deployment.
  convexDeployment?: string;
  // Read-only DATA SOURCE (a Convex cloud backup snapshot).
  backupSnapshotId?: string;
  backupDeployment?: string;
  // Legacy local-file backup path (CLI engine) — still accepted.
  backupRef?: string;
  clerkInstance?: string;
  vercelProject?: string;
  migrations: boolean;
  scrubPII: boolean;
  dryRun?: boolean;
  // Explicit acknowledgement to overwrite a pre-existing (non-fresh) deployment.
  dangerAck?: boolean;
  // Optional lifecycle + attribution (no default expiry).
  ttlHours?: number;
  owner?: string;
  // Ownership registry (Track D) — structured owner/team stamped onto the instance
  // on create. All optional; the route resolves these from the acting principal
  // unless an explicit owner was supplied (provision-on-behalf-of).
  ownerUserId?: string;
  ownerEmail?: string;
  ownerName?: string;
  team?: string;
  // PR-native provenance (lib/prLifecycle.ts) — stamped onto the instance so the
  // canonical PR comment + the PR→instance lookup can find it.
  prRepo?: string;
  prNumber?: number;
  idempotencyKey?: string;
};

// On a successful claim, record the attempt bookkeeping the reliability layer
// needs: bump `attempts`, stamp `firstAttemptAt` once (never overwritten across
// reclaims), and seed the lock heartbeat. Single-winner (claimJob is atomic) so
// this read-modify-write is race-free. Merged into the existing engine stamp so
// it's one write, not two.
function stampAttempt(job: JobDoc, extra: Partial<JobDoc>): Partial<JobDoc> {
  const ts = Date.now();
  return {
    ...extra,
    attempts: (job.attempts ?? 0) + 1,
    firstAttemptAt: job.firstAttemptAt ?? ts,
    lockRenewedAt: ts,
  };
}

// Which dimensions a CREATE should provision: code always (deploy the branch),
// data iff a snapshot was chosen, clerk iff a clerk instance was chosen.
function createDimensions(input: EnqueueProvisionInput): JobDimension[] {
  const dims: JobDimension[] = ["code"];
  if (input.backupSnapshotId) dims.push("data");
  if (input.clerkInstance) dims.push("clerk");
  return dims;
}

// Create-or-return the instance + a queued job. Returns immediately with the job
// id so the UI can tail the live log; the WORKER executes. Safe to call twice
// (double-submit) — converges to one instance + one job via idempotencyKey.
export async function enqueueProvision(
  input: EnqueueProvisionInput,
): Promise<{ jobId: string; instanceId: string }> {
  const kind = input.kind ?? "preview";
  const dataRef = input.backupSnapshotId ?? input.backupRef ?? "no-data";
  const idempotencyKey =
    input.idempotencyKey ??
    `provision:${kind}:${input.branch}:${dataRef}:${input.convexDeployment ?? "fresh"}`;

  const instance = await createInstance({
    name: input.name,
    kind,
    branch: input.branch,
    backupRef: input.backupRef,
    backupSnapshotId: input.backupSnapshotId,
    backupDeployment: input.backupDeployment,
    convexDeployment: input.convexDeployment,
    clerkInstance: input.clerkInstance,
    vercelProject: input.vercelProject,
    migrations: input.migrations,
    scrubPII: input.scrubPII,
    ttlHours: input.ttlHours,
    owner: input.owner,
    ownerUserId: input.ownerUserId,
    ownerEmail: input.ownerEmail,
    ownerName: input.ownerName,
    team: input.team,
    prRepo: input.prRepo,
    prNumber: input.prNumber,
    idempotencyKey,
  });

  const opts: JobOpts = {
    branch: input.branch,
    backupRef: input.backupRef,
    data:
      input.backupSnapshotId && input.backupDeployment
        ? { backupSnapshotId: input.backupSnapshotId, backupDeployment: input.backupDeployment }
        : undefined,
    clerkInstance: input.clerkInstance,
    migrations: input.migrations,
    scrubPII: input.scrubPII,
    dryRun: input.dryRun,
    dimensions: createDimensions(input),
    dangerAck: input.dangerAck,
    target: {
      kind,
      convexDeployment: input.convexDeployment,
      clerkInstance: input.clerkInstance,
      vercelProject: input.vercelProject,
      createdByTool: instance.createdByTool,
      lastImportedSnapshotId: instance.lastImportedSnapshotId,
    },
  };

  const job = await enqueueJob({ type: "provision", opts, instanceId: instance.id, idempotencyKey });
  await updateInstance(instance.id, { currentJobId: job.id, status: "provisioning", health: "provisioning" });
  maybeInlineRun(job.id, instance.id);
  return { jobId: job.id, instanceId: instance.id };
}

// PATCH: update any subset of {branch (code), backup (data), clerkInstance
// (clerk)} and re-provision ONLY the changed dimension(s). Returns {jobId}.
export type UpdateInstanceInput = {
  branch?: string;
  backupSnapshotId?: string;
  backupDeployment?: string;
  clerkInstance?: string;
  dangerAck?: boolean;
};

export async function enqueueUpdate(
  instanceId: string,
  patch: UpdateInstanceInput,
): Promise<{ jobId: string } | { error: string }> {
  const instance = await getInstance(instanceId);
  if (!instance) return { error: "instance not found" };

  const dims: JobDimension[] = [];
  const branch = patch.branch ?? instance.branch;
  if (patch.branch !== undefined && patch.branch !== instance.branch) dims.push("code");
  const backupSnapshotId = patch.backupSnapshotId ?? instance.backupSnapshotId;
  const backupDeployment = patch.backupDeployment ?? instance.backupDeployment;
  if (patch.backupSnapshotId !== undefined && patch.backupSnapshotId !== instance.backupSnapshotId) dims.push("data");
  const clerkInstance = patch.clerkInstance ?? instance.clerkInstance;
  if (patch.clerkInstance !== undefined && patch.clerkInstance !== instance.clerkInstance) dims.push("clerk");

  if (dims.length === 0) return { error: "no changes: nothing to re-provision" };

  // Persist the new DESIRED state so a re-read reflects the pending change.
  await updateInstance(instanceId, {
    branch,
    backupSnapshotId,
    backupDeployment,
    clerkInstance,
    status: "provisioning",
    health: "provisioning",
  });

  // Reuse the instance's OWN (tool-created or user-selected) deployment — never a
  // shared one — so an update converges on the same target.
  const target: JobOpts["target"] = {
    kind: instance.kind,
    convexDeployment: instance.createdConvexDeployment ?? instance.convexDeployment,
    clerkInstance,
    vercelProject: instance.vercelProject,
    createdByTool: instance.createdByTool,
    lastImportedSnapshotId: instance.lastImportedSnapshotId,
  };

  const opts: JobOpts = {
    branch,
    data: backupSnapshotId && backupDeployment ? { backupSnapshotId, backupDeployment } : undefined,
    clerkInstance,
    migrations: instance.migrations,
    scrubPII: instance.scrubPII,
    dimensions: dims,
    dangerAck: patch.dangerAck,
    target,
  };

  // A deterministic key so a double-submit of the SAME patch converges, but a
  // genuinely different patch enqueues a fresh job.
  const idempotencyKey = `update:${instanceId}:${dims.join(",")}:${branch}:${backupSnapshotId ?? ""}:${clerkInstance ?? ""}`;
  const job = await enqueueJob({ type: "update", opts, instanceId, idempotencyKey });
  await updateInstance(instanceId, { currentJobId: job.id });
  maybeInlineRun(job.id, instanceId);
  return { jobId: job.id };
}

// RE-PROVISION: re-run the instance's OWN tool-created deployment over all
// applicable dimensions using its CURRENT persisted opts. This is the async
// "apply for real" path the AI fix-loop's "Adopt this fix" uses AFTER the operator
// has persisted the winning plan's opts onto the instance — it goes through the
// SAME executor (runJob → executeProvision) and therefore the SAME prod/shared/
// preflight guards. Never targets a non-tool-created / prod / shared deployment
// (the executor preflight enforces that regardless). Returns {jobId} or an error.
export async function enqueueReprovision(
  instanceId: string,
): Promise<{ jobId: string } | { error: string }> {
  const instance = await getInstance(instanceId);
  if (!instance) return { error: "instance not found" };
  if (!instance.createdByTool) {
    return { error: "refusing to re-provision an instance the tool did not create" };
  }
  const target = instance.createdConvexDeployment ?? instance.convexDeployment;
  if (!target) return { error: "instance has no resolved deployment to re-provision" };

  const dims: JobDimension[] = ["code"];
  if (instance.backupSnapshotId) dims.push("data");
  if (instance.clerkInstance) dims.push("clerk");

  await updateInstance(instanceId, { status: "provisioning", health: "provisioning" });

  const opts: JobOpts = {
    branch: instance.branch,
    data:
      instance.backupSnapshotId && instance.backupDeployment
        ? { backupSnapshotId: instance.backupSnapshotId, backupDeployment: instance.backupDeployment }
        : undefined,
    clerkInstance: instance.clerkInstance,
    migrations: instance.migrations,
    scrubPII: instance.scrubPII,
    dimensions: dims,
    // Its own tool-created preview: overwrite is expected (the prod/shared HARD
    // blocks in the engine preflight still apply regardless).
    dangerAck: true,
    target: {
      kind: instance.kind,
      convexDeployment: target,
      clerkInstance: instance.clerkInstance,
      vercelProject: instance.vercelProject,
      createdByTool: instance.createdByTool,
      // Force a re-import so a data/snapshot fix actually re-runs.
      lastImportedSnapshotId: undefined,
    },
  };
  const idempotencyKey = `reprovision:${instanceId}:${Date.now()}`;
  const job = await enqueueJob({ type: "update", opts, instanceId, idempotencyKey });
  await updateInstance(instanceId, { currentJobId: job.id });
  maybeInlineRun(job.id, instanceId);
  return { jobId: job.id };
}

// TEARDOWN: reclaim the tool-created resources for an instance (Convex preview,
// Vercel deployment/project, per-instance Clerk records). Enqueues a teardown
// job; the worker's executeTeardown does the work behind the prod/shared guards.
// Idempotent on (instanceId, teardown) so a double-click converges to one job.
export async function enqueueTeardown(
  instanceId: string,
  opts: { dryRun?: boolean; reason?: string } = {},
): Promise<{ jobId: string } | { error: string }> {
  const instance = await getInstance(instanceId);
  if (!instance) return { error: "instance not found" };
  if (!instance.createdByTool) {
    return { error: "refusing to tear down an instance the tool did not create" };
  }

  // Teardown carries the instance's own deployment as the target; branch/flags
  // are unused by the teardown path but satisfy the shared JobOpts schema.
  const jobOpts: JobOpts = {
    branch: instance.branch,
    migrations: false,
    scrubPII: instance.scrubPII,
    dryRun: opts.dryRun,
    dimensions: [],
    target: {
      kind: instance.kind,
      convexDeployment: instance.createdConvexDeployment ?? instance.convexDeployment,
      vercelProject: instance.vercelProject,
      createdByTool: instance.createdByTool,
    },
  };
  // A stable key so repeated teardown requests converge to one job while it runs.
  const idempotencyKey = `teardown:${instanceId}`;
  const job = await enqueueJob({ type: "teardown", opts: jobOpts, instanceId, idempotencyKey });
  await updateInstance(instanceId, { currentJobId: job.id, status: "provisioning", health: "provisioning" });
  await appendLog({
    source: "orchestrator",
    level: "warn",
    ts: Date.now(),
    msg: `teardown enqueued for ${instance.name}${opts.reason ? ` (${opts.reason})` : ""}`,
    jobId: job.id,
    instanceId,
  }).catch(() => {});
  maybeInlineRun(job.id, instanceId);
  return { jobId: job.id };
}

// SCHEDULED AUTO-REFRESH: re-import a (usually newer) snapshot into a STABLE
// existing instance's OWN deployment — the tool's original "refresh staging from
// prod" purpose, masked by default. Reuses the export→import primitive.
export async function enqueueRefresh(
  instanceId: string,
  input: { backupSnapshotId: string; backupDeployment?: string; dryRun?: boolean } = { backupSnapshotId: "" },
): Promise<{ jobId: string } | { error: string }> {
  const instance = await getInstance(instanceId);
  if (!instance) return { error: "instance not found" };
  const backupDeployment = input.backupDeployment ?? instance.backupDeployment;
  if (!input.backupSnapshotId || !backupDeployment) {
    return { error: "backupSnapshotId + backupDeployment required to refresh" };
  }
  const target = instance.createdConvexDeployment ?? instance.convexDeployment;
  if (!target) return { error: "instance has no resolved deployment to refresh" };

  await updateInstance(instanceId, {
    backupSnapshotId: input.backupSnapshotId,
    backupDeployment,
    status: "provisioning",
    health: "provisioning",
  });

  const opts: JobOpts = {
    branch: instance.branch,
    data: { backupSnapshotId: input.backupSnapshotId, backupDeployment },
    migrations: instance.migrations,
    scrubPII: instance.scrubPII,
    dryRun: input.dryRun,
    dimensions: ["data"],
    // The instance's own tool-created deployment: overwriting it is expected, so
    // dangerAck is implied for a createdByTool target (preflight allows it).
    dangerAck: instance.createdByTool ? true : undefined,
    target: {
      kind: instance.kind,
      convexDeployment: target,
      vercelProject: instance.vercelProject,
      createdByTool: instance.createdByTool,
      // Force a re-import: distinct key from the last import marker.
      lastImportedSnapshotId: undefined,
    },
  };
  // Distinct per (instance, snapshot) so re-refreshing the same snapshot converges
  // but a newer snapshot enqueues a fresh run.
  const idempotencyKey = `refresh:${instanceId}:${input.backupSnapshotId}`;
  const job = await enqueueJob({ type: "refresh", opts, instanceId, idempotencyKey });
  await updateInstance(instanceId, { currentJobId: job.id });
  maybeInlineRun(job.id, instanceId);
  return { jobId: job.id };
}

// TEST RUN (B-9): enqueue a READ-ONLY test suite against ONE tracked instance
// (or the dashboard itself for kind:"self"). Creates a queued `flotilla_testruns`
// record + a queued `test` job and returns the runId immediately; the worker
// claims the job and runs the suite (lib/testRunner.ts), streaming to flotilla_logs
// and converging the run record running→passed/failed. Tests never mutate the
// instance — only goto/fetch.
export async function enqueueTest(
  instanceId: string | undefined,
  kind: TestKind,
): Promise<{ runId: string; jobId: string } | { error: string }> {
  // Every kind except "self" targets a specific instance.
  if (kind !== "self") {
    if (!instanceId) return { error: "instanceId is required for this test kind" };
    const instance = await getInstance(instanceId);
    if (!instance) return { error: "instance not found" };
  }
  const targetInstanceId = kind === "self" ? undefined : instanceId;

  const run = await createTestRun({ instanceId: targetInstanceId, kind });

  // Test jobs reuse the JobOpts schema; the provisioning fields are inert here
  // (dimensions:[] so nothing is (re)provisioned). `test` carries the real payload.
  const opts: JobOpts = {
    branch: "n/a",
    migrations: false,
    scrubPII: false,
    dimensions: [],
    test: { runId: run.id, kind },
    target: { kind: "preview" },
  };
  // Keyed on the runId so a double-submit converges to one job per run.
  const idempotencyKey = `test:${run.id}`;
  const job = await enqueueJob({ type: "test", opts, instanceId: targetInstanceId, idempotencyKey });
  await updateTestRun(run.id, { jobId: job.id });
  maybeInlineTest(job.id);
  return { runId: run.id, jobId: job.id };
}

// Execute a queued TEST job: claim it, run the suite, converge the run record and
// the job. Idempotent via claimJob (queued→running exactly once). A suite that
// throws whole is caught and recorded as a failed run — the worker never crashes.
export async function runTestJob(jobId: string): Promise<JobDoc | null> {
  const claimed = await claimJob(jobId);
  const job = await getJob(jobId);
  if (!job) return null;
  if (!claimed) return job; // already running or terminal — converge, don't re-run.

  await updateJob(jobId, stampAttempt(job, { engine: "real" }));
  const runId = job.opts.test?.runId;
  const kind = job.opts.test?.kind;
  const stream: (level: "info" | "warn" | "error", msg: string) => void = (level, msg) =>
    void appendLog({ source: "orchestrator", level, ts: Date.now(), msg, jobId, instanceId: job.instanceId });

  if (!runId || !kind) {
    await updateJob(jobId, { status: "failed", error: "test job missing runId/kind", finishedAt: Date.now() });
    return getJob(jobId);
  }

  stream("info", `test run ${runId}: starting ${kind} suite`);
  await updateTestRun(runId, { status: "running", startedAt: Date.now() });

  let checks: TestCheck[] = [];
  try {
    const run = await getTestRun(runId);
    if (!run) throw new Error(`test run ${runId} vanished`);
    // Dynamic import keeps Playwright out of the module graph until a test runs.
    const { runTests } = await import("./testRunner.ts");
    checks = await runTests(run, stream);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks = [{ name: kind, pass: false, detail: msg }];
    stream("error", `test run ${runId} threw: ${msg}`);
  }

  const passed = checks.length > 0 && checks.every((c) => c.pass);
  const passCount = checks.filter((c) => c.pass).length;
  await updateTestRun(runId, {
    status: passed ? "passed" : "failed",
    checks,
    finishedAt: Date.now(),
  });
  await updateJob(jobId, { status: "succeeded", finishedAt: Date.now() });
  stream(passed ? "info" : "warn", `test run ${runId}: ${passed ? "PASSED" : "FAILED"} (${passCount}/${checks.length} checks)`);
  return getJob(jobId);
}

// ── AI VALIDATED-FIX LOOP (round-3) ─────────────────────────────────────────
// Enqueue a `fix-loop` job that runs the propose→apply→verify loop against ONE
// FAILED, tool-created preview (lib/aiFixLoop.ts). The loop is long-running (it
// re-provisions the throwaway to verify each candidate), so it's a worker job, not
// an inline route call. Re-derives the scope guard here too (defense in depth — the
// route also guards): tool-created only, never prod/shared. Returns {jobId} or an
// error the route maps to a 409.
export async function enqueueFixLoop(
  instanceId: string,
): Promise<{ jobId: string; instanceId: string } | { error: string }> {
  const instance = await getInstance(instanceId);
  const guard = fixLoopGuard(instance, { requireFailed: true });
  if (!guard.ok) return { error: guard.reason };

  // Provisioning fields are inert for a fix-loop job (dimensions:[] so the ENQUEUE
  // never provisions anything); the loop itself drives re-provisions via
  // applyFixPlan. They only satisfy the shared JobOpts schema.
  const opts: JobOpts = {
    branch: instance!.branch,
    migrations: instance!.migrations,
    scrubPII: instance!.scrubPII,
    dimensions: [],
    target: { kind: instance!.kind, convexDeployment: instance!.createdConvexDeployment ?? instance!.convexDeployment },
  };
  // Timestamped key: each explicit request starts a fresh loop, while a same-ms
  // double-submit still converges to one job.
  const idempotencyKey = `fixloop:${instanceId}:${Date.now()}`;
  const job = await enqueueJob({ type: "fix-loop", opts, instanceId, idempotencyKey });
  maybeInlineRun(job.id, instanceId);
  return { jobId: job.id, instanceId };
}

// Execute a queued `fix-loop` job: claim it, create the flotilla_fixloops record, run
// the loop (streaming progress to flotilla_logs), and converge the record + job.
// Idempotent via claimJob. A loop that throws whole is caught and recorded as a
// failed loop — the worker never crashes. NOTE: the instance's own status is left
// as-is (the loop runs on the disposable clone; adopting a fix is a separate,
// operator-confirmed step) — we never silently flip the real instance here.
export async function runFixLoopJob(jobId: string): Promise<JobDoc | null> {
  const claimed = await claimJob(jobId);
  const job = await getJob(jobId);
  if (!job) return null;
  if (!claimed) return job; // already running or terminal — converge, don't re-run.

  await updateJob(jobId, stampAttempt(job, { engine: "real" }));
  const instanceId = job.instanceId;
  const stream: Stream = (level, msg) =>
    void appendLog({ source: "orchestrator", level, ts: Date.now(), msg, jobId, instanceId });

  if (!instanceId) {
    await updateJob(jobId, { status: "failed", error: "fix-loop job missing instanceId", finishedAt: Date.now() });
    return getJob(jobId);
  }

  const loop = await createFixLoop({ instanceId, jobId });
  stream("info", `fix-loop ${loop.id}: starting AI validated-fix loop (runs on the disposable clone only)`);

  try {
    const result = await runFixLoop(instanceId, { stream });
    await updateFixLoop(loop.id, {
      status: "succeeded",
      attempts: result.attempts,
      winningPlan: result.winningPlan,
      checkedAt: result.checkedAt,
    });
    await updateJob(jobId, {
      status: "succeeded",
      result: { ok: true, instanceId, steps: [] },
      finishedAt: Date.now(),
    });
    stream(
      result.winningPlan ? "info" : "warn",
      `fix-loop ${loop.id}: ${result.winningPlan ? "found a passing fix" : "no passing fix"} after ${result.attempts.length} attempt(s)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateFixLoop(loop.id, { status: "failed", error: msg, checkedAt: Date.now() });
    await updateJob(jobId, { status: "failed", error: msg, finishedAt: Date.now() });
    stream("error", `fix-loop ${loop.id} failed: ${msg}`);
  }
  return getJob(jobId);
}

// The most-recent loop record for a job — exported so the route/worker can read
// back what a run produced without re-importing the model everywhere.
export { getFixLoopByJob };

// ── PATCH PUSH ──────────────────────────────────────────────────────────────
// Enqueue a `patch-push` job: apply an operator-uploaded unified diff on top of
// the instance's base branch (ephemeral commit/branch) and redeploy the
// instance's OWN target (lib/patchPush.ts). Apply+deploy is long/filesystem work
// (git clone + apply + push, then a Vercel deploy), so it's a WORKER job — the
// route only validates + enqueues. Re-derives the scope guard + re-validates the
// patch here (defense in depth — the route guards + validates too): tool-created
// only, never prod/shared. Returns {jobId} or an error the route maps to 4xx.
export async function enqueuePatchPush(
  instanceId: string,
  input: { patch: string; filename?: string; note?: string },
): Promise<{ jobId: string; instanceId: string } | { error: string }> {
  const instance = await getInstance(instanceId);
  const guard = patchPushGuard(instance);
  if (!guard.ok) return { error: guard.reason };

  const v = validatePatch(input.patch);
  if (!v.ok) return { error: v.reason };

  await updateInstance(instanceId, { status: "provisioning", health: "provisioning" });

  // Provisioning fields are inert for a patch-push job (dimensions:[] so the
  // ENQUEUE never provisions anything); runPatchPush drives the code redeploy on
  // the ephemeral branch. They only satisfy the shared JobOpts schema.
  const opts: JobOpts = {
    branch: instance!.branch,
    migrations: instance!.migrations,
    scrubPII: instance!.scrubPII,
    dimensions: [],
    patch: { diff: input.patch, filename: input.filename, note: input.note },
    target: {
      kind: instance!.kind,
      convexDeployment: instance!.createdConvexDeployment ?? instance!.convexDeployment,
      vercelProject: instance!.vercelProject,
      createdByTool: instance!.createdByTool,
    },
  };
  // Timestamped key: each explicit upload is its own push, while a same-ms
  // double-submit still converges to one job.
  const idempotencyKey = `patchpush:${instanceId}:${Date.now()}`;
  const job = await enqueueJob({ type: "patch-push", opts, instanceId, idempotencyKey });
  await updateInstance(instanceId, { currentJobId: job.id });
  maybeInlineRun(job.id, instanceId);
  return { jobId: job.id, instanceId };
}

// Execute a queued `patch-push` job: claim it, apply the diff to an ephemeral
// branch + redeploy the instance's own target, and converge the instance + job.
// Idempotent via claimJob. A throw is caught and recorded as a failed job — the
// worker never crashes. On success the instance is stamped ready with the new
// deploy URL; the recorded base branch is left as-is (the patch is an ephemeral
// overlay — a later re-provision of the base branch reverts it, by design).
export async function runPatchPushJob(jobId: string): Promise<JobDoc | null> {
  const claimed = await claimJob(jobId);
  const job = await getJob(jobId);
  if (!job) return null;
  if (!claimed) return job; // already running or terminal — converge, don't re-run.

  await updateJob(jobId, stampAttempt(job, { engine: "real" }));
  const instanceId = job.instanceId;
  const stream: Stream = (level, msg) =>
    void appendLog({ source: "orchestrator", level, ts: Date.now(), msg, jobId, instanceId });

  const patch = job.opts.patch;
  if (!instanceId || !patch) {
    await updateJob(jobId, { status: "failed", error: "patch-push job missing instanceId/patch", finishedAt: Date.now() });
    return getJob(jobId);
  }

  stream("info", `patch-push: starting${patch.filename ? ` (${patch.filename})` : ""}`);
  try {
    const res = await runPatchPush(instanceId, patch.diff, { filename: patch.filename, note: patch.note }, { stream });
    if (res.ok) {
      await updateJob(jobId, {
        status: "succeeded",
        result: { ok: true, instanceId, url: res.url, steps: [] },
        finishedAt: Date.now(),
      });
      const instance = await getInstance(instanceId);
      await updateInstance(instanceId, {
        status: "ready",
        health: "healthy",
        url: res.url ?? instance?.url,
        vercelDeploymentId: res.vercelDeploymentId ?? instance?.vercelDeploymentId,
      });
      await notify({ kind: "instance.ready", instanceName: instance?.name ?? instanceId, url: res.url ?? instance?.url }).catch(() => {});
      stream("info", `patch-push: ${res.detail}`);
    } else {
      await updateJob(jobId, { status: "failed", error: res.detail, finishedAt: Date.now() });
      await updateInstance(instanceId, { status: "failed", health: "down" });
      stream("error", `patch-push failed: ${res.detail}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateJob(jobId, { status: "failed", error: msg, finishedAt: Date.now() });
    await updateInstance(instanceId, { status: "failed", health: "down" });
    stream("error", `patch-push threw: ${msg}`);
  }
  return getJob(jobId);
}

// Optional in-process execution of a test job (local dev / single-process deploy).
function maybeInlineTest(jobId: string): void {
  if (process.env.FLOTILLA_INLINE_WORKER !== "1") return;
  void runTestJob(jobId).catch(async (err) => {
    await appendLog({
      source: "orchestrator",
      level: "error",
      ts: Date.now(),
      msg: `inline test runner crashed: ${err instanceof Error ? err.message : String(err)}`,
      jobId,
    });
  });
}

// Optional in-process execution for local dev / single-process deploys. Off by
// default — the standalone worker is the real executor (see scripts/worker.ts).
function maybeInlineRun(jobId: string, instanceId: string): void {
  if (process.env.FLOTILLA_INLINE_WORKER !== "1") return;
  void runJob(jobId).catch(async (err) => {
    await appendLog({
      source: "orchestrator",
      level: "error",
      ts: Date.now(),
      msg: `inline runner crashed: ${err instanceof Error ? err.message : String(err)}`,
      jobId,
      instanceId,
    });
  });
}

// Map an instance + its job into the executor's ExecOpts. `onLog` streams every
// LogEvent to flotilla_logs so the UI's live tail and Logs tab see the same stream.
function toExecOpts(job: JobDoc, instance: InstanceDoc | null, onLog: (e: LogEvent) => void): ExecOpts {
  const t = job.opts.target;
  return {
    instanceName: instance?.name ?? job.instanceId ?? "instance",
    branch: job.opts.branch,
    data: job.opts.data,
    clerkInstance: job.opts.clerkInstance,
    migrations: job.opts.migrations,
    scrubPII: job.opts.scrubPII,
    dryRun: job.opts.dryRun,
    dimensions: job.opts.dimensions ?? [],
    dangerAck: job.opts.dangerAck,
    target: {
      kind: t.kind,
      convexDeployment: instance?.createdConvexDeployment ?? t.convexDeployment,
      vercelProject: t.vercelProject,
      createdByTool: instance?.createdByTool ?? t.createdByTool,
      lastImportedSnapshotId: instance?.lastImportedSnapshotId ?? t.lastImportedSnapshotId,
    },
    onLog,
  };
}

// Execute a queued job. Idempotent: claimJob flips queued→running exactly once,
// so a re-invocation on an already-running/finished job returns without re-running.
export async function runJob(jobId: string): Promise<JobDoc | null> {
  // TEST jobs are a different verb (read-only suite, not provision) — route them
  // to their own runner (which claims the job itself), before the provision claim.
  const pre = await getJob(jobId);
  if (pre?.type === "test") return runTestJob(jobId);
  // FIX-LOOP is an ORCHESTRATION verb (propose→apply→verify, re-provisioning the
  // throwaway), not a single provision — route it to its own runner.
  if (pre?.type === "fix-loop") return runFixLoopJob(jobId);
  // PATCH-PUSH is an apply-diff-then-redeploy verb — route it to its own runner
  // (which applies the diff to an ephemeral branch before the code redeploy).
  if (pre?.type === "patch-push") return runPatchPushJob(jobId);

  const claimed = await claimJob(jobId);
  const job = await getJob(jobId);
  if (!job) return null;
  if (!claimed) return job; // already running or terminal — converge, don't double-run.

  await updateJob(jobId, stampAttempt(job, { engine: "real" }));
  const instance = job.instanceId ? await getInstance(job.instanceId) : null;
  const onLog = (e: LogEvent) => void appendLog({ ...e, jobId, instanceId: job.instanceId });

  // TEARDOWN is a different verb (reclaim, not provision) — dispatch it here.
  if (job.type === "teardown") return runTeardownJob(job, instance, jobId, onLog);

  try {
    const out = await executeProvision(toExecOpts(job, instance, onLog));
    const result = { ok: out.ok, instanceId: job.instanceId ?? "", url: out.url, steps: out.steps };

    if (out.ok) {
      await updateJob(jobId, { status: "succeeded", result, steps: out.steps, finishedAt: Date.now() });
      if (job.instanceId) {
        // A data (re)import stamps freshness; `masked` reflects whether PII was
        // masked this run (only meaningful when data was imported).
        const importedThisRun = out.lastImportedSnapshotId !== instance?.lastImportedSnapshotId;
        await updateInstance(job.instanceId, {
          status: "ready",
          health: job.opts.dryRun ? "unknown" : "healthy",
          url: out.url ?? instance?.url,
          createdByTool: out.createdByTool,
          createdConvexDeployment: out.createdByTool ? out.convexDeployment : instance?.createdConvexDeployment,
          createdConvexUrl: out.createdByTool ? out.convexUrl : instance?.createdConvexUrl,
          convexDeployment: out.convexDeployment ?? instance?.convexDeployment,
          vercelDeploymentId: out.vercelDeploymentId ?? instance?.vercelDeploymentId,
          lastImportedSnapshotId: out.lastImportedSnapshotId ?? instance?.lastImportedSnapshotId,
          masked: importedThisRun ? out.masked : instance?.masked,
          lastRefreshedAt: importedThisRun && !job.opts.dryRun ? Date.now() : instance?.lastRefreshedAt,
        });
        // Provision/update/refresh converged ready → proactive alert (best-effort,
        // double-gated in notify()). Skip dry-runs — nothing was really deployed.
        if (!job.opts.dryRun) {
          await notify({
            kind: "instance.ready",
            instanceName: instance?.name ?? job.instanceId,
            url: out.url ?? instance?.url,
          }).catch(() => {});
          // Auto-materialize the instance's default monitor check-set (Phase 2,
          // flag-gated + best-effort; idempotent so a re-ready never dupes). Never
          // let a monitoring failure break the provision.
          await onInstanceReady(job.instanceId).catch(() => {});
          // Edit the canonical PR comment to "ready + URL" for a PR-native instance
          // (best-effort, flag/token/PR-gated inside syncPrComment).
          await syncPrComment(job.instanceId, "ready").catch(() => {});
        }
      }
    } else {
      const rolledBack = out.steps.some((s) => s.rolledBack);
      await updateJob(jobId, {
        status: rolledBack ? "rolled_back" : "failed",
        result,
        steps: out.steps,
        error: "provision reported failure",
        finishedAt: Date.now(),
      });
      if (job.instanceId) {
        await updateInstance(job.instanceId, { status: "failed", health: "down" });
        await syncPrComment(job.instanceId, "failed").catch(() => {});
      }
    }
    return getJob(jobId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await appendLog({ source: "orchestrator", level: "error", ts: Date.now(), msg: `provision threw: ${msg}`, jobId, instanceId: job.instanceId });
    await updateJob(jobId, { status: "failed", error: msg, finishedAt: Date.now() });
    if (job.instanceId) await updateInstance(job.instanceId, { status: "failed", health: "down" });
    return getJob(jobId);
  }
}

// Map a teardown job + its instance into ExecTeardownOpts.
function toTeardownOpts(job: JobDoc, instance: InstanceDoc | null, onLog: (e: LogEvent) => void): ExecTeardownOpts {
  const t = job.opts.target;
  return {
    instanceId: job.instanceId ?? "",
    instanceName: instance?.name ?? job.instanceId ?? "instance",
    createdByTool: instance?.createdByTool ?? t.createdByTool,
    convexDeployment: instance?.createdConvexDeployment ?? instance?.convexDeployment ?? t.convexDeployment,
    vercelProject: instance?.vercelProject ?? t.vercelProject,
    vercelDeploymentId: instance?.vercelDeploymentId,
    dryRun: job.opts.dryRun,
    onLog,
  };
}

// Execute a teardown job: reclaim resources, then mark the instance archived.
async function runTeardownJob(
  job: JobDoc,
  instance: InstanceDoc | null,
  jobId: string,
  onLog: (e: LogEvent) => void,
): Promise<JobDoc | null> {
  try {
    const out = await executeTeardown(toTeardownOpts(job, instance, onLog));
    const result = { ok: out.ok, instanceId: job.instanceId ?? "", steps: out.steps };
    if (out.ok) {
      await updateJob(jobId, { status: "succeeded", result, steps: out.steps, finishedAt: Date.now() });
      if (job.instanceId && !job.opts.dryRun) {
        await updateInstance(job.instanceId, { status: "archived", health: "down", currentJobId: undefined });
        // Teardown completed → proactive alert (best-effort, double-gated).
        await notify({
          kind: "instance.teardown",
          instanceName: instance?.name ?? job.instanceId,
        }).catch(() => {});
        // Remove the instance's autoManaged monitors + state so nothing keeps
        // flapping on a resource that no longer exists (Phase 2, best-effort).
        await onInstanceTeardown(job.instanceId).catch(() => {});
        // Final PR comment edit → "torn down" (best-effort, PR-gated).
        await syncPrComment(job.instanceId, "torn-down").catch(() => {});
      }
    } else {
      await updateJob(jobId, { status: "failed", result, steps: out.steps, error: "teardown reported failure", finishedAt: Date.now() });
      // Leave status as-is on failure so a retry can reclaim what's left.
      if (job.instanceId) await updateInstance(job.instanceId, { health: "degraded" });
    }
    return getJob(jobId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await appendLog({ source: "orchestrator", level: "error", ts: Date.now(), msg: `teardown threw: ${msg}`, jobId, instanceId: job.instanceId });
    await updateJob(jobId, { status: "failed", error: msg, finishedAt: Date.now() });
    return getJob(jobId);
  }
}
