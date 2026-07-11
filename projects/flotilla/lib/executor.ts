// lib/executor.ts — the ASYNC, all-HTTP provisioning engine run by the worker.
//
// This is the serverless-orchestration core the dashboard needed: it drives a
// provision/update entirely over HTTP APIs (Vercel REST + the Convex management
// and deployment cloud APIs) instead of the local `convex` CLI, so it can run
// from a standalone worker (scripts/worker.ts) that polls the Mongo job queue.
// The serverless API only ENQUEUES; this executes.
//
// Two shapes, one engine (see lib/models/instances.ts):
//   • FRESH    — provision a NEW isolated Convex preview deployment + a fresh
//                Vercel deployment, then load the chosen backup INTO the fresh
//                deployment. Nothing pre-existing is touched.
//   • EXISTING — refresh a user-selected deployment (the staging-refresh use
//                case). Danger-gated: requires an explicit dangerAck, and a
//                best-effort email-kill-switch preflight. Production is a HARD
//                write-block regardless of ack.
//
// A PATCH re-provisions only the changed `dimensions` (code / data / clerk).
// Idempotent: a fresh convex deployment is re-claimed by the same previewName,
// and data-import is skipped when the chosen snapshot is unchanged.

import { Readable } from "node:stream";
import { makeLogger, type LogEvent, type ScopedLogger } from "./logtap.ts";
import { runSaga, DEFAULT_FORWARD_MIGRATIONS, EXCLUDED_MIGRATIONS, PROD_CONVEX_DEPLOYMENT, type SagaStep, type StepResult } from "./provision.ts";
import { SHARED_DEPLOYMENTS } from "./deployments.ts";
import { makeVercelClient } from "./clients/vercel.ts";
import { makeConvexDeployClient, type DeploymentCreds } from "./clients/convexDeploy.ts";
import { makeConvexBackupsClient } from "./clients/convexBackups.ts";
import type { JobDimension } from "./models/jobs.ts";

// Shared, pre-existing deployments the tool must never SILENTLY overwrite. Prod
// is a hard block (below); the rest are danger-flagged in preflight. Read-only
// use (a backup snapshot as a data SOURCE) is always fine. Sourced from the central
// deployment topology (env-overridable); re-exported for existing importers.
export { SHARED_DEPLOYMENTS };

export type ExecTarget = {
  kind: "preview" | "staging";
  /** Existing deployment to write to; undefined / "fresh" => provision anew. */
  convexDeployment?: string;
  vercelProject?: string;
  /** The target Convex deployment was provisioned by this tool (reuse it). */
  createdByTool?: boolean;
  /** Idempotency marker: snapshot already imported into the target. */
  lastImportedSnapshotId?: string;
};

export type ExecOpts = {
  instanceName: string;
  branch: string;
  data?: { backupSnapshotId: string; backupDeployment: string };
  clerkInstance?: string;
  migrations: boolean;
  scrubPII: boolean;
  dryRun?: boolean;
  dimensions: JobDimension[];
  dangerAck?: boolean;
  target: ExecTarget;
  onLog: (e: LogEvent) => void;
};

export type ExecOutcome = {
  ok: boolean;
  steps: StepResult[];
  url?: string;
  vercelDeploymentId?: string;
  convexDeployment?: string;
  convexUrl?: string;
  createdByTool: boolean;
  lastImportedSnapshotId?: string;
  /** True when the imported snapshot had PII masking applied (safe-by-default). */
  masked: boolean;
};

// Snapshot SOURCES whose data is real prod/staging-prod PII: masking is FORCED on
// for these regardless of the caller's scrubPII flag (safe-by-default clone).
const PROD_DATA_SOURCES = new Set(
  Object.entries(SHARED_DEPLOYMENTS)
    .filter(([, label]) => label === "PRODUCTION" || label === "staging-prod")
    .map(([name]) => name),
);
export function isProdDataSource(deployment: string | undefined): boolean {
  return !!deployment && PROD_DATA_SOURCES.has(deployment);
}

// A Convex preview name must be short + url-safe; derive it deterministically
// from the instance name so re-provisioning re-claims the SAME deployment.
function previewNameFor(instanceName: string): string {
  const slug = instanceName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || `inst-${Date.now().toString(36)}`;
}

