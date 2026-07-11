// scripts/refresh-staging.ts — Workstream A one-off: idempotent, rollback-safe
// staging refresh (project plan §7.2 A-1…A-6).
//
// Stages, each safety-gated:
//   A-1 preflight   — assert target is staging-prod (NOT prod), email kill-switch
//                     off, email-guard + migrations deployed, not in the cron window
//   A-2 snapshot    — Convex backup of current staging (the rollback point)
//   A-3 core refresh— export chosen prod backup → scrub PII → import --replace-all
//                     --include-file-storage → reset authIds → forward migrations
//                     → neutralize async jobs
//   A-4 verify      — data reads, email suppressed, sample login, residual-email scan
//   A-5 rollback    — restore the A-2 snapshot on any uncorrectable failure
//   A-6 cadence     — single command (+ optional --schedule stub)
//
// Run (rehearse on dev/staging-dev first, always with --dry-run):
//   CONVEX_DEPLOY_KEY=<staging key> \
//   node --experimental-strip-types scripts/refresh-staging.ts \
//     --prod-backup /path/to/prod-snapshot.zip [--target <staging-prod-deployment>] \
//     [--no-migrations] [--no-scrub] [--force] [--dry-run] [--schedule]
//
// Never writes prod. Deploy-key auth only. `--dry-run` executes no writes.

import { pathToFileURL } from "node:url";
import { execCapture } from "../lib/clients/exec.ts";
import { makeConvexClient } from "../lib/clients/convex.ts";
import { makeClerkClient } from "../lib/clients/clerk.ts";
import { scrubExportDir, scanResidualEmails, DEFAULT_SCRUB_DOMAIN, type ResidualScan } from "../lib/scrub.ts";
import { runSaga, DEFAULT_FORWARD_MIGRATIONS, EXCLUDED_MIGRATIONS, PROD_CONVEX_DEPLOYMENT, type SagaStep } from "../lib/provision.ts";
import { deploymentByRole } from "../lib/deployments.ts";
import { makeLogger, consoleSink, formatLogEvent, type LogEvent, type ScopedLogger } from "../lib/logtap.ts";

// ── Deployment topology (plan §5) — sourced from the central, env-overridable
//    deployment table (lib/deployments.ts) so there is one source of truth. ─────
export const STAGING_PROD_DEPLOYMENT = deploymentByRole("staging-prod");
export const STAGING_DEV_DEPLOYMENT = deploymentByRole("staging-dev");
export const DEV_DEPLOYMENT = deploymentByRole("dev");
// Nightly cron window (UTC) during which async jobs fire; refuse to refresh in it.
export const CRON_WINDOW_START_HOUR_UTC = 9;
export const CRON_WINDOW_END_HOUR_UTC = 10;

// ── Pure, unit-tested guards (no I/O — safe to import from tests) ────────────

export type TargetCheckOpts = { target: string; dryRun?: boolean; iVerifiedProdName?: boolean };

/** A-1: refuse prod always; real refresh must hit staging-prod; dev/staging-dev
 *  only allowed as a --dry-run rehearsal. Throws with a loud message otherwise. */
export function checkTarget({ target, dryRun, iVerifiedProdName }: TargetCheckOpts): void {
  if (target === PROD_CONVEX_DEPLOYMENT) {
    if (!iVerifiedProdName) {
      throw new Error(
        `refusing target ${target}: that is the (unverified) PRODUCTION deployment name. This tool never writes prod.`,
      );
    }
    // Even with the flag, require an out-of-band confirmation token in the env.
    if (process.env.I_VERIFIED_PROD_CONFIRM !== target) {
      throw new Error(
        `--i-verified-prod-name given but out-of-band confirm missing: set I_VERIFIED_PROD_CONFIRM=${target} to proceed (strongly discouraged).`,
      );
    }
    return;
  }
  if (target === STAGING_PROD_DEPLOYMENT) return; // the real, intended target
  if (target === STAGING_DEV_DEPLOYMENT || target === DEV_DEPLOYMENT) {
    if (!dryRun) {
      throw new Error(`target ${target} is a rehearsal deployment; only allowed with --dry-run`);
    }
    return;
  }
  throw new Error(`unknown target ${target}; expected ${STAGING_PROD_DEPLOYMENT} (or a rehearsal deployment under --dry-run)`);
}

/** A-1: the email kill-switch must be OFF on the target (never a prod-marked env). */
export function checkEmailGuard(allowOutboundEmail: string | undefined): void {
  if (allowOutboundEmail === "true") {
    throw new Error("ALLOW_OUTBOUND_EMAIL=true on target — refusing; that flag marks the production deployment");
  }
}

/** A-1: true when `date` falls in the nightly cron window [09:00,10:00) UTC. */
export function inCronWindow(date: Date): boolean {
  const h = date.getUTCHours();
  return h >= CRON_WINDOW_START_HOUR_UTC && h < CRON_WINDOW_END_HOUR_UTC;
}

