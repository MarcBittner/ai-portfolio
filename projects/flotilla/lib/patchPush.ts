// lib/patchPush.ts — PATCH PUSH: apply an operator-uploaded unified diff to a
// running instance and redeploy it, so the change goes live on that preview/
// staging target.
//
// WHAT IT IS: an operator uploads a `.patch`/`.diff` (a unified diff). We apply it
// on top of the instance's BASE branch as a fresh commit on an EPHEMERAL branch
// (via the GitHub client, on the worker), then trigger a CODE redeploy of that
// ref through the existing executor/Vercel deploy step. Deployments are git-ref
// based today (lib/clients/vercel.ts createDeployment uses gitSource.ref), so an
// ephemeral branch is the clean fit — no bespoke raw-file deploy path.
//
// SAFETY (non-negotiable, mirrors the AI fix-loop's scope discipline):
//   • Scope = the instance's OWN disposable, tool-created target. patchPushGuard
//     refuses unless createdByTool===true and neither the Convex deployment
//     (prod PROD_CONVEX_DEPLOYMENT / shared SHARED_DEPLOYMENTS) nor the Vercel
//     project (PROTECTED_VERCEL_PROJECTS) is prod/shared. Re-derived on EVERY
//     path (route + enqueue + here) — defense in depth.
//   • The redeploy runs through executeProvision, so the engine's PREFLIGHT
//     (prod Vercel hard-block, shared danger-gate, prod Convex hard-block) also
//     applies regardless of this guard — a patch can NEVER reach prod/shared.
//   • Validation: validatePatch is the out-of-band gate — size cap, binary/huge
//     rejection, well-formed-unified-diff check — run before anything is enqueued.
//
// Injectable upstreams (mirrors lib/aiFixLoop.ts) so the whole flow unit-tests
// with no Mongo / no GITHUB_TOKEN / no real git / no real provision.

import { getInstance, type InstanceDoc } from "./models/instances.ts";
import { makeLogger } from "./logtap.ts";
import { PROD_CONVEX_DEPLOYMENT } from "./provision.ts";
import { SHARED_DEPLOYMENTS, PROTECTED_VERCEL_PROJECTS, executeProvision, type ExecOpts } from "./executor.ts";
import { pushPatchBranch as realPushPatchBranch, type PushPatchArgs, type PushPatchResult } from "./clients/github.ts";

export type Stream = (level: "info" | "warn" | "error", msg: string) => void;

// ── Patch validation (the out-of-band gate) ─────────────────────────────────
// A conservative unified-diff validator. It does NOT try to parse every hunk
// perfectly — it rejects the dangerous/degenerate shapes (empty, binary, over
// size/file/line budget, obviously-not-a-diff) so only a plausible text diff is
// ever handed to `git apply`, which is the real authority on applicability.

export type PatchLimits = { maxBytes: number; maxFiles: number; maxLines: number };

export const PATCH_LIMITS: PatchLimits = {
  // Max raw diff size. Diffs are carried inline in the job doc (Mongo), so keep
  // this well under the 16 MB BSON limit; a legit code patch is far smaller.
  maxBytes: 1_000_000, // 1 MB
  maxFiles: 200,
  maxLines: 20_000,
};

export type PatchStats = { bytes: number; files: number; hunks: number; lines: number };
export type PatchValidation =
  | { ok: true; stats: PatchStats }
  | { ok: false; reason: string };

// Byte length of a UTF-8 string without allocating a Buffer in edge runtimes.
function byteLength(s: string): number {
  return typeof Buffer !== "undefined" ? Buffer.byteLength(s, "utf8") : new TextEncoder().encode(s).length;
}