// Locate the chosen snapshot as a readable stream: prefer a blob already
// "grabbed" into the tool (flotilla_backups) — resolved by store kind: NEW rows are
// GitHub release assets (blobRef), LEGACY rows are GridFS (gridfsId) — else
// stream it live from the Convex cloud backup. Dynamic imports keep the store
// clients out of the API bundle.
async function openSnapshotSource(
  backupDeployment: string,
  backupSnapshotId: string,
  log: ScopedLogger,
): Promise<Readable> {
  const { listBackups } = await import("./models/index.ts");
  const grabbed = (await listBackups(backupDeployment)).find(
    (b) => b.snapshotId === backupSnapshotId && (b.blobRef || b.gridfsId),
  );
  if (grabbed?.storeKind === "gh" || grabbed?.blobRef) {
    if (grabbed.blobRef) {
      log("info", `using grabbed snapshot blob ${grabbed.id} from GitHub Releases`);
      const { getSnapshot } = await import("./clients/snapshotStore.ts");
      return getSnapshot(grabbed.blobRef);
    }
  } else if (grabbed?.gridfsId) {
    log("info", `using grabbed snapshot blob ${grabbed.id} from GridFS (legacy)`);
    const { openBackupBlob } = await import("./gridfs.ts");
    return openBackupBlob(grabbed.gridfsId);
  }
  log("info", `streaming snapshot ${backupSnapshotId} live from ${backupDeployment}`);
  const backups = makeConvexBackupsClient();
  return backups.downloadSnapshot(backupDeployment, backupSnapshotId);
}

