import { beforeEach, describe, expect, it } from "vitest";

import { MemoryDatabase } from "../lib/db/memory";
import type { Database } from "../lib/db/types";
import { MemoryGitStore } from "../lib/git/memory";
import { indexAll, isTrashPath, TRASH_PREFIX } from "../lib/git/indexer";
import { trashDoc, restoreDoc, deleteDoc, moveDoc, migrateDocAttachments } from "../lib/git/save";
import { repos } from "../lib/repos";
import { canAccess, type Grant, type Principal } from "../lib/permissions";

const SEED = {
  "eng/oncall.md": "# On-call\n\nEscalation steps.\n",
  "readme.md": "# Readme\n",
};

const actor = { authorName: "t", authorEmail: "t@example.com" };

describe("isTrashPath", () => {
  it("matches the trash prefix only", () => {
    expect(isTrashPath(`${TRASH_PREFIX}eng/oncall.md`)).toBe(true);
    expect(isTrashPath("eng/oncall.md")).toBe(false);
  });
});

describe("trash / restore", () => {
  let db: Database;
  let store: MemoryGitStore;
  beforeEach(async () => {
    db = new MemoryDatabase();
    store = new MemoryGitStore(SEED);
    await indexAll(db, store);
  });

  it("trash removes the doc from the index but keeps it in the store", async () => {
    await trashDoc(db, store, { path: "eng/oncall.md", ...actor });
    // gone from the index (all DB-driven views)
    expect(await repos(db).docs.findOne({ path: "eng/oncall.md" })).toBeNull();
    // still present in Git, under the trash prefix
    const trashPath = `${TRASH_PREFIX}eng/oncall.md`;
    expect(await store.read(trashPath)).not.toBeNull();
    expect(await store.read("eng/oncall.md")).toBeNull();
  });

  it("a full re-index never surfaces trashed docs", async () => {
    await trashDoc(db, store, { path: "eng/oncall.md", ...actor });
    await indexAll(db, store);
    expect((await repos(db).docs.find()).map((d) => d.path).sort()).toEqual(["readme.md"]);
  });

  it("restore brings the doc back to its original path, losslessly", async () => {
    const original = (await store.read("eng/oncall.md"))!.content;
    await trashDoc(db, store, { path: "eng/oncall.md", ...actor });
    const res = await restoreDoc(db, store, { trashPath: `${TRASH_PREFIX}eng/oncall.md`, ...actor });
    expect(res?.path).toBe("eng/oncall.md");
    expect((await store.read("eng/oncall.md"))!.content).toBe(original);
    expect(await store.read(`${TRASH_PREFIX}eng/oncall.md`)).toBeNull();
    expect(await repos(db).docs.findOne({ path: "eng/oncall.md" })).not.toBeNull();
  });

  it("purge hard-removes the trashed file", async () => {
    await trashDoc(db, store, { path: "eng/oncall.md", ...actor });
    await deleteDoc(db, store, { path: `${TRASH_PREFIX}eng/oncall.md`, ...actor });
    expect(await store.read(`${TRASH_PREFIX}eng/oncall.md`)).toBeNull();
  });

  it("migrateDocAttachments re-keys a doc-scoped deny grant so it STILL applies after a rename", async () => {
    const r = repos(db);
    const principal: Principal = { email: "contractor@example.com", role: "read", groupKeys: [] };
    // Space grants everyone read; a doc-scoped deny hides eng/oncall.md from the user.
    const grant: Grant = {
      subjectType: "user",
      subjectId: "contractor@example.com",
      resourceType: "doc",
      resourcePath: "eng/oncall.md",
      capability: "read",
      effect: "deny",
    };
    await r.grants.insert({ ...grant, createdAt: 1 });
    const policy = { defaultRole: "read" as const };

    // Before the move: the deny matches the doc → access denied.
    const gBefore = await r.grants.find();
    expect(
      canAccess(principal, { type: "doc", path: "eng/oncall.md", spaceKey: "eng" }, "read", gBefore, policy)
        .allowed,
    ).toBe(false);

    // Rename the doc and migrate its attachments (incl. the grant).
    await moveDoc(db, store, { fromPath: "eng/oncall.md", toPath: "eng/oncall-v2.md", ...actor });
    await migrateDocAttachments(db, "eng/oncall.md", "eng/oncall-v2.md");

    // The grant followed the doc: still denied at the new path (no leak), and the
    // stale old path no longer carries a dangling grant.
    const gAfter = await r.grants.find();
    expect(gAfter.map((x) => x.resourcePath)).toEqual(["eng/oncall-v2.md"]);
    expect(
      canAccess(principal, { type: "doc", path: "eng/oncall-v2.md", spaceKey: "eng" }, "read", gAfter, policy)
        .allowed,
    ).toBe(false);
  });

  it("move relocates the doc + re-indexes under the new path/space", async () => {
    const before = (await store.read("eng/oncall.md"))!.content;
    const res = await moveDoc(db, store, { fromPath: "eng/oncall.md", toPath: "ops/oncall.md", ...actor });
    expect(res?.path).toBe("ops/oncall.md");
    expect(await store.read("eng/oncall.md")).toBeNull();
    expect((await store.read("ops/oncall.md"))!.content).toBe(before);
    const moved = await repos(db).docs.findOne({ path: "ops/oncall.md" });
    expect(moved?.spaceKey).toBe("ops");
    expect(await repos(db).docs.findOne({ path: "eng/oncall.md" })).toBeNull();
  });
});