export function validatePatch(input: unknown, limits: PatchLimits = PATCH_LIMITS): PatchValidation {
  if (typeof input !== "string") return { ok: false, reason: "patch must be text" };
  const text = input;
  if (text.trim().length === 0) return { ok: false, reason: "patch is empty" };

  const bytes = byteLength(text);
  if (bytes > limits.maxBytes) {
    return { ok: false, reason: `patch too large (${bytes} bytes > ${limits.maxBytes})` };
  }
  // A NUL byte means it isn't a text/unified diff — reject rather than feed git a
  // binary blob.
  if (text.includes("\0")) return { ok: false, reason: "patch contains binary (NUL) bytes" };
  // git binary patches can't be reviewed/applied as text here — reject explicitly.
  if (/^GIT binary patch$/m.test(text) || /^Binary files .* differ$/m.test(text)) {
    return { ok: false, reason: "binary patches are not supported" };
  }

  const lines = text.split("\n");
  if (lines.length > limits.maxLines) {
    return { ok: false, reason: `patch too long (${lines.length} lines > ${limits.maxLines})` };
  }

  // Count file headers + hunks. Accept both `git diff` output and a plain
  // `diff -u` (--- / +++ / @@ …). A well-formed unified diff must have at least
  // one hunk header ("@@ -a,b +c,d @@") and a file-target header.
  let files = 0;
  let hunks = 0;
  let hasFileHeader = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) files++;
    else if (line.startsWith("+++ ")) hasFileHeader = true;
    else if (/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(line)) hunks++;
  }
  // No `diff --git` header (a plain `diff -u`) still counts files by `+++` markers.
  if (files === 0) files = lines.filter((l) => l.startsWith("+++ ")).length;

  if (hunks === 0) return { ok: false, reason: "no unified-diff hunks (@@ …) found" };
  if (!hasFileHeader) return { ok: false, reason: "no file headers (+++ …) found — not a unified diff" };
  if (files > limits.maxFiles) {
    return { ok: false, reason: `patch touches too many files (${files} > ${limits.maxFiles})` };
  }

  return { ok: true, stats: { bytes, files: Math.max(files, 1), hunks, lines: lines.length } };
}

// ── Scope guard (re-derived on EVERY path) ──────────────────────────────────
export type GuardResult = { ok: true; deployment?: string } | { ok: false; reason: string };

// Tool-created only; never a prod/shared Convex deployment, never a prod/shared
// Vercel project. Mirrors fixLoopGuard (lib/aiFixLoop.ts) — the executor preflight
// re-checks the same topology regardless, this just fails fast + explicit.
export function patchPushGuard(inst: InstanceDoc | null): GuardResult {
  if (!inst) return { ok: false, reason: "instance not found" };
  if (inst.createdByTool !== true) {
    return { ok: false, reason: "patch push only runs on tool-created instances (createdByTool!=true)" };
  }
  const deployment = inst.createdConvexDeployment ?? inst.convexDeployment;
  if (deployment === PROD_CONVEX_DEPLOYMENT) {
    return { ok: false, reason: `refusing: ${deployment} is the PRODUCTION deployment` };
  }
  if (deployment && SHARED_DEPLOYMENTS[deployment]) {
    return { ok: false, reason: `refusing: ${deployment} is the shared "${SHARED_DEPLOYMENTS[deployment]}" deployment` };
  }
  const project = inst.vercelProject;
  if (project && PROTECTED_VERCEL_PROJECTS.has(project.toLowerCase())) {
    return { ok: false, reason: `refusing: Vercel project "${project}" is a shared/prod project` };
  }
  return { ok: true, deployment };
}

// A url-safe ephemeral branch name derived from the instance name + a timestamp,
// so re-pushing produces a fresh branch and we never collide with a real branch.
export function ephemeralBranchName(instance: InstanceDoc, nowMs = Date.now()): string {
  const slug = instance.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "instance";
  return `flotilla-patch/${slug}-${nowMs.toString(36)}`;
}

// ── Apply + deploy ──────────────────────────────────────────────────────────
export type PatchPushResult = {
  ok: boolean;
  branch?: string;
  headSha?: string;
  filesChanged?: number;
  url?: string;
  vercelDeploymentId?: string;
  detail: string;
};

export type PushPatchFn = (args: PushPatchArgs) => Promise<PushPatchResult>;
export type ProvisionFn = (opts: ExecOpts) => Promise<Awaited<ReturnType<typeof executeProvision>>>;

