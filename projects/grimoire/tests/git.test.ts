import { beforeEach, describe, expect, it } from "vitest";

import { MemoryDatabase } from "../lib/db/memory";
import type { Database } from "../lib/db/types";
import { MemoryGitStore } from "../lib/git/memory";
import { ConflictError } from "../lib/git/types";
import { indexAll, indexPath, spaceKeyOf } from "../lib/git/indexer";
import { deleteDoc, saveDoc, uniqueAgainst } from "../lib/git/save";
import { gitBlobSha } from "../lib/git/sha";
import { repos } from "../lib/repos";

const SEED = {
  "eng/runbooks/oncall.md": "---\ntitle: On-call\n---\n\n# On-call\n\n## Escalation\n\nText.\n",
  "eng/adr/0001.md": "# ADR 1\n\nDecision.\n",
  "readme.md": "# Readme\n",
  "img/logo.png": "binary-not-indexed",
};

describe("uniqueAgainst (batch de-collision — C7)", () => {
  it("suffixes a path already claimed in the batch, before the extension", () => {
    const taken = new Set<string>();
    const a = uniqueAgainst("eng/weekly-update.md", taken);
    taken.add(a);
    const b = uniqueAgainst("eng/weekly-update.md", taken);
    taken.add(b);
    const c = uniqueAgainst("eng/weekly-update.md", taken);
    expect([a, b, c]).toEqual([
      "eng/weekly-update.md",
      "eng/weekly-update~1.md",
      "eng/weekly-update~2.md",
    ]);
  });

  it("leaves a non-colliding path untouched (idempotent re-runs overwrite by path)", () => {
    expect(uniqueAgainst("eng/a.md", new Set())).toBe("eng/a.md");
  });
});

describe("spaceKeyOf", () => {
  it("uses the top-level folder, else 'root'", () => {
    expect(spaceKeyOf("eng/runbooks/oncall.md")).toBe("eng");
    expect(spaceKeyOf("readme.md")).toBe("root");
  });
});

describe("indexAll", () => {
  let db: Database;
  let store: MemoryGitStore;
  beforeEach(async () => {
    db = new MemoryDatabase();
    store = new MemoryGitStore(SEED);
    await indexAll(db, store);
  });

  it("indexes only Markdown files", async () => {
    expect((await repos(db).docs.find()).map((d) => d.path).sort()).toEqual([
      "eng/adr/0001.md",
      "eng/runbooks/oncall.md",
      "readme.md",
    ]);
  });

  it("derives title from front-matter, then H1, then filename", async () => {
    const r = repos(db);
    expect((await r.docs.findOne({ path: "eng/runbooks/oncall.md" }))?.title).toBe("On-call");
    expect((await r.docs.findOne({ path: "eng/adr/0001.md" }))?.title).toBe("ADR 1");
  });

  it("captures headings and the canonical body + matching blob sha", async () => {
    const d = await repos(db).docs.findOne({ path: "eng/runbooks/oncall.md" });
    expect(d?.headings).toContain("Escalation");
    expect(d?.blobSha).toBe(gitBlobSha(SEED["eng/runbooks/oncall.md"]));
  });

  it("creates Spaces from top-level folders", async () => {
    const keys = (await repos(db).spaces.find()).map((s) => s.key).sort();
    expect(keys).toEqual(["eng", "root"]);
  });

  it("prunes docs whose files were removed", async () => {
    await store.remove("eng/adr/0001.md", { message: "rm", authorName: "x", authorEmail: "x@example.com" });
    await indexAll(db, store);
    expect(await repos(db).docs.findOne({ path: "eng/adr/0001.md" })).toBeNull();
  });
});

describe("saveDoc — commit per change", () => {
  let db: Database;
  let store: MemoryGitStore;
  beforeEach(async () => {
    db = new MemoryDatabase();
    store = new MemoryGitStore(SEED);
    await indexAll(db, store);
  });

  it("commits authored as the user and re-indexes", async () => {
    const { doc } = await saveDoc(db, store, {
      path: "eng/adr/0002.md",
      content: "# ADR 2\n\nNew decision.\n",
      authorName: "Marc",
      authorEmail: "marc.bittner@example.com",
    });
    expect(doc.title).toBe("ADR 2");
    const last = store.commits().at(-1);
    expect(last).toMatchObject({ path: "eng/adr/0002.md", author: "marc.bittner@example.com", op: "write" });
  });

  it("canonicalizes content before committing (clean diffs)", async () => {
    await saveDoc(db, store, {
      path: "x.md",
      content: "# X\n\n* a\n* b\n", // '*' bullets
      authorName: "M",
      authorEmail: "m@example.com",
    });
    const f = await store.read("x.md");
    expect(f?.content).toContain("- a"); // normalized to '-'
    expect(f?.content).not.toContain("* a");
  });

  it("rejects a stale write with ConflictError (no silent clobber)", async () => {
    const f = await store.read("eng/adr/0001.md");
    // someone else commits first
    await saveDoc(db, store, { path: "eng/adr/0001.md", content: "# ADR 1\n\nEdited.\n", authorName: "A", authorEmail: "a@example.com" });
    // our write with the now-stale base sha must conflict
    await expect(
      saveDoc(db, store, {
        path: "eng/adr/0001.md",
        content: "# ADR 1\n\nMine.\n",
        authorName: "B",
        authorEmail: "b@example.com",
        baseSha: f?.sha,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("accepting a suggestion against a stale baseSha conflicts instead of clobbering (C4)", async () => {
    // A proposer captured this baseSha when they opened the doc.
    const proposalBaseSha = (await store.read("eng/adr/0001.md"))!.sha;

    // Meanwhile someone else saved a substantive edit to the doc.
    await saveDoc(db, store, {
      path: "eng/adr/0001.md",
      content: "# ADR 1\n\nImportant new decision.\n",
      authorName: "Editor",
      authorEmail: "editor@example.com",
    });

    // Accepting the suggestion re-applies its content WITH the stored baseSha, so
    // the intervening edit is protected: ConflictError, not a silent clobber.
    await expect(
      saveDoc(db, store, {
        path: "eng/adr/0001.md",
        content: "# ADR 1\n\nStale proposed content.\n",
        authorName: "Reviewer",
        authorEmail: "reviewer@example.com",
        baseSha: proposalBaseSha,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // The newer edit is still there — nothing was lost.
    expect((await store.read("eng/adr/0001.md"))!.content).toContain("Important new decision.");
  });

  it("deleteDoc commits a removal and drops the index entry", async () => {
    await deleteDoc(db, store, { path: "readme.md", authorName: "M", authorEmail: "m@example.com" });
    expect(await repos(db).docs.findOne({ path: "readme.md" })).toBeNull();
    expect(store.commits().at(-1)).toMatchObject({ path: "readme.md", op: "remove" });
  });

  it("indexPath removes the doc when the file is gone", async () => {
    await store.remove("readme.md", { message: "rm", authorName: "x", authorEmail: "x@example.com" });
    await indexPath(db, store, "readme.md");
    expect(await repos(db).docs.findOne({ path: "readme.md" })).toBeNull();
  });
});