export async function executeProvision(opts: ExecOpts): Promise<ExecOutcome> {
  const logger = makeLogger(opts.onLog);
  const olog = logger.for("orchestrator");
  const dims = new Set<JobDimension>(opts.dimensions.length ? opts.dimensions : ["code", "data", "clerk"]);

  const vercel = makeVercelClient({ log: logger.for("vercel"), dryRun: opts.dryRun });
  const convex = makeConvexDeployClient({ log: logger.for("convex"), dryRun: opts.dryRun });

  const isFresh = opts.target.createdByTool || !opts.target.convexDeployment || opts.target.convexDeployment === "fresh";
  const existingName = isFresh ? undefined : opts.target.convexDeployment;

  const out: ExecOutcome = {
    ok: false,
    steps: [],
    createdByTool: isFresh,
    convexDeployment: existingName,
    lastImportedSnapshotId: opts.target.lastImportedSnapshotId,
    masked: false,
  };
  let creds: DeploymentCreds | undefined;

  olog("info", `provision start: instance=${opts.instanceName} branch=${opts.branch} mode=${isFresh ? "FRESH" : "EXISTING"} dims=[${[...dims].join(",")}] dryRun=${!!opts.dryRun}`);

  const steps: SagaStep[] = [];

  // 1) PREFLIGHT — the hard safety gate.
  steps.push({
    name: "preflight",
    run: async () => {
      // Vercel-project safety — enforced on BOTH fresh and existing paths (the
      // fresh path used to skip every gate). Never build/deploy against the real
      // production Vercel project; shared projects are danger-gated.
      if (opts.target.vercelProject) {
        const vp = opts.target.vercelProject.toLowerCase();
        if (PROD_VERCEL_PROJECTS.has(vp)) {
          throw new Error(`refusing to deploy to the PRODUCTION Vercel project "${opts.target.vercelProject}"`);
        }
        if (SHARED_VERCEL_PROJECTS.has(vp) && !opts.dangerAck) {
          throw new Error(`Vercel project "${opts.target.vercelProject}" is shared; deploying to it requires dangerAck=true`);
        }
      }
      if (existingName === PROD_CONVEX_DEPLOYMENT) {
        throw new Error(`refusing to write the PRODUCTION deployment ${PROD_CONVEX_DEPLOYMENT} — read-only source only`);
      }
      if (existingName) {
        const label = SHARED_DEPLOYMENTS[existingName];
        if (label) olog("warn", `⚠ DANGER: target ${existingName} is the SHARED "${label}" deployment — this will OVERWRITE its data/code`);
        // Strong confirmation: overwriting a pre-existing deployment requires an
        // explicit ack (capability is supported; the ack is the guardrail).
        if (!opts.dangerAck) {
          throw new Error(`target ${existingName} is a pre-existing deployment; re-provisioning it requires dangerAck=true (explicit overwrite confirmation)`);
        }
        return { detail: `EXISTING target ${existingName}${label ? ` (${label})` : ""}, overwrite acknowledged` };
      }
      return { detail: `FRESH provision — a new isolated Convex + Vercel deployment will be created` };
    },
  });

  // 2) RESOLVE/PROVISION the Convex deployment (fresh claim or existing authorize).
  //    Only needed when we touch code (wiring) or data (import).
  if (dims.has("code") || dims.has("data")) {
    steps.push({
      name: "provision-convex",
      run: async () => {
        if (isFresh) {
          creds = await convex.provisionPreviewDeployment(previewNameFor(opts.instanceName));
        } else {
          creds = await convex.authorizeExisting(existingName!);
        }
        out.convexDeployment = creds.deploymentName;
        out.convexUrl = creds.url;
        // Best-effort email kill-switch preflight on an EXISTING target: never
        // overwrite a deployment that could send real email (prod-marked env).
        if (!isFresh) {
          const flag = await convex.getEnv({ creds, key: "ALLOW_OUTBOUND_EMAIL" });
          if (flag === "true") throw new Error("ALLOW_OUTBOUND_EMAIL=true on target — that marks a production deployment; refusing to overwrite");
        }
        return { detail: `${isFresh ? "provisioned" : "authorized"} ${creds.deploymentName} (${creds.url})` };
      },
    });
  }

  // 3) DEPLOY CODE (dimension: code) — wire the fresh Convex URL, then deploy the
  //    branch via the Vercel REST API (already HTTP).
  if (dims.has("code") && opts.target.vercelProject) {
    const project = opts.target.vercelProject;
    steps.push({
      name: "deploy-code",
      run: async () => {
        if (creds?.url) {
          await vercel.setEnv({ project, key: "NEXT_PUBLIC_CONVEX_URL", value: creds.url, target: ["preview"] });
          // repair-B: ship the BACKEND, not just the frontend. The Vercel build alone
          // never deployed the Convex functions, so a branch change never reached an
          // instance's backend (a whole class of change — schema, actions, http routes —
          // silently no-op'd). Wrap the build in `convex deploy` (self-hosted push via
          // the admin key we just claimed) so functions + schema deploy first, then the
          // Next build runs against the fresh URL.
          if (creds.adminKey) {
            await vercel.setEnv({ project, key: "CONVEX_SELF_HOSTED_URL", value: creds.url, target: ["preview"] });
            await vercel.setEnv({ project, key: "CONVEX_SELF_HOSTED_ADMIN_KEY", value: creds.adminKey, target: ["preview"] });
            await vercel.setBuildCommand({ project, command: "npx convex deploy -y --cmd 'next build --turbopack'" });
          }
        }
        const dep = await vercel.createDeployment({ project, branch: opts.branch });
        out.url = dep.url;
        out.vercelDeploymentId = dep.id;
        return {
          detail: `deployed ${dep.id} (${dep.url})`,
          // Only tear down previews WE created on failure — never a shared one.
          compensate: isFresh && opts.target.kind === "preview" ? async () => vercel.deleteDeployment(dep.id) : undefined,
        };
      },
    });
  }

  // 4) IMPORT DATA (dimension: data) — the confirmed all-HTTP chunked import of
  //    the chosen backup snapshot into the target deployment. Idempotent.
  if (dims.has("data") && opts.data) {
    const data = opts.data;
    steps.push({
      name: "import-data",
      run: async () => {
        if (!creds) throw new Error("no Convex deployment resolved for import");
        if (opts.target.lastImportedSnapshotId === data.backupSnapshotId && opts.target.createdByTool) {
          return { skipped: true, detail: `snapshot unchanged (${data.backupSnapshotId})` };
        }
        if (opts.dryRun) {
          // No download / no import in a dry-run — just record the intent.
          logger.for("convex")("info", `[dry-run] would import ${data.backupSnapshotId} from ${data.backupDeployment} into ${creds.deploymentName}`);
          out.lastImportedSnapshotId = data.backupSnapshotId;
          return { detail: `[dry-run] import ${data.backupSnapshotId}` };
        }
        let source = await openSnapshotSource(data.backupDeployment, data.backupSnapshotId, logger.for("convex"));
        // Safe-by-default: honor `scrubPII` as "mask PII", but FORCE masking on
        // whenever the snapshot is sourced from prod / staging-prod — a
        // break-glass-gated test env must never receive raw prod identity PII.
        const forced = isProdDataSource(data.backupDeployment);
        const maskOn = opts.scrubPII || forced;
        if (forced && !opts.scrubPII) {
          olog("warn", `masking FORCED on: snapshot source ${data.backupDeployment} is production/staging-prod data`);
        }
        // Masking requires the on-disk unzip/mask/re-zip path; the worker has a
        // filesystem. Streamed live-import (dry-run) skips it — logged.
        if (maskOn && !opts.dryRun) {
          source = await maskSnapshotStream(source, data.backupSnapshotId, logger.for("orchestrator"));
          out.masked = true;
        }
        await convex.importSnapshotStream({ creds, source, replaceAll: true });
        out.lastImportedSnapshotId = data.backupSnapshotId;
        return { detail: `imported ${data.backupSnapshotId} from ${data.backupDeployment}${out.masked ? " (PII-masked)" : ""}` };
      },
    });

    // 5) RESET AUTH IDS — imported prod authIds carry prod's Clerk issuer and can
    //    never match this instance; rewrite to pending:<email>. Best-effort over
    //    HTTP (the worker may re-run via CLI); a failure is surfaced, not fatal.
    steps.push({
      name: "reset-auth",
      run: async () => {
        if (out.lastImportedSnapshotId !== data.backupSnapshotId) return { skipped: true, detail: "no import this run" };
        const r = await convex.runMutation({ creds: creds!, path: "migrations:resetAuthIdsForClonedDeployment", args: { confirm: true } });
        if (!r.ok) olog("warn", `resetAuthIds not applied over HTTP (${r.detail ?? "?"}) — run manually if needed`);
        return { detail: r.ok ? "authIds reset to pending:<email>" : `deferred (${r.detail ?? "?"})` };
      },
    });

    // 6) FORWARD MIGRATIONS (default on, togglable). Best-effort per migration.
    if (opts.migrations) {
      steps.push({
        name: "migrations",
        run: async () => {
          if (out.lastImportedSnapshotId !== data.backupSnapshotId) return { skipped: true, detail: "no import this run" };
          let ran = 0;
          for (const name of DEFAULT_FORWARD_MIGRATIONS) {
            const r = await convex.runMutation({ creds: creds!, path: name });
            if (r.ok) ran += 1;
            else olog("warn", `migration ${name} not applied over HTTP (${r.detail ?? "?"})`);
          }
          return { detail: `applied ${ran}/${DEFAULT_FORWARD_MIGRATIONS.length} forward migrations; excluded prod-only: ${Object.keys(EXCLUDED_MIGRATIONS).join(", ")}` };
        },
      });
    }
  }

  // 7) CLERK (dimension: clerk) — v1 is "select an existing configured Clerk
  //    instance"; the selection is recorded on the instance by the runner.
  //    Auth-strategy TOGGLES need the Clerk dashboard/Playwright and are a
  //    worker follow-up step (see scripts/worker.ts) — logged here, not applied.
  if (dims.has("clerk")) {
    steps.push({
      name: "clerk-select",
      run: async () => {
        olog("info", `clerk instance selected: ${opts.clerkInstance ?? "(none)"} — config toggles are a Playwright worker follow-up, not applied here`);
        return { detail: `selected ${opts.clerkInstance ?? "(none)"}` };
      },
    });
  }

  // 8) VERIFY — summary line for the consolidated log.
  steps.push({
    name: "verify",
    run: async () => ({ detail: `instance=${opts.instanceName} url=${out.url ?? "(no code deploy)"} convex=${out.convexDeployment ?? "(none)"}` }),
  });

  const outcome = await runSaga(steps, olog);
  out.ok = outcome.ok;
  out.steps = outcome.steps;
  olog(outcome.ok ? "info" : "error", `provision ${outcome.ok ? "succeeded" : "FAILED (unwound)"}: instance=${opts.instanceName}`);
  return out;
}

