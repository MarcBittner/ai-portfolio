import { withOperator, ok, bad, safeRead } from "@/lib/api";
import { listBackups, registerBackup, deleteBackup, getBackup, recordAudit } from "@/lib/models";
import { deleteBackupBlob } from "@/lib/gridfs";
import { putSnapshot, deleteSnapshot, snapshotStoreConfigured } from "@/lib/clients/snapshotStore";
import { makeConvexBackupsClient } from "@/lib/clients/convexBackups";
import {
  readBackups,
  bustCloudBackupsCache,
  KNOWN_DEPLOYMENTS,
  __resetBackupsCache,
} from "@/lib/backupsRead";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The backups-list read + its per-deployment TTL cache now live in lib/backupsRead
// so GET /api/backups and the backups RSC (app/app/backups/page.tsx) compute an
// IDENTICAL payload from one code path (no hydration drift) and share one cache.
// Re-exported here so the existing test seam import path keeps working.
export { __resetBackupsCache };

// GET /api/backups?deployment=... — the union of:
//  • LIVE Convex cloud backups (read via CONVEX_ACCESS_TOKEN) — every deployment's
//    periodic backups, so "check for new backups" is just this list, and
//  • backups already grabbed into the tool (flotilla_backups + GridFS blob),
// with `stored`/`grabbed` flags so the UI shows what's available vs. pulled in.
export async function GET(req: Request) {
  const deployment = new URL(req.url).searchParams.get("deployment") ?? undefined;
  return withOperator(() =>
    safeRead(
      "backups unavailable",
      { backups: [], deployments: KNOWN_DEPLOYMENTS, cloudConfigured: false },
      async () => ok(await readBackups(deployment)),
    ),
  );
}

// Grab ONE cloud snapshot into the GitHub-Releases store + index it. Shared by
// the single "grab" and the bulk "grab-all" actions.
async function grabOne(deployment: string, snapshotId: string, cloudBackupId: number | undefined, actor: string) {
  const convex = makeConvexBackupsClient();
  const stream = await convex.downloadSnapshot(deployment, snapshotId);
  const filename = `${deployment}_${snapshotId}.zip`;
  const { assetId, sizeBytes } = await putSnapshot(filename, stream, 0);
  const backup = await registerBackup({
    deployment,
    sizeBytes,
    source: "cloud",
    storeKind: "gh",
    blobRef: String(assetId),
    snapshotId,
    cloudBackupId,
    filename,
    note: "pulled from Convex cloud backups",
  });
  await recordAudit(actor, "backup.grab", backup.id, `${deployment} snapshot ${snapshotId}`).catch(() => {});
  // A grab changes this deployment's stored/grabbed flags in the union — bust so
  // the next GET reflects it immediately rather than at TTL expiry.
  bustCloudBackupsCache(deployment);
  return backup;
}

