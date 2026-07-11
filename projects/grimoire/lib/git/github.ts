// GitHubGitStore — a GitStore over the GitHub REST API (Octokit), the production
// commit path for app-authored changes + webhook-driven indexing. Reads list the
// tree and decode blob contents; writes are commit-per-change via the Contents
// API, authored as the acting user, with blob-sha optimistic concurrency. The
// repo stays the durable source of truth; the DB is a rebuildable index over it.

import { Octokit } from "@octokit/rest";

import { ConflictError, type GitStore, type SourceFile, type WriteOpts } from "./types";

export interface GitHubGitStoreConfig {
  /** Injected Octokit instance (tests pass a fake; prod uses a real client). */
  octokit: Octokit;
  owner: string;
  repo: string;
  /** Branch to read from and commit onto. */
  branch: string;
  /** Repo-relative dir holding docs ("" = whole repo). */
  contentRoot: string;
}

/** Pulls the HTTP status off an Octokit RequestError (or any error-like value). */
function httpStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

export class GitHubGitStore implements GitStore {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly contentRoot: string;

  constructor(config: GitHubGitStoreConfig) {
    this.octokit = config.octokit;
    this.owner = config.owner;
    this.repo = config.repo;
    this.branch = config.branch;
    this.contentRoot = config.contentRoot;
  }

  async listMarkdown(): Promise<string[]> {
    const res = await this.octokit.rest.git.getTree({
      owner: this.owner,
      repo: this.repo,
      tree_sha: this.branch,
      recursive: "1",
    });
    const prefix = this.contentRoot ? `${this.contentRoot.replace(/\/+$/, "")}/` : "";
    return res.data.tree
      .filter((e) => e.type === "blob")
      .map((e) => e.path)
      .filter((p): p is string => typeof p === "string")
      .filter((p) => p.startsWith(prefix) && (p.endsWith(".md") || p.endsWith(".mdx")))
      .sort();
  }

  async read(path: string): Promise<SourceFile | null> {
    try {
      const res = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref: this.branch,
      });
      const data = res.data;
      if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
        return null;
      }
      const content = Buffer.from(data.content, "base64").toString("utf8");
      // GitHub's `sha` here is the blob sha — the same token write() must echo back.
      return { path, content, sha: data.sha };
    } catch (err) {
      if (httpStatus(err) === 404) return null;
      throw err;
    }
  }

  async write(path: string, content: string, opts: WriteOpts): Promise<{ sha: string }> {
    try {
      const res = await this.octokit.rest.repos.createOrUpdateFileContents({
        owner: this.owner,
        repo: this.repo,
        path,
        branch: this.branch,
        message: opts.message,
        content: Buffer.from(content, "utf8").toString("base64"),
        committer: { name: opts.authorName, email: opts.authorEmail },
        author: { name: opts.authorName, email: opts.authorEmail },
        ...(opts.baseSha !== undefined ? { sha: opts.baseSha } : {}),
      });
      const sha = res.data.content?.sha;
      if (!sha) throw new Error(`GitHub returned no blob sha for ${path}`);
      return { sha };
    } catch (err) {
      // A stale baseSha makes GitHub reject the update with 409 (conflict) or 422
      // (unprocessable). Surface it as a ConflictError — never a silent clobber.
      const status = httpStatus(err);
      if (status === 409 || status === 422) {
        const current = await this.read(path).catch(() => null);
        throw new ConflictError(path, opts.baseSha, current?.sha);
      }
      throw err;
    }
  }

  async remove(path: string, opts: Omit<WriteOpts, "baseSha">): Promise<void> {
    // DELETE needs the current blob sha, so fetch it first.
    const current = await this.read(path);
    if (!current) return;
    await this.octokit.rest.repos.deleteFile({
      owner: this.owner,
      repo: this.repo,
      path,
      message: opts.message,
      sha: current.sha,
      branch: this.branch,
      committer: { name: opts.authorName, email: opts.authorEmail },
      author: { name: opts.authorName, email: opts.authorEmail },
    });
  }
}

/**
 * Builds a GitHubGitStore from environment config for real (non-test) use:
 * GITHUB_TOKEN, DOCS_REPO ("owner/repo"), DOCS_BRANCH (default "main"),
 * DOCS_CONTENT_ROOT (default "").
 */
export function gitHubStoreFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubGitStore {
  const token = env.GITHUB_TOKEN;
  const slug = env.DOCS_REPO;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!slug) throw new Error("DOCS_REPO is required");
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) throw new Error(`DOCS_REPO must be "owner/repo", got "${slug}"`);
  return new GitHubGitStore({
    octokit: new Octokit({ auth: token }),
    owner,
    repo,
    branch: env.DOCS_BRANCH ?? "main",
    contentRoot: env.DOCS_CONTENT_ROOT ?? "",
  });
}
