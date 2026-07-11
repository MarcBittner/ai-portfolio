// lib/clients/github.ts — list branches of the managed app repo via the GitHub
// REST API, so the UI can offer a branch picker for "which code to deploy".
//
// Repo: the Vercel projects deploy the managed app from GitHub; the repo is set via
// GITHUB_REPO ("owner/repo") and defaults to a generic placeholder. Auth is a fine-
// grained or classic token in GITHUB_TOKEN (optional for a public repo; required for
// a private one). No token / a failure surfaces as a degraded empty list upstream.

import type { ScopedLogger } from "../logtap.ts";
import { createHmac, timingSafeEqual } from "node:crypto";

const API = process.env.GITHUB_API || "https://api.github.com";
const REPO = process.env.GITHUB_REPO || "example-org/example-app";
const GIT_HOST = process.env.GITHUB_GIT_HOST || "github.com";

export type GitBranch = { name: string; sha: string; protected: boolean };

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

// ── GitHub webhook HMAC verification (PR-native lifecycle) ───────────────────
// GitHub signs every webhook delivery with HMAC-SHA256 over the RAW request body,
// keyed by the shared secret, and sends it as `X-Hub-Signature-256: sha256=<hex>`.
// We recompute it and compare in constant time. This is the ONLY authentication on
// the webhook route (GitHub is the caller, not an operator), so a missing/blank
// secret or a mismatched signature MUST reject — never provision from an
// unverified payload. Returns false for any missing input; never throws.
export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !secret.trim()) return false;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  // Constant-time compare — bail early only on a length mismatch (which timingSafe
  // rejects anyway) to avoid throwing on unequal buffers.
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function ghHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "flotilla",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// True once we hold a token to write PR comments. Comment sync degrades to a no-op
// (never an error) when unset — the same posture as the branch list.
export function githubWriteConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN);
}

