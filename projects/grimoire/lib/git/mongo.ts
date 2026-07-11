// Mongo-backed GitStore — the durable "repo" for deployments without a writable
// git working tree (e.g. Render's read-only container FS, where LocalGitStore
// fails with EACCES). Doc content lives in the `files` collection; every write /
// remove appends a snapshot to `versions` (enabling rollback + diff). Models the
// same commit-per-change + blob-sha optimistic concurrency as the other stores.

import { ConflictError, type GitStore, type SourceFile, type WriteOpts } from "./types";
import { gitBlobSha } from "./sha";
import { getDatabase } from "../db";
import type { Database } from "../db/types";
import { repos } from "../repos";

const MD = /\.mdx?$/;

export class MongoGitStore implements GitStore {
  constructor(private readonly handle?: Database) {}
  private async repos() {
    return repos(this.handle ?? (await getDatabase()));
  }

  // Next version derived from the DURABLE append-only log (not the deletable
  // `files` row) so numbering is strictly monotonic per path and never collides
  // across delete/trash/recreate boundaries. Fetch only the highest-version row
  // via an indexed sort ({path,version} unique index) instead of loading every
  // snapshot (each carrying full `content`) and reducing — the old approach grew
  // linearly with a doc's history and dragged the whole content payload over the
  // wire on every write.
  private async nextVersion(
    r: Awaited<ReturnType<MongoGitStore["repos"]>>,
    path: string,
  ): Promise<number> {
    const latest = await r.versions.findOne({ path }, { sort: { version: -1 } });
    return (latest?.version ?? 0) + 1;
  }

  async listMarkdown(): Promise<string[]> {
    const r = await this.repos();
    return (await r.files.find())
      .map((f) => f.path)
      .filter((p) => MD.test(p))
      .sort();
  }

  async read(path: string): Promise<SourceFile | null> {
    const r = await this.repos();
    const f = await r.files.findOne({ path });
    return f ? { path, content: f.content, sha: f.sha } : null;
  }

  async write(path: string, content: string, opts: WriteOpts): Promise<{ sha: string }> {
    const r = await this.repos();
    const sha = gitBlobSha(content);
    const updatedAt = Date.now();
    const version = await this.nextVersion(r, path);

    if (opts.baseSha !== undefined) {
      // Atomic compare-and-swap on the blob-sha concurrency token: advance ONLY
      // the row still at baseSha. If a concurrent write already moved it, 0 rows
      // match and we raise ConflictError — never a silent last-write-wins clobber.
      // (The patch always carries a fresh `version`, so a matched row is always
      // modified; matchedCount == modifiedCount here.) A duplicate `version` is
      // additionally barred by the unique (path, version) index in prod Mongo.
      const matched = await r.files.update(
        { path, sha: opts.baseSha },
        { path, content, sha, version, updatedAt },
      );
      if (matched === 0) {
        const cur = await r.files.findOne({ path });
        throw new ConflictError(path, opts.baseSha, cur?.sha);
      }
    } else {
      // No token supplied ⇒ a deliberate overwrite (create / accept / rollback).
      await r.files.upsert({ path }, { path, content, sha, version, updatedAt });
    }

    await r.versions.insert({
      path,
      content,
      sha,
      version,
      author: opts.authorEmail,
      message: opts.message,
      at: updatedAt,
    });
    return { sha };
  }

  async remove(path: string, opts: Omit<WriteOpts, "baseSha">): Promise<void> {
    const r = await this.repos();
    const cur = await r.files.findOne({ path });
    if (!cur) return;
    const version = await this.nextVersion(r, path);
    await r.files.delete({ path });
    await r.versions.insert({
      path,
      content: "",
      sha: "",
      version,
      author: opts.authorEmail,
      message: opts.message,
      at: Date.now(),
      removed: true,
    });
  }
}

/** Seed the `files` store from the `docs` projection when it's empty but docs
 *  already exist (e.g. a deployment that indexed content straight into Mongo).
 *  Uses `doc.blobSha` as the seeded sha so the editor's baseSha (also doc.blobSha)
 *  matches and the first save never spuriously conflicts. Runs once. */
export async function ensureFilesSeeded(handle?: Database): Promise<void> {
  const r = repos(handle ?? (await getDatabase()));
  if ((await r.files.count()) > 0) return;
  const docs = await r.docs.find();
  if (docs.length === 0) return;
  const now = Date.now();
  for (const d of docs) {
    await r.files.insert({
      path: d.path,
      content: d.body,
      sha: d.blobSha,
      version: 1,
      updatedAt: d.updatedAt ?? now,
    });
    await r.versions.insert({
      path: d.path,
      content: d.body,
      sha: d.blobSha,
      version: 1,
      author: "import",
      message: `docs(${d.path}): seed`,
      at: d.updatedAt ?? now,
    });
  }
}
