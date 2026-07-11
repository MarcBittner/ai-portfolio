import { z } from "zod";
import { withOperator, ok, safeRead, cachedRead } from "@/lib/api";
import { listInstances, appendLog, recordAudit, getConfigValues } from "@/lib/models";
import { enqueueProvision } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/instances — list all managed instances (B-2). Optional ownership
// filters (Track D): `?owner=<email>` and/or `?team=<label>` scope the fleet to one
// owner/team; omitting both lists everything (unchanged default behavior).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const owner = url.searchParams.get("owner") ?? undefined;
  const team = url.searchParams.get("team") ?? undefined;
  return withOperator(() =>
    // cachedRead (post-RBAC): ETag + If-None-Match → 304 + browser-private
    // Cache-Control on the successful list; the safeRead degraded fallback stays
    // uncached. The ETag naturally covers the owner/team filter because it hashes
    // the exact (filtered) body, so a different filter yields a different tag.
    safeRead("instances unavailable", { instances: [] }, async () =>
      cachedRead({ instances: await listInstances({ owner, team }) }),
    ),
  );
}

// POST /api/instances — create + provision. ASYNC: enqueues a job and returns
// {jobId, instanceId} immediately; the worker (scripts/worker.ts) executes it.
//
// Body: {name?, kind, branch, convexDeployment?, backupSnapshotId?,
//        backupDeployment?, clerkInstance?, migrations, scrubPII, dangerAck?}
//   • convexDeployment omitted / "fresh" => provision a NEW isolated deployment.
//   • backupSnapshotId + backupDeployment => the read-only data SOURCE to load.
//   • overwriting a pre-existing deployment requires dangerAck=true.
const CreateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  kind: z.enum(["preview", "staging"]).default("preview"),
  branch: z.string().min(1).max(200),
  convexDeployment: z.string().max(120).optional(),
  backupSnapshotId: z.string().max(200).optional(),
  backupDeployment: z.string().max(120).optional(),
  clerkInstance: z.string().max(120).optional(),
  vercelProject: z.string().max(120).optional(),
  // Left OPTIONAL (no zod default) so an OMITTED field can fall back to the stored
  // Config defaults below; an explicit request value always wins.
  migrations: z.boolean().optional(),
  scrubPII: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  dangerAck: z.boolean().optional(),
  // Optional TTL (hours) + owner override. No TTL => never auto-expires.
  ttlHours: z.number().positive().max(24 * 30).optional(),
  owner: z.string().max(200).optional(),
  // Ownership registry (Track D) — provision ON BEHALF OF someone else. Any owner
  // field supplied here wins over the acting-principal default below; omitting them
  // attributes the instance to the caller. `team` is a free label for fleet grouping.
  ownerUserId: z.string().max(200).optional(),
  ownerEmail: z.string().max(320).optional(),
  ownerName: z.string().max(200).optional(),
  team: z.string().max(120).optional(),
  idempotencyKey: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  return withOperator(async (principal) => {
    const body = CreateBody.parse(await req.json());
    // Fall back to the stored Config defaults for any field the request omitted,
    // so changing a default in /app/config actually changes new launches. An
    // explicit request value always wins over config. (getConfigValues is
    // resilient — it degrades to env/hardcoded defaults if the store is down, so
    // this never breaks the create flow.)
    const cfg = await getConfigValues();
    const migrations = body.migrations ?? cfg.migrationsByDefault;
    const scrubPII = body.scrubPII ?? cfg.maskByDefault;
    const ttlHours = body.ttlHours ?? cfg.defaultTtlHours ?? undefined;
    // Attribute ownership to the caller unless an explicit owner was passed.
    // Ownership registry (Track D): stamp the structured owner from the resolved
    // principal (the acting operator) by default, but never overwrite an explicit
    // owner supplied in the request body (provision-on-behalf-of). ownerEmail /
    // ownerUserId both fall back to principal.id (the verified Clerk / break-glass
    // email is the stable owner key); the legacy free-text `owner` stays in step.
    const ownerEmail = body.ownerEmail ?? body.owner ?? principal.id;
    const ownerUserId = body.ownerUserId ?? principal.id;
    const { jobId, instanceId } = await enqueueProvision({
      ...body,
      migrations,
      scrubPII,
      ttlHours,
      owner: body.owner ?? ownerEmail,
      ownerEmail,
      ownerUserId,
      ownerName: body.ownerName,
      team: body.team,
    });
    const detail = `branch=${body.branch}, target=${body.convexDeployment ?? "fresh"}${ttlHours ? `, ttl=${ttlHours}h` : ""}${body.dangerAck ? ", dangerAck" : ""}`;
    // Accounting: attribute the launch to the authenticated operator (who + what).
    await appendLog({
      source: "orchestrator",
      level: "info",
      ts: Date.now(),
      msg: `AUDIT: operator ${principal.id} launched "${body.name ?? body.kind}" (${detail})`,
      jobId,
      instanceId,
    }).catch(() => {});
    await recordAudit(principal.id, "instance.launch", instanceId, `"${body.name ?? body.kind}" ${detail}`).catch(() => {});
    return ok({ jobId, instanceId });
  }, "write");
}
