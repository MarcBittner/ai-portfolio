import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { changedMarkdownPaths, isTrackedBranch, verifyGitHubSignature } from "../lib/git/webhook";
import { MemoryDatabase } from "../lib/db/memory";
import type { Database } from "../lib/db/types";
import { MemoryGitStore } from "../lib/git/memory";
import { applyPushChanges, indexAll } from "../lib/git/indexer";
import { repos } from "../lib/repos";

const sign = (secret: string, body: string) =>
  "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");

describe("verifyGitHubSignature", () => {
  const secret = "whsec_test";
  const body = '{"hello":"world"}';

  it("accepts a correct signature", () => {
    expect(verifyGitHubSignature(secret, body, sign(secret, body))).toBe(true);
  });
  it("rejects a tampered body / wrong secret / missing header", () => {
    expect(verifyGitHubSignature(secret, body + "x", sign(secret, body))).toBe(false);
    expect(verifyGitHubSignature("other", body, sign(secret, body))).toBe(false);
    expect(verifyGitHubSignature(secret, body, null)).toBe(false);
    expect(verifyGitHubSignature("", body, sign(secret, body))).toBe(false);
  });
});

describe("changedMarkdownPaths", () => {
  const payload = {
    commits: [
      { added: ["docs/a.md", "docs/img.png"], modified: ["docs/b.md"], removed: [] },
      { added: [], modified: ["docs/b.md"], removed: ["docs/c.md", "other/x.md"] },
    ],
  };

  it("collects md added/modified under the content root, dedup'd", () => {
    const { changed } = changedMarkdownPaths(payload, "docs");
    expect(changed).toEqual(["docs/a.md", "docs/b.md"]); // png excluded, b deduped
  });
  it("collects removed md under the root only", () => {
    const { removed } = changedMarkdownPaths(payload, "docs");
    expect(removed).toEqual(["docs/c.md"]); // other/x.md excluded by root
  });
  it("a path changed and removed across commits resolves to changed", () => {
    const p = { commits: [{ removed: ["docs/a.md"] }, { added: ["docs/a.md"] }] };
    const { changed, removed } = changedMarkdownPaths(p, "docs");
    expect(changed).toContain("docs/a.md");
    expect(removed).not.toContain("docs/a.md");
  });
  it("empty content root matches all md", () => {
    const { changed } = changedMarkdownPaths(payload, "");
    expect(changed).toContain("docs/a.md");
  });
});

describe("isTrackedBranch", () => {
  it("accepts a push whose ref matches the docs branch (bare or qualified)", () => {
    expect(isTrackedBranch("refs/heads/main", "main")).toBe(true);
    expect(isTrackedBranch("refs/heads/main", "refs/heads/main")).toBe(true);
    expect(isTrackedBranch("refs/heads/docs", "docs")).toBe(true);
  });
  it("rejects pushes to other branches / tags / missing refs", () => {
    expect(isTrackedBranch("refs/heads/feature/x", "main")).toBe(false);
    expect(isTrackedBranch("refs/tags/v1", "main")).toBe(false);
    expect(isTrackedBranch(undefined, "main")).toBe(false);
    expect(isTrackedBranch("refs/heads/main", "")).toBe(false);
  });
});

describe("applyPushChanges (removed-path reconciliation)", () => {
  let db: Database;
  let store: MemoryGitStore;
  beforeEach(async () => {
    db = new MemoryDatabase();
    store = new MemoryGitStore({
      "docs/keep.md": "# Keep\n",
      "docs/gone.md": "# Gone\n",
    });
    await indexAll(db, store);
  });

  it("de-indexes a path that is truly absent from the store", async () => {
    // gone.md really deleted from the docs branch.
    await store.remove("docs/gone.md", { authorName: "t", authorEmail: "t@example.com", message: "rm" });
    const counts = await applyPushChanges(db, store, [], ["docs/gone.md"]);
    expect(counts.removed).toBe(1);
    expect(await repos(db).docs.findOne({ path: "docs/gone.md" })).toBeNull();
    expect(await repos(db).docs.findOne({ path: "docs/keep.md" })).not.toBeNull();
  });

  it("does NOT de-index a 'removed' path that still exists on the docs branch", async () => {
    // The push (e.g. from another branch's history) reported gone.md as removed,
    // but the store (docs branch) still has it — it must survive.
    const counts = await applyPushChanges(db, store, [], ["docs/gone.md"]);
    expect(counts.removed).toBe(0);
    expect(await repos(db).docs.findOne({ path: "docs/gone.md" })).not.toBeNull();
  });
});
