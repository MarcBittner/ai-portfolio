// LocalGitStore — a GitStore over a local clone (fs for reads, git CLI for
// commit-per-change). The headless real implementation: reads index the working
// tree; writes commit authored as the acting user. (The GitHub Contents API impl
// for app-authored commits + webhooks slots in behind the same interface later.)

import { execFile } from "node:child_process";
import { readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { ConflictError, type GitStore, type SourceFile, type WriteOpts } from "./types";
import { gitBlobSha } from "./sha";

const exec = promisify(execFile);

const IGNORE_DIRS = new Set([".git", "node_modules", ".next", "untracked"]);

export class LocalGitStore implements GitStore {
  /**
   * @param repoDir absolute path to the clone
   * @param contentRoot repo-relative dir holding docs ("" = whole repo)
   */
  constructor(
    private readonly repoDir: string,
    private readonly contentRoot = "",
  ) {}

  // Per-store write mutex. The sha-check and the commit that follows it are not
  // individually atomic (fs + git CLI, each awaited), so without serialization
  // two concurrent saves off the same baseSha could both pass the check and both
  // commit — a silent clobber. Chaining every write/remove through one promise
  // makes check-then-commit atomic in-process, so the second save observes the
  // first's sha and raises ConflictError.
  private writeLock: Promise<unknown> = Promise.resolve();
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeLock.then(fn, fn);
    this.writeLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private abs(path: string): string {
    // Containment at the sink: the security invariant lives here, not in each
    // caller. Reject null bytes and any path that resolves outside the repo
    // (path traversal via "../", absolute paths, etc.).
    if (path.includes("\0")) {
      throw new Error("Illegal path: null byte");
    }
    const target = join(this.repoDir, path);
    const rel = relative(this.repoDir, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Illegal path: escapes the repository (${path})`);
    }
    return target;
  }

  async listMarkdown(): Promise<string[]> {
    const root = this.contentRoot ? join(this.repoDir, this.contentRoot) : this.repoDir;
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!IGNORE_DIRS.has(e.name)) await walk(join(dir, e.name));
        } else if (e.name.endsWith(".md") || e.name.endsWith(".mdx")) {
          out.push(relative(this.repoDir, join(dir, e.name)).split(sep).join("/"));
        }
      }
    };
    await walk(root);
    return out.sort();
  }

  async read(path: string): Promise<SourceFile | null> {
    try {
      const content = await readFile(this.abs(path), "utf8");
      return { path, content, sha: gitBlobSha(content) };
    } catch {
      return null;
    }
  }

  private async currentSha(path: string): Promise<string | undefined> {
    const f = await this.read(path);
    return f?.sha;
  }

  async write(path: string, content: string, opts: WriteOpts): Promise<{ sha: string }> {
    return this.serialize(async () => {
      if (opts.baseSha !== undefined) {
        const cur = await this.currentSha(path);
        if (cur !== opts.baseSha) throw new ConflictError(path, opts.baseSha, cur);
      }
      await mkdir(dirname(this.abs(path)), { recursive: true });
      await writeFile(this.abs(path), content, "utf8");
      await exec("git", ["-C", this.repoDir, "add", "--", path]);
      await exec("git", [
        "-C", this.repoDir,
        "-c", `user.name=${opts.authorName}`,
        "-c", `user.email=${opts.authorEmail}`,
        "commit", "-m", opts.message,
        "--author", `${opts.authorName} <${opts.authorEmail}>`,
        "--", path,
      ]);
      return { sha: gitBlobSha(content) };
    });
  }

  async remove(path: string, opts: Omit<WriteOpts, "baseSha">): Promise<void> {
    return this.serialize(async () => {
      await rm(this.abs(path), { force: true });
      await exec("git", ["-C", this.repoDir, "rm", "--ignore-unmatch", "--", path]);
      await exec("git", [
        "-C", this.repoDir,
        "-c", `user.name=${opts.authorName}`,
        "-c", `user.email=${opts.authorEmail}`,
        "commit", "-m", opts.message,
      ]);
    });
  }
}