// ── TEARDOWN ────────────────────────────────────────────────────────────────
// Reclaim, as a unit, every resource the tool created for an instance: its
// Convex preview deployment, its Vercel deployment/project, per-instance Clerk
// state (Mongo records), and — never — anything prod or not tool-created.

export type ExecTeardownOpts = {
  instanceId: string;
  instanceName: string;
  /** Only a tool-created instance may be torn down. */
  createdByTool?: boolean;
  convexDeployment?: string; // the deployment we provisioned (createdConvexDeployment)
  vercelProject?: string;
  vercelDeploymentId?: string;
  dryRun?: boolean;
  onLog: (e: LogEvent) => void;
};

export type TeardownOutcome = {
  ok: boolean;
  steps: StepResult[];
  reclaimed: string[];
};

// Vercel-project safety sets — GENERIC + env-configurable (no org hardcoded). A
// comma-separated env list extends each set; values are lowercased. Kept as small
// helpers so the preflight (deploy) guard and the teardown guard read the same sets.
function envProjectSet(envKey: string, baked: string[]): Set<string> {
  const extra = (process.env[envKey] || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...baked, ...extra]);
}

// Projects that are a HARD production write/teardown block (never ackable).
// Extend via FLOTILLA_PROD_VERCEL_PROJECTS.
export const PROD_VERCEL_PROJECTS: Set<string> = envProjectSet("FLOTILLA_PROD_VERCEL_PROJECTS", ["production"]);

