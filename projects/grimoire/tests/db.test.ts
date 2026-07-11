import { beforeEach, describe, expect, it } from "vitest";

import { MemoryDatabase } from "../lib/db/memory";
import type { Database } from "../lib/db/types";

// Contract tests for the persistence adapter, run against the in-memory impl.
// The Mongo impl satisfies the same Collection<T> contract (verified live against
// Atlas in the smoke script), so business logic is identical on either store.

interface DocRow {
  _id?: string;
  path: string;
  title: string;
  spaceKey: string;
}

describe("Database/Collection contract (MemoryDatabase)", () => {
  let db: Database;
  beforeEach(() => {
    db = new MemoryDatabase();
  });

  it("insert assigns an id and returns the row", async () => {
    const docs = db.collection<DocRow>("docs");
    const row = await docs.insert({ path: "a.md", title: "A", spaceKey: "eng" });
    expect(row._id).toBeTruthy();
    expect(row.title).toBe("A");
  });

  it("findOne / find filter by equality", async () => {
    const docs = db.collection<DocRow>("docs");
    await docs.insert({ path: "a.md", title: "A", spaceKey: "eng" });
    await docs.insert({ path: "b.md", title: "B", spaceKey: "eng" });
    await docs.insert({ path: "c.md", title: "C", spaceKey: "ops" });
    expect((await docs.findOne({ path: "b.md" }))?.title).toBe("B");
    expect(await docs.find({ spaceKey: "eng" })).toHaveLength(2);
    expect(await docs.find()).toHaveLength(3);
  });

  it("findOne with a sort returns the extreme matching row", async () => {
    const vers = db.collection<{ _id?: string; path: string; version: number }>("versions");
    await vers.insert({ path: "a.md", version: 1 });
    await vers.insert({ path: "a.md", version: 3 });
    await vers.insert({ path: "a.md", version: 2 });
    await vers.insert({ path: "b.md", version: 9 });
    // Highest version for a.md, ignoring the unrelated b.md row.
    expect((await vers.findOne({ path: "a.md" }, { sort: { version: -1 } }))?.version).toBe(3);
    expect((await vers.findOne({ path: "a.md" }, { sort: { version: 1 } }))?.version).toBe(1);
    // No match → null even with a sort.
    expect(await vers.findOne({ path: "z.md" }, { sort: { version: -1 } })).toBeNull();
  });

  it("update patches matching rows", async () => {
    const docs = db.collection<DocRow>("docs");
    await docs.insert({ path: "a.md", title: "A", spaceKey: "eng" });
    const n = await docs.update({ path: "a.md" }, { title: "A2" });
    expect(n).toBe(1);
    expect((await docs.findOne({ path: "a.md" }))?.title).toBe("A2");
  });

  it("upsert inserts then patches by the same filter", async () => {
    const docs = db.collection<DocRow>("docs");
    await docs.upsert({ path: "x.md" }, { path: "x.md", title: "X", spaceKey: "eng" });
    expect(await docs.count()).toBe(1);
    await docs.upsert({ path: "x.md" }, { path: "x.md", title: "X2", spaceKey: "eng" });
    expect(await docs.count()).toBe(1);
    expect((await docs.findOne({ path: "x.md" }))?.title).toBe("X2");
  });

  it("delete removes matches and returns the count", async () => {
    const docs = db.collection<DocRow>("docs");
    await docs.insert({ path: "a.md", title: "A", spaceKey: "eng" });
    await docs.insert({ path: "b.md", title: "B", spaceKey: "eng" });
    expect(await docs.delete({ spaceKey: "eng" })).toBe(2);
    expect(await docs.count()).toBe(0);
  });

  it("findProjected returns only the listed fields (plus _id)", async () => {
    interface Big { _id?: string; path: string; title: string; spaceKey: string; body: string }
    const docs = db.collection<Big>("docs");
    await docs.insert({ path: "a.md", title: "A", spaceKey: "eng", body: "huge".repeat(1000) });
    const rows = await docs.findProjected({ spaceKey: "eng" }, ["path", "title", "spaceKey"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe("a.md");
    expect(rows[0].title).toBe("A");
    expect(rows[0].spaceKey).toBe("eng");
    expect(rows[0].body).toBeUndefined(); // large column left behind
  });

  it("collections are isolated by name", async () => {
    await db.collection<DocRow>("docs").insert({ path: "a.md", title: "A", spaceKey: "eng" });
    expect(await db.collection<DocRow>("users").count()).toBe(0);
  });
});
