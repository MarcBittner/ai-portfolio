// GitStore — abstraction over the source-of-truth repo, so the indexer + save
// engine don't depend on HOW the repo is reached. Implementations: in-memory
// (tests), local clone (fs + git CLI), and GitHub Contents API (Octokit, for
// app-authored commits + webhooks). The repo is durable truth; the DB is a
// rebuildable index over it (architecture.md §2).

export interface SourceFile {
  path: string; // repo-relative
  content: string;
  sha: string; // git blob sha (optimistic-concurrency token)
}

export interface WriteOpts {
  message: string;
  authorName: string;
  authorEmail: string;
  /** Expected current blob sha; if it doesn't match HEAD, the write conflicts. */
  baseSha?: string;
}

export interface GitStore {
  /** All Markdown paths in the content root, sorted. */
  listMarkdown(): Promise<string[]>;
  read(path: string): Promise<SourceFile | null>;
  /** Commit-per-change. Returns the new blob sha. Throws ConflictError on stale baseSha. */
  write(path: string, content: string, opts: WriteOpts): Promise<{ sha: string }>;
  remove(path: string, opts: Omit<WriteOpts, "baseSha">): Promise<void>;
}

/** Raised when a write's baseSha no longer matches HEAD (concurrent edit). The
 *  caller surfaces a 3-way diff (engineering view) — never a silent clobber. */
export class ConflictError extends Error {
  constructor(
    readonly path: string,
    readonly expected: string | undefined,
    readonly actual: string | undefined,
  ) {
    super(`conflict on ${path}: expected ${expected ?? "(new)"}, found ${actual ?? "(absent)"}`);
    this.name = "ConflictError";
  }
}