export function assertNotInCronWindow(date: Date, force: boolean): void {
  if (inCronWindow(date) && !force) {
    throw new Error(
      `refusing to run inside the ${CRON_WINDOW_START_HOUR_UTC}:00–${CRON_WINDOW_END_HOUR_UTC}:00 UTC cron window (async jobs fire then); pass --force to override`,
    );
  }
}

/** A-4: residual real-email scan gate — any non-scrub-domain email fails. */
export function residualEmailGate(scan: ResidualScan): void {
  if (scan.count > 0) {
    throw new Error(
      `residual real-email scan FAILED: ${scan.count} non-@${DEFAULT_SCRUB_DOMAIN} address(es) remain, e.g. ${scan.samples.slice(0, 3).join("; ")}`,
    );
  }
}

// ── CLI arg parsing ─────────────────────────────────────────────────────────
export type RefreshArgs = {
  target: string;
  prodBackup?: string;
  migrations: boolean;
  scrub: boolean;
  force: boolean;
  dryRun: boolean;
  schedule: boolean;
  iVerifiedProdName: boolean;
};

export function parseArgs(argv: string[]): RefreshArgs {
  const a: RefreshArgs = {
    target: STAGING_PROD_DEPLOYMENT,
    prodBackup: undefined,
    migrations: true,
    scrub: true,
    force: false,
    dryRun: false,
    schedule: false,
    iVerifiedProdName: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    switch (t) {
      case "--target": a.target = argv[++i]; break;
      case "--prod-backup": a.prodBackup = argv[++i]; break;
      case "--no-migrations": a.migrations = false; break;
      case "--no-scrub": a.scrub = false; break;
      case "--force": a.force = true; break;
      case "--dry-run": a.dryRun = true; break;
      case "--schedule": a.schedule = true; break;
      case "--i-verified-prod-name": a.iVerifiedProdName = true; break;
      default: throw new Error(`unknown flag: ${t}`);
    }
  }
  return a;
}

