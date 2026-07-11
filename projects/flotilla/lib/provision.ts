// lib/provision.ts — the reusable provisioning engine (Spike SP-2, hardened).
//
// Workstream B's job runner depends on the EXACT ProvisionOpts / StepResult /
// ProvisionResult shapes below — do not change them without updating B.
//
// Model: a linear saga of named steps, each of which may register a
// COMPENSATING action. On an uncorrectable failure the runner unwinds executed
// steps in reverse (teardown preview / restore snapshot), so a half-provisioned
// instance never lingers (project plan §11). Idempotent: re-running converges —
// deployments are reused, and the snapshot is re-imported ONLY when the chosen
// backupRef differs from what was last imported (tracked in a deployment env
// marker, so it survives across process runs without needing Mongo).

import { execCapture } from "./clients/exec.ts";
import { makeConvexClient, type ConvexClient } from "./clients/convex.ts";
import { makeVercelClient, type VercelClient } from "./clients/vercel.ts";
import { makeClerkClient, type ClerkClient } from "./clients/clerk.ts";
import { scrubExportDir } from "./scrub.ts";
import { makeLogger, type LogEvent, type ScopedLogger } from "./logtap.ts";
import { PROD_CONVEX_DEPLOYMENT } from "./deployments.ts";

// ── Contract (Workstream B depends on this exact shape) ─────────────────────
export type ProvisionOpts = {
  branch: string;
  backupRef: string;
  target: {
    kind: "preview" | "staging";
    convexDeployment: string;
    clerkInstance: string;
    vercelProject?: string;
  };
  migrations: boolean;
  scrubPII: boolean;
  onLog: (e: LogEvent) => void;
  dryRun?: boolean;
};

export type StepResult = { name: string; ok: boolean; rolledBack?: boolean; detail?: string };
export type ProvisionResult = { ok: boolean; instanceId: string; url?: string; steps: StepResult[] };

// The production deployment must NEVER be a provision/refresh target. Sourced from
// the central deployment topology (env-overridable); re-exported here for the many
// call sites that import it from this module. Treated as poison regardless.
export { PROD_CONVEX_DEPLOYMENT };

// Forward migrations safe to run against an imported clone, default-on. Ordered.
// resetAuthIdsForClonedDeployment is run as its own step (not here). See the
// exclusions for why some migrations are withheld from non-prod clones.
export const DEFAULT_FORWARD_MIGRATIONS = [
  "migrations:backfillChangeOrderCount",
  "migrations:backfillInternalCodes",
  "migrations:backfillRfiPriorStatus", // NOTE: also a deploy gate; idempotent (skips rows already set)
  "migrations:backfillRfiDueDate",
] as const;

// Migrations that must NOT run against a non-prod clone, with rationale.
export const EXCLUDED_MIGRATIONS: Record<string, string> = {
  "migrations:backfillStakeholderRoles":
    'prod-only per migrations.ts ("DO NOT execute against dev"); needs Randy approval, run manually against prod after deploy',
};

// ── Saga runner (shared with scripts/refresh-staging.ts) ────────────────────
export type SagaStep = {
  name: string;
  /** May throw to signal an uncorrectable failure (triggers reverse unwind). */
  run: () => Promise<{ detail?: string; compensate?: () => Promise<void>; skipped?: boolean }>;
};

export type SagaOutcome = { ok: boolean; steps: StepResult[] };