export type PatchPushDeps = {
  getInstance?: (id: string) => Promise<InstanceDoc | null>;
  pushPatch?: PushPatchFn;
  provision?: ProvisionFn;
  stream?: Stream;
  now?: () => number;
};

// The real CODE redeploy of the ephemeral branch onto the instance's OWN target.
// Forces the reclaim-my-own-preview path (createdByTool + dangerAck), exactly like
// the fix-loop's realReprovision — the engine's prod/shared HARD blocks still apply.
function toRedeployOpts(inst: InstanceDoc, branch: string, stream: Stream): ExecOpts {
  const deployment = inst.createdConvexDeployment ?? inst.convexDeployment;
  return {
    instanceName: inst.name,
    branch,
    clerkInstance: inst.clerkInstance,
    migrations: inst.migrations,
    scrubPII: inst.scrubPII,
    dryRun: false,
    // CODE only — a patch changes code; data/clerk are untouched.
    dimensions: ["code"],
    // Its own tool-created target: overwrite is expected. The prod/shared HARD
    // blocks in the engine preflight still apply regardless of this ack.
    dangerAck: true,
    target: {
      kind: inst.kind,
      convexDeployment: deployment,
      vercelProject: inst.vercelProject,
      createdByTool: true,
      lastImportedSnapshotId: inst.lastImportedSnapshotId,
    },
    onLog: (e) => stream(e.level, `[redeploy] ${e.source} ${e.msg}`),
  };
}

// runPatchPush — the orchestration: guard → validate → apply-to-ephemeral-branch
// → code redeploy. Re-derives the guard + re-validates the patch (defense in
// depth; the route/enqueue already did both). Throws if the guard refuses or the
// patch is invalid — a caught throw becomes a failed job, never a silent deploy.
export async function runPatchPush(
  instanceId: string,
  patch: string,
  opts: { filename?: string; note?: string } = {},
  deps: PatchPushDeps = {},
): Promise<PatchPushResult> {
  const load = deps.getInstance ?? getInstance;
  const push = deps.pushPatch ?? realPushPatchBranch;
  const provision = deps.provision ?? executeProvision;
  const stream = deps.stream ?? (() => {});
  const nowFn = deps.now ?? (() => Date.now());

  const inst = await load(instanceId);
  const guard = patchPushGuard(inst);
  if (!guard.ok) throw new Error(`patch push refused: ${guard.reason}`);

  const v = validatePatch(patch);
  if (!v.ok) throw new Error(`invalid patch: ${v.reason}`);

  const branch = ephemeralBranchName(inst!, nowFn());
  stream(
    "info",
    `patch push: applying ${v.stats.files} file(s)/${v.stats.hunks} hunk(s) onto ${inst!.branch} → ${branch}`,
  );

  // A real ScopedLogger (produced via makeLogger) so the git client's log type is
  // satisfied; every line is funneled back through the caller's stream.
  const ghLog = makeLogger((e) => stream(e.level, `[github] ${e.msg}`)).for("orchestrator");
  const pushed = await push({
    baseBranch: inst!.branch,
    patch,
    branchName: branch,
    commitMessage: `flotilla: apply uploaded patch${opts.filename ? ` (${opts.filename})` : ""}${
      opts.note ? ` — ${opts.note}` : ""
    }`,
    log: ghLog,
  });
  stream("info", `patch push: pushed ${pushed.branch} @ ${pushed.headSha.slice(0, 8)} (${pushed.filesChanged} file(s) changed)`);

  const outcome = await provision(toRedeployOpts(inst!, pushed.branch, stream));
  const failed = outcome.steps.find((s) => !s.ok);
  return {
    ok: outcome.ok,
    branch: pushed.branch,
    headSha: pushed.headSha,
    filesChanged: pushed.filesChanged,
    url: outcome.url,
    vercelDeploymentId: outcome.vercelDeploymentId,
    detail: outcome.ok
      ? `patch deployed on ${pushed.branch} (${outcome.url ?? "no url"})`
      : `redeploy failed at step "${failed?.name ?? "?"}": ${failed?.detail ?? "provision reported failure"}`,
  };
}
