// In-memory GitStore — for tests and headless dev. Models commit-per-change and
// blob-sha optimistic concurrency exactly like the real repo, so the indexer +
// save engine behave identically against it.

import { ConflictError, type GitStore, type SourceFile, type WriteOpts } from "./types";
import { gitBlobSha } from "./sha";

export interface CommitRecord {
  path: string;
  message: string;
  author: string;
  op: "write" | "remove";
}

export class MemoryGitStore implements GitStore {
  private files = new Map<string, string>();
  private log: CommitRecord[] = [];

  constructor(seed: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(seed)) this.files.set(p, c);
  }

  async listMarkdown(): Promise<string[]> {
    return [...this.files.keys()]
      .filter((p) => p.endsWith(".md") || p.endsWith(".mdx"))
      .sort();
  }

  async read(path: string): Promise<SourceFile | null> {
    const content = this.files.get(path);
    return content === undefined ? null : { path, content, sha: gitBlobSha(content) };
  }

  async write(path: string, content: string, opts: WriteOpts): Promise<{ sha: string }> {
    // Check-and-set is a single synchronous block (no await between the sha check
    // and the set), so it is inherently atomic under concurrency: two overlapping
    // saves off the same baseSha cannot both pass — the second observes the first's
    // content and throws ConflictError. Mirrors the CAS the Mongo/local stores make
    // atomic explicitly.
    if (opts.baseSha !== undefined) {
      const cur = this.files.get(path);
      const curSha = cur === undefined ? undefined : gitBlobSha(cur);
      if (curSha !== opts.baseSha) throw new ConflictError(path, opts.baseSha, curSha);
    }
    this.files.set(path, content);
    this.log.push({ path, message: opts.message, author: opts.authorEmail, op: "write" });
    return { sha: gitBlobSha(content) };
  }

  async remove(path: string, opts: Omit<WriteOpts, "baseSha">): Promise<void> {
    this.files.delete(path);
    this.log.push({ path, message: opts.message, author: opts.authorEmail, op: "remove" });
  }

  /** Test introspection: the commit history. */
  commits(): CommitRecord[] {
    return [...this.log];
  }
}
