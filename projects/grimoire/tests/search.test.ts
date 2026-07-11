import { beforeEach, describe, expect, it } from "vitest";

import { MemoryDatabase } from "../lib/db/memory";
import type { Database } from "../lib/db/types";
import { MemoryGitStore } from "../lib/git/memory";
import { indexAll } from "../lib/git/indexer";
import { embed } from "../lib/rag/embeddings";
import { repos } from "../lib/repos";
import { searchReadable } from "../lib/search";
import type { Principal } from "../lib/permissions";

const SEED = {
  "eng/runbooks/oncall.md": "---\ntitle: On-call\n---\n\n# On-call\n\n## Escalation\n\nPage the lead, then the manager.\n",
  "eng/adr/0001.md": "# ADR 1\n\nWe chose MongoDB Atlas for persistence.\n",
};

const sup: Principal = { email: "s@example.com", role: "super", groupKeys: [] };
const reader: Principal = { email: "r@example.com", role: "read", groupKeys: [] };

describe("indexAll builds the chunk vector index", () => {
  let db: Database;
  beforeEach(async () => {
    db = new MemoryDatabase();
    await indexAll(db, new MemoryGitStore(SEED));
  });

  it("embeds chunks for every doc", async () => {
    const chunks = await repos(db).chunks.find();
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].vector.length).toBeGreaterThan(0);
  });
});

describe("searchReadable", () => {
  let db: Database;
  beforeEach(async () => {
    db = new MemoryDatabase();
    await indexAll(db, new MemoryGitStore(SEED));
  });

  it("returns a hit for a super admin", async () => {
    const res = await searchReadable(db, sup, "escalation");
    expect(res.map((r) => r.path)).toContain("eng/runbooks/oncall.md");
    // "escalation" is both a lexical hit and (via the local lexical embedder) a chunk
    // match, so the blended kind is "hybrid".
    expect(res[0].kind).toBe("hybrid");
  });

  it("permission-filters: a reader in a closed space gets nothing", async () => {
    // Curated content spaces default to public-read now; close `eng` explicitly to
    // exercise the permission filter's DENY path (a genuinely private space).
    await repos(db).spaces.update({ key: "eng" }, { defaultRole: "none" });
    expect(await searchReadable(db, reader, "escalation")).toHaveLength(0);
  });

  it("an open-space default lets the reader find it", async () => {
    await repos(db).spaces.update({ key: "eng" }, { defaultRole: "read" });
    const res = await searchReadable(db, reader, "Atlas");
    expect(res.map((r) => r.path)).toContain("eng/adr/0001.md");
  });

  it("empty query returns nothing", async () => {
    expect(await searchReadable(db, sup, "   ")).toHaveLength(0);
  });
});

// RRF hybrid fusion — built with controlled docs + chunks (not indexAll) so the keyword
// and semantic signals can be isolated: a chunk vector set to the query's own embedding
// is a guaranteed semantic hit regardless of lexical overlap, and a doc with no chunk is a
// pure keyword hit. This is what a real (meaning-aware) embedder buys us over the local
// lexical fallback — here we simulate it deterministically.
describe("searchReadable hybrid RRF ranking", () => {
  const QUERY = "quantum entanglement protocol";
  let db: Database;

  beforeEach(async () => {
    db = new MemoryDatabase();
    const r = repos(db);
    const [qv] = await embed([QUERY]);

    const doc = (path: string, title: string, body: string) =>
      r.docs.insert({
        path,
        spaceKey: "s",
        title,
        headings: [],
        body,
        blobSha: path,
        updatedAt: 0,
      });
    const chunk = (path: string, text: string, vector: number[]) =>
      r.chunks.insert({ path, spaceKey: "s", headingPath: "", charStart: 0, charEnd: text.length, text, vector });

    // Keyword-only: lexical phrase present, but NO chunk indexed → no semantic signal.
    await doc("s/keyword-only.md", "Runbook", "Our quantum entanglement protocol rollout runbook covers each step.");

    // Semantic-only: no lexical overlap with the query, but a chunk whose vector IS the
    // query embedding → a perfect cosine match.
    await doc("s/semantic-only.md", "Physics notes", "Spooky action links particle spins across great distance.");
    await chunk("s/semantic-only.md", "Spooky action links particle spins across great distance.", qv);

    // Both: lexical phrase present AND a semantically matching chunk → should win.
    await doc("s/both.md", "Design", "The quantum entanglement protocol underpins secure key exchange.");
    await chunk("s/both.md", "The quantum entanglement protocol underpins secure key exchange.", qv);
  });

  it("labels a lexical-only hit as keyword", async () => {
    const res = await searchReadable(db, sup, QUERY);
    const hit = res.find((x) => x.path === "s/keyword-only.md");
    expect(hit?.kind).toBe("keyword");
  });

  it("labels a semantic-only hit as semantic", async () => {
    const res = await searchReadable(db, sup, QUERY);
    const hit = res.find((x) => x.path === "s/semantic-only.md");
    expect(hit?.kind).toBe("semantic");
  });

  it("ranks a doc strong in BOTH signals above single-signal docs", async () => {
    const res = await searchReadable(db, sup, QUERY);
    expect(res[0].path).toBe("s/both.md");
    expect(res[0].kind).toBe("hybrid");
    const both = res.find((x) => x.path === "s/both.md")!;
    const kw = res.find((x) => x.path === "s/keyword-only.md")!;
    const sem = res.find((x) => x.path === "s/semantic-only.md")!;
    expect(both.score).toBeGreaterThan(kw.score);
    expect(both.score).toBeGreaterThan(sem.score);
  });
});
