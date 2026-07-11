import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryDatabase } from "../lib/db/memory";
import type { Database } from "../lib/db/types";
import { MemoryGitStore } from "../lib/git/memory";
import { indexAll } from "../lib/git/indexer";
import { askDocs } from "../lib/rag/ask";
import { repos } from "../lib/repos";
import type { Principal } from "../lib/permissions";

const SEED = {
  "eng/adr/0001.md": "# ADR 1\n\nWe chose MongoDB Atlas for persistence and the vector store.\n",
  "eng/runbooks/oncall.md": "# On-call\n\n## Escalation\n\nPage the lead, then the manager.\n",
};
const sup: Principal = { email: "s@example.com", role: "super", groupKeys: [] };
const reader: Principal = { email: "r@example.com", role: "read", groupKeys: [] };

describe("askDocs", () => {
  let db: Database;
  beforeEach(async () => {
    db = new MemoryDatabase();
    await indexAll(db, new MemoryGitStore(SEED));
  });

  it("offline: returns the relevant sources (no provider)", async () => {
    const res = await askDocs(db, sup, "what database do we use", { deps: { probe: async () => false } });
    expect(res.provider).toBe("offline");
    expect(res.sources.length).toBeGreaterThan(0);
    expect(res.sources.map((s) => s.path)).toContain("eng/adr/0001.md");
  });

  it("synthesizes an answer with a provider and passes context", async () => {
    const caller = vi.fn(async (_p, _m, args: { prompt: string }) => {
      expect(args.prompt).toContain("MongoDB Atlas"); // retrieved context is in the prompt
      return "We use **MongoDB Atlas** [1].";
    });
    const res = await askDocs(db, sup, "what database do we use", {
      deps: { probe: async () => true, caller },
    });
    expect(res.answer).toContain("MongoDB Atlas");
    expect(res.sources[0].n).toBe(1);
    expect(caller).toHaveBeenCalled();
  });

  it("permission-first: a reader in a closed space gets no sources/answer", async () => {
    // Curated spaces are public-read by default now; close `eng` explicitly so the
    // reader is genuinely outside the readable scope (the DENY path under test).
    await repos(db).spaces.update({ key: "eng" }, { defaultRole: "none" });
    const res = await askDocs(db, reader, "what database do we use", { deps: { probe: async () => false } });
    expect(res.sources).toHaveLength(0);
    expect(res.answer).toContain("couldn’t find");
  });
});
