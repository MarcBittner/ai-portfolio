import { z } from "zod";
import { col, newId, now, NO_ID } from "./base.ts";

// A Convex snapshot backup that has been "grabbed" into the tool: metadata in
// flotilla_backups, the ZIP blob in a blob store. NEW blobs live in GitHub Releases
// (storeKind "gh", blobRef = the release asset id); LEGACY blobs live in GridFS
// (storeKind "gridfs" / gridfsId) — snapshots are 60–180 MB and were filling the
// shared Atlas cluster, so writes moved off Mongo. Source is either a snapshot we
// exported via a deploy key, or one the operator downloaded from the Convex
// dashboard and uploaded. `ref` is the stable id used as a provision input
// ("point at a backup + a branch → populate/overwrite an instance").
export const BackupStatus = z.enum(["stored", "importing", "ingesting"]);

export type BackupDoc = {
  id: string;
  deployment: string; // convex deployment the snapshot came from
  ref: string; // stable, human-readable backup ref
  sizeBytes: number;
  source: "export" | "upload" | "cloud"; // cloud = pulled from Convex cloud backups
  storeKind?: "gh" | "gridfs"; // where the blob lives; undefined+gridfsId = legacy gridfs
  blobRef?: string; // GitHub release asset id (string form) when storeKind === "gh"
  gridfsId?: string; // LEGACY GridFS file id (string form) — reads/deletes only
  snapshotId?: string; // Convex _exports id (links a stored blob to its cloud backup)
  cloudBackupId?: number;
  filename: string;
  note?: string;
  status: z.infer<typeof BackupStatus>;
  createdAt: number;
};

export async function listBackups(deployment?: string): Promise<BackupDoc[]> {
  const c = await col<BackupDoc>("backups");
  const filter = deployment ? { deployment } : {};
  return c.find(filter, NO_ID).sort({ createdAt: -1 }).toArray();
}

export async function getBackup(id: string): Promise<BackupDoc | null> {
  const c = await col<BackupDoc>("backups");
  return c.findOne({ id }, NO_ID);
}

export async function registerBackup(input: {
  deployment: string;
  ref?: string;
  sizeBytes: number;
  source: BackupDoc["source"];
  storeKind?: BackupDoc["storeKind"];
  blobRef?: string;
  gridfsId?: string;
  snapshotId?: string;
  cloudBackupId?: number;
  filename: string;
  note?: string;
  status?: BackupDoc["status"];
}): Promise<BackupDoc> {
  const c = await col<BackupDoc>("backups");
  const ts = now();
  const doc: BackupDoc = {
    id: newId("bkp"),
    deployment: input.deployment,
    ref: input.ref ?? `${input.deployment}-${new Date(ts).toISOString().slice(0, 19).replace(/[:T]/g, "")}`,
    sizeBytes: input.sizeBytes,
    source: input.source,
    storeKind: input.storeKind,
    blobRef: input.blobRef,
    gridfsId: input.gridfsId,
    snapshotId: input.snapshotId,
    cloudBackupId: input.cloudBackupId,
    filename: input.filename,
    note: input.note,
    status: input.status ?? "stored",
    createdAt: ts,
  };
  await c.insertOne(doc);
  return doc;
}

export async function deleteBackup(id: string): Promise<void> {
  const c = await col<BackupDoc>("backups");
  await c.deleteOne({ id });
}
