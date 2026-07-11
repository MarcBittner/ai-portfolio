import { beforeEach, describe, expect, it } from "vitest";

import { MemoryDatabase } from "../lib/db/memory";
import type { Database } from "../lib/db/types";
import { MongoGitStore, ensureFilesSeeded } from "../lib/git/mongo";
import { ConflictError } from "../lib/git/types";
import { gitBlobSha } from "../lib/git/sha";
import { repos } from "../lib/repos";

const actor = { authorName: "t", authorEmail: "t@example.com", message: "m" };

describe("MongoGitStore", () => {
  let db: Database;
  let store: MongoGitStore;
  beforeEach(() => {
    db = new MemoryDatabase();
    store = new MongoGitStore(db);
  });

  it("writes, reads, and lists markdown", async () => {
    await store.write("eng/a.md", "# A\n", actor);
    await store.write("readme.md", "# R\n", actor);
    expect(await store.listMarkdown()).toEqual(["eng/a.md", "readme.md"]);
    const f = await store.read("eng/a.md");
    expect(f?.content).toBe("# A\n");
    expect(f?.sha).toBe(gitBlobSha("# A\n"));
    expect(await store.read("missing.md")).toBeNull();
  });

  it("enforces blob-sha optimistic concurrency", async () => {
    const { sha } = await store.write("a.md", "one", actor);
    // stale baseSha → conflict
    await expect(store.write("a.md", "two", { ...actor, baseSha: "deadbeef" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    // correct baseSha → ok
    await store.write("a.md", "two", { ...actor, baseSha: sha });
    expect((await store.read("a.md"))?.content).toBe("two");
  });

  it("appends a version snapshot per write, incrementing version", async () => {
    await store.write("a.md", "v1", actor);
    await store.write("a.md", "v2", { ...actor, baseSha: gitBlobSha("v1") });
    const versions = (await repos(db).versions.find({ path: "a.md" })).sort((x, y) => x.version - y.version);
    expect(versions.map((v) => [v.version, v.content])).toEqual([
      [1, "v1"],
      [2, "v2"],
    ]);
  });

  it("remove deletes the file and records a removal version", async () => {
    await store.write("a.md", "v1", actor);
    await store.remove("a.md", actor);
    expect(await store.read("a.md")).toBeNull();
    const last = (await repos(db).versions.find({ path: "a.md" })).sort((x, y) => y.version - x.version)[0];
    expect(last.removed).toBe(true);
  });

  it("version numbers stay monotonic across remove→recreate (no reset/collision)", async () => {
    await store.write("a.md", "v1", actor); // v1
    await store.write("a.md", "v2", { ...actor, baseSha: gitBlobSha("v1") }); // v2
    await store.remove("a.md", actor); // v3 tombstone (files row deleted)
    await store.write("a.md", "again", actor); // must be v4, NOT v1
    const versions = (await repos(db).versions.find({ path: "a.md" })).map((v) => v.version).sort((x, y) => x - y);
    expect(versions).toEqual([1, 2, 3, 4]);
    expect(new Set(versions).size).toBe(4); // no duplicate version numbers
  });

  it("concurrent saves off the same baseSha: one wins, the other ConflictErrors (no silent clobber, no duplicate version)", async () => {
    const { sha } = await store.write("a.md", "base", actor); // v1

    // Both writers loaded the same baseSha and race. The optimistic-concurrency
    // check must NOT let both through (that would be a silent last-write-wins).
    const results = await Promise.allSettled([
      store.write("a.md", "A", { ...actor, baseSha: sha }),
      store.write("a.md", "B", { ...actor, baseSha: sha }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

    // Exactly one new version was appended (v2) — no duplicate version numbers.
    const versions = (await repos(db).versions.find({ path: "a.md" }))
      .map((v) => v.version)
      .sort((x, y) => x - y);
    expect(versions).toEqual([1, 2]);
  });

  it("ensureFilesSeeded populates files from the docs projection once", async () => {
    const r = repos(db);
    await r.docs.insert({
      path: "eng/x.md",
      spaceKey: "eng",
      title: "X",
      headings: [],
      body: "# X\n",
      blobSha: gitBlobSha("# X\n"),
      updatedAt: 1,
    });
    await ensureFilesSeeded(db);
    expect((await store.read("eng/x.md"))?.content).toBe("# X\n");
    // idempotent: a second call doesn't duplicate
    await ensureFilesSeeded(db);
    expect(await r.files.count()).toBe(1);
  });
});