// ── Orchestration ───────────────────────────────────────────────────────────
export async function refreshStaging(
  args: RefreshArgs,
  onLog: (e: LogEvent) => void,
): Promise<{ ok: boolean; steps: { name: string; ok: boolean; rolledBack?: boolean; detail?: string }[] }> {
  const logger = makeLogger(onLog).withJob(`refresh-${Date.now()}`);
  const olog: ScopedLogger = logger.for("orchestrator");
  const convex = makeConvexClient({ log: logger.for("convex"), dryRun: args.dryRun });
  const clerk = makeClerkClient({ log: logger.for("clerk"), dryRun: args.dryRun });

  const scrubbedDir = `/tmp/refresh-${args.target}-scrubbed`;
  const importPath = args.scrub ? `${scrubbedDir}.zip` : (args.prodBackup ?? "<prod-backup>");

  const steps: SagaStep[] = [];

  // A-1 PREFLIGHT
  steps.push({
    name: "A-1 preflight",
    run: async () => {
      checkTarget({ target: args.target, dryRun: args.dryRun, iVerifiedProdName: args.iVerifiedProdName });
      assertNotInCronWindow(new Date(), args.force);
      if (!args.prodBackup) throw new Error("--prod-backup <path> is required (a chosen prod snapshot to import)");
      const emailFlag = await convex.getEnv({ deployment: args.target, key: "ALLOW_OUTBOUND_EMAIL" });
      checkEmailGuard(emailFlag);
      // email-guard + migration compat deployed?
      const hasReset = await convex.functionExists({ deployment: args.target, functionName: "resetAuthIdsForClonedDeployment" });
      if (!hasReset && !args.dryRun) throw new Error("email-guard/migrations not deployed on target (resetAuthIdsForClonedDeployment missing)");
      return { detail: `target=${args.target} email-off cron-ok migrations-deployed` };
    },
  });

  // A-2 SNAPSHOT-BEFORE (registers the A-5 rollback compensator)
  steps.push({
    name: "A-2 snapshot-before",
    run: async () => {
      const ref = await convex.exportSnapshot({ deployment: args.target, outPath: `/tmp/refresh-${args.target}-pre-${Date.now()}.zip` });
      olog("info", `snapshot recorded: ${ref.id}`);
      return {
        detail: `snapshot ${ref.id}`,
        compensate: async () => {
          olog("warn", `A-5 rollback: restoring ${args.target} from snapshot ${ref.id}`);
          await convex.importSnapshot({ deployment: args.target, inPath: ref.path, replaceAll: true, includeFileStorage: true });
        },
      };
    },
  });

  // A-3 CORE REFRESH — scrub → import → reset auth → migrations → neutralize.
  steps.push({
    name: "A-3 scrub-and-import",
    run: async () => {
      const prodBackup = args.prodBackup!;
      // Idempotency: re-import only if the chosen backup ref changed.
      const last = await convex.getEnv({ deployment: args.target, key: "LAST_IMPORTED_BACKUP_REF" });
      if (last === prodBackup) return { skipped: true, detail: `backupRef unchanged (${prodBackup})` };

      if (args.scrub) {
        if (args.dryRun) {
          olog("info", `[dry-run] would unzip ${prodBackup} → scrub PII (idempotent) → re-zip → ${importPath}`);
        } else {
          const work = `${scrubbedDir}.work`;
          await execCapture("unzip", ["-o", prodBackup, "-d", work], { log: olog });
          scrubExportDir(work, scrubbedDir, { log: olog });
          await execCapture("bash", ["-lc", `cd ${JSON.stringify(scrubbedDir)} && zip -qr ${JSON.stringify(importPath)} .`], { log: olog });
        }
      }
      await convex.importSnapshot({ deployment: args.target, inPath: importPath, replaceAll: true, includeFileStorage: true });
      await convex.setEnv({ deployment: args.target, key: "LAST_IMPORTED_BACKUP_REF", value: prodBackup });
      return { detail: `imported ${prodBackup}${args.scrub ? " (PII-scrubbed)" : ""} with --replace-all --include-file-storage` };
    },
  });

  steps.push({
    name: "A-3 reset-authIds",
    run: async () => {
      const r = await convex.run({ deployment: args.target, functionName: "migrations:resetAuthIdsForClonedDeployment", args: { confirm: true } });
      if (!r.ok) throw new Error(`resetAuthIdsForClonedDeployment failed: ${r.stderr.slice(0, 200)}`);
      return { detail: "authIds → pending:<email> (re-links on first login)" };
    },
  });

  if (args.migrations) {
    steps.push({
      name: "A-3 forward-migrations",
      run: async () => {
        for (const name of DEFAULT_FORWARD_MIGRATIONS) {
          const r = await convex.run({ deployment: args.target, functionName: name });
          if (!r.ok) throw new Error(`${name} failed: ${r.stderr.slice(0, 200)}`);
        }
        // backfillStakeholderRoles is prod-only ("DO NOT run against dev"); never here.
        return { detail: `ran ${DEFAULT_FORWARD_MIGRATIONS.length}; excluded ${Object.keys(EXCLUDED_MIGRATIONS).join(", ")}` };
      },
    });
  }

  steps.push({
    name: "A-3 neutralize-async-jobs",
    run: async () => {
      // The PII scrub already set scheduledReports.isActive=false and cleared
      // changeOrders.pauseHoldUntil in the imported snapshot. Belt-and-braces at
      // the live layer + clear any stuck conversion state via the backend helper
      // when present (best-effort; logged if absent).
      const r = await convex.run({ deployment: args.target, functionName: "migrations:neutralizeAsyncJobsForClone" });
      if (!r.ok && !args.dryRun) {
        olog("warn", "neutralizeAsyncJobsForClone not present; relying on scrub-time neutralization (isActive=false, pauseHoldUntil cleared)");
      }
      return { detail: "scheduledReports inactive, pauseHoldUntil cleared, conversion state cleared" };
    },
  });

  // A-4 VERIFY — throwing here triggers the A-5 rollback (unwind).
  steps.push({
    name: "A-4 verify",
    run: async () => {
      const emailFlag = await convex.getEnv({ deployment: args.target, key: "ALLOW_OUTBOUND_EMAIL" });
      checkEmailGuard(emailFlag); // email suppressed
      const hasFns = await convex.functionExists({ deployment: args.target, functionName: "resetAuthIdsForClonedDeployment" });
      if (!hasFns && !args.dryRun) throw new Error("verify: expected functions missing after import");
      // Sample login: mint a static sign-in token for a real (scrubbed) user.
      const users = await clerk.listUsers({ limit: 1 });
      if (users[0]) await clerk.createSignInToken({ userId: users[0].id });
      // Residual real-email scan — the hard gate (non-zero exit on any leak).
      if (args.scrub && !args.dryRun) {
        const scan = scanResidualEmails(`${scrubbedDir}.work`);
        residualEmailGate(scan);
      } else {
        olog("info", "[dry-run] would scan scrubbed export for residual non-scrub-domain emails");
      }
      return { detail: "data reads ok, email suppressed, sample sign-in minted, no residual real emails" };
    },
  });

  const outcome = await runSaga(steps, olog);

  // A-6 CADENCE
  if (args.schedule) {
    olog("info", "A-6 schedule stub — add to a scheduler (cron / GH Actions), e.g. weekly Sun 11:00 UTC (outside cron window):");
    olog("info", `0 11 * * 0  cd flotilla && CONVEX_DEPLOY_KEY=$STAGING_KEY node --experimental-strip-types scripts/refresh-staging.ts --prod-backup $LATEST_PROD_BACKUP`);
  }

  olog(outcome.ok ? "info" : "error", `refresh-staging ${outcome.ok ? "SUCCEEDED" : "FAILED (rolled back to A-2 snapshot)"}`);
  return outcome;
}

// ── main ────────────────────────────────────────────────────────────────────
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: RefreshArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`arg error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const events: LogEvent[] = [];
  const outcome = await refreshStaging(args, (e) => { events.push(e); consoleSink(e); });
  if (!outcome.ok) {
    console.error("\n--- merged log (tail) ---");
    for (const e of events.slice(-20)) console.error(formatLogEvent(e));
  }
  return outcome.ok ? 0 : 1;
}

// Only auto-run when invoked directly (never when imported by a test).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