// POST /api/backups
//  • JSON { action:"grab", deployment, snapshotId, cloudBackupId } — grab one.
//  • JSON { action:"grab-all", deployment? } — grab every un-stored cloud backup
//    (one deployment, or all known), newest-first, within the request time budget.
//  • multipart/form-data (file, deployment, note) — ingest a manually-downloaded ZIP.
export async function POST(req: Request) {
  const ctype = req.headers.get("content-type") ?? "";
  if (ctype.includes("application/json")) {
    return withOperator(async (principal) => {
      const body = (await req.json()) as { action?: string; deployment?: string; snapshotId?: string; cloudBackupId?: number };
      const convex = makeConvexBackupsClient();

      if (body.action === "grab-all") {
        if (!convex.configured) return bad("CONVEX_ACCESS_TOKEN not configured");
        if (!snapshotStoreConfigured()) return bad("GITHUB_TOKEN not configured — snapshot store unavailable");
        const names = body.deployment ? [body.deployment] : KNOWN_DEPLOYMENTS.map((d) => d.id);
        const stored = await listBackups();
        const have = new Set(stored.filter((s) => s.snapshotId).map((s) => s.snapshotId!));
        // Stay under maxDuration; each ~180MB grab is ~15-30s. Remaining backups
        // can be picked up by a re-run (idempotent — already-stored are skipped).
        const deadline = Date.now() + 250_000;
        const result = { grabbed: 0, skipped: 0, failed: [] as Array<{ deployment: string; snapshotId: string; error: string }>, remaining: 0 };
        for (const name of names) {
          let cloud: Awaited<ReturnType<typeof convex.listCloudBackups>> = [];
          try {
            cloud = await convex.listCloudBackups(name);
          } catch {
            continue;
          }
          cloud.sort((a, b) => (b.completedTime ?? b.requestedTime ?? 0) - (a.completedTime ?? a.requestedTime ?? 0));
          for (const cb of cloud) {
            if (have.has(cb.snapshotId)) {
              result.skipped++;
              continue;
            }
            if (Date.now() > deadline) {
              result.remaining++;
              continue;
            }
            try {
              await grabOne(name, cb.snapshotId, cb.id, principal.id);
              have.add(cb.snapshotId);
              result.grabbed++;
            } catch (e) {
              result.failed.push({ deployment: name, snapshotId: cb.snapshotId, error: e instanceof Error ? e.message.slice(0, 120) : String(e) });
            }
          }
        }
        await recordAudit(principal.id, "backup.grab-all", body.deployment ?? "all", `grabbed ${result.grabbed}, skipped ${result.skipped}, remaining ${result.remaining}`).catch(() => {});
        return ok(result);
      }

      if (body.action !== "grab") return bad("unsupported action");
      if (!body.deployment || !body.snapshotId) return bad("deployment and snapshotId required");
      if (!convex.configured) return bad("CONVEX_ACCESS_TOKEN not configured");
      if (!snapshotStoreConfigured()) return bad("GITHUB_TOKEN not configured — snapshot store unavailable");
      const backup = await grabOne(body.deployment, body.snapshotId, body.cloudBackupId, principal.id);
      return ok({ backup });
    }, "write");
  }

  return withOperator(async (principal) => {
    const form = await req.formData();
    const file = form.get("file");
    const deployment = String(form.get("deployment") ?? "");
    const note = form.get("note") ? String(form.get("note")) : undefined;
    if (!deployment) return bad("deployment required");
    if (!(file instanceof File)) return bad("file (snapshot .zip) required");
    if (!snapshotStoreConfigured()) return bad("GITHUB_TOKEN not configured — snapshot store unavailable");
    const stream = Readable.fromWeb(file.stream() as never);
    // Unique asset name — file names can collide, so scope by deployment + time.
    const safeName = file.name.replace(/[^\w.-]+/g, "_");
    const key = `${deployment}_${Date.now()}_${safeName}`;
    const { assetId, sizeBytes } = await putSnapshot(key, stream, file.size);
    const backup = await registerBackup({
      deployment,
      sizeBytes: sizeBytes || file.size,
      source: "upload",
      storeKind: "gh",
      blobRef: String(assetId),
      filename: file.name,
      note,
    });
    await recordAudit(principal.id, "backup.upload", backup.id, `${deployment} ${file.name}`).catch(() => {});
    return ok({ backup });
  }, "write");
}

// DELETE /api/backups?id=... — drop a grabbed backup (metadata + blob).
export async function DELETE(req: Request) {
  return withOperator(async (principal) => {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return bad("id required");
    // Destructive: require an explicit ack so a stray DELETE can't silently drop
    // a grabbed snapshot (metadata + blob).
    if (url.searchParams.get("dangerAck") !== "true") {
      return bad("deleting a backup requires ?dangerAck=true", 400);
    }
    const b = await getBackup(id);
    // Route the blob delete to the right store: GH release asset for new rows,
    // legacy GridFS for pre-migration rows.
    if (b?.storeKind === "gh" || b?.blobRef) {
      if (b.blobRef) await deleteSnapshot(b.blobRef);
    } else if (b?.gridfsId) {
      await deleteBackupBlob(b.gridfsId);
    }
    await deleteBackup(id);
    // Deleting a grabbed backup flips a cloud entry's `stored` flag in the union —
    // bust so the next GET recomputes it (drop only this deployment when known).
    bustCloudBackupsCache(b?.deployment);
    await recordAudit(principal.id, "backup.delete", id, b ? `${b.deployment} ${b.filename}` : undefined).catch(() => {});
    return ok({ deleted: id });
  }, "write");
}