export async function runSaga(steps: SagaStep[], log: ScopedLogger): Promise<SagaOutcome> {
  const results: StepResult[] = [];
  const executed: Array<{ name: string; compensate?: () => Promise<void> }> = [];

  for (const step of steps) {
    log("info", `▶ step: ${step.name}`);
    try {
      const out = await step.run();
      results.push({ name: step.name, ok: true, detail: out.skipped ? `skipped (converged): ${out.detail ?? ""}`.trim() : out.detail });
      // A skipped/converged step registers nothing to unwind.
      if (!out.skipped) executed.push({ name: step.name, compensate: out.compensate });
      log("info", `✓ step: ${step.name}${out.skipped ? " (skipped/converged)" : ""}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ name: step.name, ok: false, detail });
      log("error", `✗ step: ${step.name} — ${detail}`);

      // Unwind previously-executed steps in reverse, best-effort.
      for (let i = executed.length - 1; i >= 0; i--) {
        const e = executed[i];
        const r = results.find((x) => x.name === e.name);
        if (!e.compensate) continue;
        try {
          log("warn", `↩ compensating: ${e.name}`);
          await e.compensate();
          if (r) r.rolledBack = true;
        } catch (cErr) {
          const cMsg = cErr instanceof Error ? cErr.message : String(cErr);
          log("error", `‼ compensation FAILED for ${e.name}: ${cMsg}`);
          if (r) r.detail = `${r.detail ?? ""} | rollback failed: ${cMsg}`.trim();
        }
      }
      return { ok: false, steps: results };
    }
  }
  return { ok: true, steps: results };
}

// ── provision() ─────────────────────────────────────────────────────────────
const LAST_IMPORTED_MARKER = "LAST_IMPORTED_BACKUP_REF";

type Clients = { convex: ConvexClient; vercel: VercelClient; clerk: ClerkClient };

function buildClients(opts: ProvisionOpts, logger: ReturnType<typeof makeLogger>): Clients {
  return {
    convex: makeConvexClient({ log: logger.for("convex"), dryRun: opts.dryRun }),
    vercel: makeVercelClient({ log: logger.for("vercel"), dryRun: opts.dryRun }),
    clerk: makeClerkClient({ log: logger.for("clerk"), dryRun: opts.dryRun, secretKey: undefined }),
  };
}

/**
 * Turn a chosen backup into an importable path, scrubbing PII first when asked
 * (so real PII never touches the target). Runs before `convex import`.
 */
async function prepareImportPath(
  backupRef: string,
  scrubPII: boolean,
  dryRun: boolean | undefined,
  log: ScopedLogger,
): Promise<string> {
  if (!scrubPII) return backupRef;
  if (dryRun) {
    log("info", `[dry-run] would unzip ${backupRef}, scrub PII, re-zip → <scrubbed>.zip`);
    return `${backupRef}.scrubbed.zip`;
  }
  const work = `${backupRef}.work`;
  const scrubbedDir = `${backupRef}.scrubbed`;
  const scrubbedZip = `${scrubbedDir}.zip`;
  // No shell: execFile with array args. The previous `bash -lc "cd … && zip …"`
  // ran backupRef through a shell (JSON.stringify is NOT shell-escaping), so a
  // ref like `/tmp/x$(cmd).zip` executed `cmd` (RCE). `--` stops a `-`-prefixed
  // path from being parsed as a flag.
  await execCapture("unzip", ["-o", "--", backupRef, "-d", work], { log });
  scrubExportDir(work, scrubbedDir, { log });
  await execCapture("zip", ["-r", scrubbedZip, "."], { log, cwd: scrubbedDir });
  return scrubbedZip;
}

export async function provision(opts: ProvisionOpts): Promise<ProvisionResult> {
  const logger = makeLogger(opts.onLog);
  const olog = logger.for("orchestrator");
  const { convex, vercel, clerk } = buildClients(opts, logger);
  const { target } = opts;
  const instanceId = `${target.kind}-${target.convexDeployment}`;

  olog("info", `provision start: instance=${instanceId} branch=${opts.branch} backupRef=${opts.backupRef} dryRun=${!!opts.dryRun}`);

  let url: string | undefined;
  const steps: SagaStep[] = [];

  // 1) Preflight — never target prod; assert email kill-switch off on the target.
  steps.push({
    name: "preflight",
    run: async () => {
      if (target.convexDeployment === PROD_CONVEX_DEPLOYMENT) {
        throw new Error(`refusing to provision the production deployment ${PROD_CONVEX_DEPLOYMENT}`);
      }
      const emailFlag = await convex.getEnv({ deployment: target.convexDeployment, key: "ALLOW_OUTBOUND_EMAIL" });
      if (emailFlag === "true") {
        throw new Error("ALLOW_OUTBOUND_EMAIL=true on target — that marks a production deployment; refusing");
      }
      return { detail: `target ${target.convexDeployment} is non-prod, email kill-switch active` };
    },
  });

  // 2) Deploy code (idempotent: reuse an existing READY deployment for the branch).
  if (target.vercelProject) {
    const project = target.vercelProject;
    steps.push({
      name: "deploy-code",
      run: async () => {
        const existing = (await vercel.listDeployments(project)).find((d) => d.readyState === "READY");
        if (existing) {
          url = existing.url;
          return { detail: `reused deployment ${existing.id} (${existing.url})` };
        }
        const dep = await vercel.createDeployment({ project, branch: opts.branch });
        url = dep.url;
        return {
          detail: `deployed ${dep.id} (${dep.url})`,
          // Only tear down previews we created; never a reused/staging deployment.
          compensate: target.kind === "preview" ? async () => vercel.deleteDeployment(dep.id) : undefined,
        };
      },
    });
  }

  // 3) Snapshot the target FIRST — this is the master compensator (restore).
  let snapshotPath: string | undefined;
  steps.push({
    name: "snapshot-target",
    run: async () => {
      const ref = await convex.exportSnapshot({
        deployment: target.convexDeployment,
        outPath: `/tmp/provision-${instanceId}-pre-${Date.now()}.zip`,
      });
      snapshotPath = ref.path;
      return {
        detail: `snapshot ${ref.id}`,
        compensate: async () => {
          olog("warn", `restoring target from pre-provision snapshot ${ref.id}`);
          await convex.importSnapshot({ deployment: target.convexDeployment, inPath: ref.path, replaceAll: true, includeFileStorage: true });
        },
      };
    },
  });

  // 4) Import the chosen backup — but ONLY if backupRef changed (idempotency).
  steps.push({
    name: "import-data",
    run: async () => {
      const last = await convex.getEnv({ deployment: target.convexDeployment, key: LAST_IMPORTED_MARKER });
      if (last === opts.backupRef) {
        return { skipped: true, detail: `backupRef unchanged (${opts.backupRef})` };
      }
      const importPath = await prepareImportPath(opts.backupRef, opts.scrubPII, opts.dryRun, logger.for("orchestrator"));
      await convex.importSnapshot({ deployment: target.convexDeployment, inPath: importPath, replaceAll: true, includeFileStorage: true });
      await convex.setEnv({ deployment: target.convexDeployment, key: LAST_IMPORTED_MARKER, value: opts.backupRef });
      return { detail: `imported ${opts.backupRef}${opts.scrubPII ? " (scrubbed)" : ""}` };
    },
  });

  // 5) Reset authIds — imported prod authIds carry prod's Clerk issuer and can
  //    never match this instance's tokens; rewrite to pending:<email>.
  steps.push({
    name: "reset-auth",
    run: async () => {
      const r = await convex.run({ deployment: target.convexDeployment, functionName: "migrations:resetAuthIdsForClonedDeployment", args: { confirm: true } });
      if (!r.ok) throw new Error(`resetAuthIds failed: ${r.stderr.slice(0, 200)}`);
      return { detail: "authIds reset to pending:<email>" };
    },
  });

  // 6) Forward migrations (default on, togglable).
  if (opts.migrations) {
    steps.push({
      name: "migrations",
      run: async () => {
        for (const name of DEFAULT_FORWARD_MIGRATIONS) {
          const r = await convex.run({ deployment: target.convexDeployment, functionName: name });
          if (!r.ok) throw new Error(`${name} failed: ${r.stderr.slice(0, 200)}`);
        }
        const excluded = Object.keys(EXCLUDED_MIGRATIONS).join(", ");
        return { detail: `ran ${DEFAULT_FORWARD_MIGRATIONS.length} forward migrations; excluded prod-only: ${excluded}` };
      },
    });
  }

  // 7) Verify — email suppressed, functions deployed, sample sign-in mintable.
  steps.push({
    name: "verify",
    run: async () => {
      const emailFlag = await convex.getEnv({ deployment: target.convexDeployment, key: "ALLOW_OUTBOUND_EMAIL" });
      if (emailFlag === "true") throw new Error("post-provision: ALLOW_OUTBOUND_EMAIL=true — email not suppressed");
      const hasReset = await convex.functionExists({ deployment: target.convexDeployment, functionName: "resetAuthIdsForClonedDeployment" });
      if (!hasReset && !opts.dryRun) throw new Error("verify: expected functions not deployed");
      const users = await clerk.listUsers({ limit: 1 });
      if (users[0]) await clerk.createSignInToken({ userId: users[0].id });
      return { detail: "email suppressed, functions present, sample sign-in token mintable" };
    },
  });

  void snapshotPath; // captured for symmetry / potential external restore

  const outcome = await runSaga(steps, olog);
  olog(outcome.ok ? "info" : "error", `provision ${outcome.ok ? "succeeded" : "FAILED (unwound)"}: instance=${instanceId}`);
  return { ok: outcome.ok, instanceId, url, steps: outcome.steps };
}