// Shared projects — deploys need dangerAck; teardown is blocked. Extend via
// FLOTILLA_SHARED_VERCEL_PROJECTS.
export const SHARED_VERCEL_PROJECTS: Set<string> = envProjectSet(
  "FLOTILLA_SHARED_VERCEL_PROJECTS",
  ["staging", "workspace", "website"],
);

// Vercel projects that must NEVER be deleted by a teardown (shared / prod) — the
// union of both guarded sets. Exported so the read-only Config surface can display
// the guarded set without duplicating (and risking drift from) the guards.
export const PROTECTED_VERCEL_PROJECTS = new Set<string>([
  ...PROD_VERCEL_PROJECTS,
  ...SHARED_VERCEL_PROJECTS,
]);

export async function executeTeardown(opts: ExecTeardownOpts): Promise<TeardownOutcome> {
  const logger = makeLogger(opts.onLog);
  const olog = logger.for("orchestrator");
  const vercel = makeVercelClient({ log: logger.for("vercel"), dryRun: opts.dryRun });
  const convex = makeConvexDeployClient({ log: logger.for("convex"), dryRun: opts.dryRun });
  const reclaimed: string[] = [];

  olog("info", `teardown start: instance=${opts.instanceName} (${opts.instanceId}) dryRun=${!!opts.dryRun}`);

  const steps: SagaStep[] = [];

  // 1) PREFLIGHT — the same hard guards as provision, inverted for delete.
  steps.push({
    name: "preflight",
    run: async () => {
      if (!opts.createdByTool) {
        throw new Error("refusing to tear down an instance the tool did not create (createdByTool=false)");
      }
      const dep = opts.convexDeployment;
      if (dep === PROD_CONVEX_DEPLOYMENT) {
        throw new Error(`refusing to tear down the PRODUCTION deployment ${PROD_CONVEX_DEPLOYMENT}`);
      }
      if (dep && SHARED_DEPLOYMENTS[dep]) {
        throw new Error(`refusing to tear down shared "${SHARED_DEPLOYMENTS[dep]}" deployment ${dep}`);
      }
      if (opts.vercelProject && PROTECTED_VERCEL_PROJECTS.has(opts.vercelProject.toLowerCase())) {
        throw new Error(`refusing to tear down the shared/prod Vercel project "${opts.vercelProject}"`);
      }
      return { detail: `tool-created instance, no prod/shared resources targeted` };
    },
  });

  // 2) VERCEL — delete the deployment, then the per-instance project (best-effort).
  steps.push({
    name: "teardown-vercel",
    run: async () => {
      const done: string[] = [];
      if (opts.vercelDeploymentId) {
        try { await vercel.deleteDeployment(opts.vercelDeploymentId); reclaimed.push(`vercel-deployment:${opts.vercelDeploymentId}`); done.push("deployment"); }
        catch (e) { olog("warn", `vercel deployment delete failed: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (opts.vercelProject && !PROTECTED_VERCEL_PROJECTS.has(opts.vercelProject.toLowerCase())) {
        try { await vercel.deleteProject(opts.vercelProject); reclaimed.push(`vercel-project:${opts.vercelProject}`); done.push("project"); }
        catch (e) { olog("warn", `vercel project delete failed: ${e instanceof Error ? e.message : String(e)}`); }
      }
      return { detail: done.length ? `reclaimed vercel ${done.join("+")}` : "no vercel resources" };
    },
  });

  // 3) CONVEX — delete the tool-provisioned preview deployment (best-effort).
  steps.push({
    name: "teardown-convex",
    run: async () => {
      if (!opts.convexDeployment) return { skipped: true, detail: "no convex deployment recorded" };
      const r = await convex.deletePreviewDeployment(opts.convexDeployment);
      if (r.ok) reclaimed.push(`convex:${opts.convexDeployment}`);
      return { detail: r.ok ? `deleted convex ${opts.convexDeployment}` : `convex delete deferred (${r.detail ?? "?"}) — auto-expires` };
    },
  });

  // 4) CLERK / MONGO — clear per-instance Clerk config + managed-user records.
  steps.push({
    name: "teardown-clerk-records",
    run: async () => {
      if (opts.dryRun) return { detail: "[dry-run] would clear per-instance Clerk/managed-user records" };
      const { deleteInstanceClerkRecords } = await import("./models/index.ts");
      const n = await deleteInstanceClerkRecords(opts.instanceId);
      if (n > 0) reclaimed.push(`clerk-records:${n}`);
      return { detail: `cleared ${n} per-instance Clerk/managed-user record(s)` };
    },
  });

  const outcome = await runSaga(steps, olog);
  olog(outcome.ok ? "info" : "error", `teardown ${outcome.ok ? "succeeded" : "FAILED"}: instance=${opts.instanceName} reclaimed=[${reclaimed.join(", ")}]`);
  return { ok: outcome.ok, steps: outcome.steps, reclaimed };
}

// Download-to-disk PII MASK: unzip → mask (lib/mask.ts, deterministic +
// number-encoding-preserving) → re-zip → return a file stream. Only used in the
// worker (needs a filesystem + unzip/zip). Dynamic imports keep child_process/fs
// (and the optional copycat dep) out of the serverless API bundle.
async function maskSnapshotStream(
  source: Readable,
  snapshotId: string,
  log: ScopedLogger,
): Promise<Readable> {
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const { execCapture } = await import("./clients/exec.ts");
  const { maskExportDir, scanResidualEmails } = await import("./mask.ts");

  const base = path.join(os.tmpdir(), `flotilla-mask-${snapshotId.replace(/[^a-zA-Z0-9]/g, "")}-${Date.now()}`);
  const zipIn = `${base}.zip`;
  const work = `${base}.work`;
  const maskedDir = `${base}.masked`;
  const zipOut = `${base}.masked.zip`;

  log("info", `masking PII: buffering snapshot to ${zipIn}`);
  await new Promise<void>((resolve, reject) => {
    const w = fs.createWriteStream(zipIn);
    source.pipe(w).on("finish", () => resolve()).on("error", reject);
  });
  // No shell: execFile with array args + `--` so a path is never parsed as a flag.
  await execCapture("unzip", ["-o", "--", zipIn, "-d", work], { log });
  maskExportDir(work, maskedDir, { log });
  // Best-effort residual-real-email scan on the identity fields (warn, not fatal:
  // the import must proceed; copycat uses realistic domains that this won't flag).
  const residual = scanResidualEmails(maskedDir);
  if (residual.count > 0) {
    log("warn", `residual-email scan flagged ${residual.count} field(s): ${residual.samples.slice(0, 3).join("; ")}`);
  }
  await execCapture("zip", ["-qr", zipOut, "."], { log, cwd: maskedDir });
  log("info", `mask complete → ${zipOut}`);
  return fs.createReadStream(zipOut);
}