// Create ONE issue/PR comment (PRs are issues for the comments API). Returns the
// new comment id, or null on any failure (best-effort — a comment must never break
// the lifecycle). `repo` is validated to block path traversal onto another
// endpoint, mirroring listBranches.
export async function createIssueComment(
  repo: string,
  issueNumber: number,
  body: string,
): Promise<number | null> {
  if (!REPO_RE.test(repo) || !process.env.GITHUB_TOKEN) return null;
  try {
    const res = await fetch(`${API}/repos/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: { ...ghHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { id?: number };
    return typeof json.id === "number" ? json.id : null;
  } catch {
    return null;
  }
}

// Edit an existing PR comment in place (the canonical-comment "don't spam" path).
// Returns whether the edit succeeded; best-effort, never throws.
export async function updateIssueComment(repo: string, commentId: number, body: string): Promise<boolean> {
  if (!REPO_RE.test(repo) || !process.env.GITHUB_TOKEN) return false;
  try {
    const res = await fetch(`${API}/repos/${repo}/issues/comments/${commentId}`, {
      method: "PATCH",
      headers: { ...ghHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function githubConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN);
}

// Pushing a patch branch needs a WRITE-scoped token (contents:write / `repo`),
// unlike the read-only branch picker + snapshot store. Same env var — but the
// token must carry push scope for the patch-push feature to work end-to-end.
// EXTERNAL PREREQUISITE: grant GITHUB_TOKEN push access to GITHUB_REPO.
export function githubPushConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN);
}

// Validate `owner/name` — an unvalidated repo could traverse to a different repo
// or host (same guard as listBranches / the snapshot store).
function assertRepo(repo: string): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`invalid repo "${repo}" — expected owner/name`);
  }
}

export type PushPatchArgs = {
  /** Base branch the diff was generated against; the ephemeral branch forks it. */
  baseBranch: string;
  /** The unified-diff text (already validated by validatePatch upstream). */
  patch: string;
  /** The ephemeral branch to create + push (e.g. flotilla-patch/<inst>-<ts>). */
  branchName: string;
  repo?: string;
  commitMessage?: string;
  log?: ScopedLogger;
};

export type PushPatchResult = {
  branch: string;
  baseSha: string;
  headSha: string;
  filesChanged: number;
};

// Apply a unified diff on top of `baseBranch` as a fresh commit on a new
// ephemeral branch, and push it — the git-ref the executor/Vercel deploy step
// consumes. Runs on the WORKER (has a filesystem + `git`); shells out with
// execFile (no shell) exactly like the export/import/mask paths. The write token
// is passed via the clone URL and REDACTED from every logged line.
//
// This is the one piece that needs a WRITE-scoped GITHUB_TOKEN (see
// githubPushConfigured). It is injected as a fake in unit tests, so the git CLI
// path is never exercised there — mirrors how executeProvision's real HTTP is
// faked in tests.
export async function pushPatchBranch(args: PushPatchArgs): Promise<PushPatchResult> {
  const repo = args.repo ?? REPO;
  assertRepo(repo);
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not configured — cannot push a patch branch");

  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const { execCapture } = await import("./exec.ts");

  // Redact the token from any streamed git output (clone URL / error messages).
  const rawLog = args.log;
  const log: ScopedLogger | undefined = rawLog
    ? (level, msg) => rawLog(level, token ? msg.split(token).join("***") : msg)
    : undefined;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-patch-"));
  const repoDir = path.join(workDir, "repo");
  const patchFile = path.join(workDir, "change.patch");
  fs.writeFileSync(patchFile, args.patch, "utf8");

  const cloneUrl = `https://x-access-token:${token}@${GIT_HOST}/${repo}.git`;

  try {
    log?.("info", `cloning ${repo}#${args.baseBranch} (shallow) to apply patch`);
    let r = await execCapture(
      "git",
      ["clone", "--depth", "1", "--single-branch", "--branch", args.baseBranch, "--", cloneUrl, repoDir],
      { log, timeoutMs: 5 * 60_000 },
    );
    if (r.code !== 0) throw new Error(`git clone failed (${r.code}): ${redact(r.stderr, token)}`);

    const baseSha = (await git(repoDir, ["rev-parse", "HEAD"])).stdout.trim();

    // Dry-run apply FIRST so a non-applying patch fails cleanly with no commit.
    r = await git(repoDir, ["apply", "--check", "--whitespace=nowarn", "--", patchFile], log);
    if (r.code !== 0) throw new Error(`patch does not apply cleanly to ${args.baseBranch}: ${redact(r.stderr, token)}`);
    r = await git(repoDir, ["apply", "--whitespace=nowarn", "--", patchFile], log);
    if (r.code !== 0) throw new Error(`git apply failed (${r.code}): ${redact(r.stderr, token)}`);

    // Identity is required for a commit; use a neutral bot identity (no personal
    // account linkage). Stage everything the patch touched (adds/mods/deletes).
    await git(repoDir, ["config", "user.email", "flotilla-bot@flotilla.local"]);
    await git(repoDir, ["config", "user.name", "flotilla patch bot"]);
    await git(repoDir, ["add", "-A"]);
    const filesChanged = (await git(repoDir, ["diff", "--cached", "--name-only"])).stdout
      .split("\n")
      .filter((l) => l.trim()).length;
    r = await git(repoDir, ["commit", "-m", args.commitMessage ?? "flotilla: apply uploaded patch"]);
    if (r.code !== 0) throw new Error(`git commit failed (${r.code}): ${redact(r.stderr, token)}`);
    const headSha = (await git(repoDir, ["rev-parse", "HEAD"])).stdout.trim();

    log?.("info", `pushing ephemeral branch ${args.branchName}`);
    r = await git(repoDir, ["push", "origin", `HEAD:refs/heads/${args.branchName}`], log);
    if (r.code !== 0) throw new Error(`git push failed (${r.code}): ${redact(r.stderr, token)}`);

    return { branch: args.branchName, baseSha, headSha, filesChanged };
  } finally {
    // Reclaim the temp checkout (which contains the token-bearing remote config).
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  async function git(cwd: string, gitArgs: string[], scoped?: ScopedLogger) {
    return execCapture("git", ["-C", cwd, ...gitArgs], { log: scoped, timeoutMs: 5 * 60_000 });
  }
}

function redact(s: string, token: string | undefined): string {
  const trimmed = (s ?? "").slice(0, 400);
  return token ? trimmed.split(token).join("***") : trimmed;
}

// Short TTL cache over the branch list (perf-plan Tier-A). listBranches makes a
// LIVE api.github.com REST round-trip on every call (measured ~321ms warm, the
// slowest steady-state endpoint) with no cache — every dashboard load that renders
// the branch picker re-hits GitHub. Branches change rarely and this read is
// read-only, so a short per-repo TTL turns that 320ms hop into a memory read for
// ~98% of loads (and insulates from GitHub rate limits). Same idiom as the
// config/principal TTL caches. No bust is needed: it's a read-only external list
// and one TTL of staleness on a rarely-changing branch set is the accepted budget.
function branchesTtlMs(): number {
  const ms = Number(process.env.FLOTILLA_BRANCHES_TTL_MS || "60000");
  return Number.isFinite(ms) && ms >= 0 ? ms : 60000;
}
const branchesCache = new Map<string, { value: GitBranch[]; expires: number }>();

// Test seam: drop the cache so a suite driving many branch sets through one repo
// key sees each fetch fresh (the TTL is time-based, not test-friendly).
export function __resetBranchesCache(): void {
  branchesCache.clear();
}

export async function listBranches(repo = REPO): Promise<GitBranch[]> {
  // Validate `owner/name` — an unvalidated repo lets a value like `../../user`
  // traverse to a different authenticated api.github.com endpoint.
  if (!REPO_RE.test(repo)) {
    throw new Error(`invalid repo "${repo}" — expected owner/name`);
  }
  // Serve a warm, unexpired cache entry (keyed by repo) before touching GitHub.
  const cached = branchesCache.get(repo);
  if (cached && cached.expires > Date.now()) return cached.value;

  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "flotilla",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const out: GitBranch[] = [];
  // Paginate up to 5 pages (500 branches) so long-lived repos still resolve.
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${API}/repos/${repo}/branches?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub branches ${repo} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const batch = (await res.json()) as Array<{ name: string; commit: { sha: string }; protected: boolean }>;
    for (const b of batch) out.push({ name: b.name, sha: b.commit.sha, protected: b.protected });
    if (batch.length < 100) break;
  }
  // Cache only a SUCCESSFUL, complete read. A thrown error (bad status) never
  // reaches here, so a transient GitHub failure degrades to a live call next time
  // rather than caching an empty/partial list.
  branchesCache.set(repo, { value: out, expires: Date.now() + branchesTtlMs() });
  return out;
}
