import { GridFSBucket, ObjectId } from "mongodb";
import { Readable } from "node:stream";
import { db, BACKUP_BUCKET } from "./mongo.ts";

// GridFS storage for backup ZIP blobs. Convex snapshots are tens of MB, too big
// for a normal document, so the blob lives in GridFS while flotilla_backups holds
// the metadata. Same cluster the dashboard already uses (the shared cluster), so no new
// storage dependency and the deployed app can stream a snapshot back out at
// provision time.
async function bucket(): Promise<GridFSBucket> {
  const database = await db();
  return new GridFSBucket(database, { bucketName: BACKUP_BUCKET });
}

// Hard ceiling on a single snapshot blob (guards against a zip-bomb / runaway
// upload exhausting GridFS + the shared cluster). Override via MAX_BACKUP_BYTES.
const MAX_BACKUP_BYTES = Number(process.env.MAX_BACKUP_BYTES || 1024 * 1024 * 1024); // 1 GiB

/** Stream a snapshot into GridFS; resolves with the stored file id (string).
 *  Aborts + cleans up if the stream exceeds MAX_BACKUP_BYTES. */
export async function putBackupBlob(
  filename: string,
  source: Readable,
  metadata?: Record<string, unknown>,
): Promise<{ gridfsId: string; sizeBytes: number }> {
  const b = await bucket();
  return new Promise((resolve, reject) => {
    const upload = b.openUploadStream(filename, { metadata });
    let bytes = 0;
    let aborted = false;
    source.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_BACKUP_BYTES && !aborted) {
        aborted = true;
        source.destroy();
        upload.abort().catch(() => {});
        reject(new Error(`backup exceeds max size (${MAX_BACKUP_BYTES} bytes)`));
      }
    });
    source
      .pipe(upload)
      .on("error", reject)
      .on("finish", () => {
        if (!aborted) resolve({ gridfsId: upload.id.toString(), sizeBytes: bytes });
      });
  });
}

/** Open a read stream for a stored snapshot (e.g. to write to /tmp for import). */
export async function openBackupBlob(gridfsId: string): Promise<Readable> {
  const b = await bucket();
  return b.openDownloadStream(new ObjectId(gridfsId));
}

export async function deleteBackupBlob(gridfsId: string): Promise<void> {
  const b = await bucket();
  try {
    await b.delete(new ObjectId(gridfsId));
  } catch {
    // already gone — fine
  }
}
