import { describe, expect, it } from "vitest";

import { chunkMarkdown, type Chunk } from "../lib/rag/chunker";
import {
  embed,
  embeddingProvider,
  EMBED_DIM,
  type EmbeddingsEnv,
} from "../lib/rag/embeddings";
import {
  MemoryVectorIndex,
  cosineSimilarity,
} from "../lib/rag/retrieval";

// ---------------------------------------------------------------------------
// chunker
// ---------------------------------------------------------------------------

const DOC = `# Guide

Intro paragraph before any subheading explaining the overall purpose.

## Setup

Install the package and configure the environment variables before you begin.

### Keys

Set the VOYAGE_API_KEY value so the embeddings provider can authenticate calls.

## Usage

Call the function with your input and read the returned vectors from the result.
`;

describe("chunkMarkdown — structure-aware splitting", () => {
  it("splits a multi-heading doc and carries the heading trail", () => {
    const chunks = chunkMarkdown("guide.md", DOC, { spaceKey: "docs" });
    expect(chunks.length).toBeGreaterThan(1);

    const paths = chunks.map((c) => c.headingPath);
    expect(paths).toContain("Guide"); // intro text under the H1
    expect(paths).toContain("Guide > Setup");
    expect(paths).toContain("Guide > Setup > Keys"); // nested breadcrumb
    expect(paths).toContain("Guide > Usage");

    for (const c of chunks) {
      expect(c.path).toBe("guide.md");
      expect(c.spaceKey).toBe("docs");
    }
  });

  it("tags content before the first heading with an empty heading path", () => {
    const withPreamble = "Some intro prose with no heading yet.\n\n# Body\n\nThe body.\n";
    const chunks = chunkMarkdown("p.md", withPreamble);
    expect(chunks[0].headingPath).toBe(""); // preamble
    expect(chunks.some((c) => c.headingPath === "Body")).toBe(true);
  });

  it("text equals the exact source slice (offsets are load-bearing)", () => {
    const chunks = chunkMarkdown("guide.md", DOC);
    for (const c of chunks) {
      expect(DOC.slice(c.charStart, c.charEnd)).toBe(c.text);
      expect(c.charEnd).toBeGreaterThan(c.charStart);
    }
  });

  it("respects the configured window size", () => {
    const long =
      "# Title\n\n" + Array.from({ length: 60 }, (_, i) => `Sentence number ${i} here.`).join(" ");
    const size = 200;
    const chunks = chunkMarkdown("long.md", long, { chunkSize: size, overlap: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(size);
    }
  });

  it("packs adjacent windows with overlap", () => {
    const long = "# T\n\n" + "word ".repeat(400);
    const overlap = 50;
    const chunks = chunkMarkdown("ov.md", long, { chunkSize: 300, overlap });
    // Same heading section → consecutive windows should overlap in source offsets.
    const sameSection = chunks.filter((c) => c.headingPath === "T");
    expect(sameSection.length).toBeGreaterThan(1);
    for (let i = 1; i < sameSection.length; i++) {
      expect(sameSection[i].charStart).toBeLessThan(sameSection[i - 1].charEnd);
    }
  });

  it("is deterministic — same input yields identical chunks", () => {
    const a = chunkMarkdown("guide.md", DOC, { spaceKey: "docs" });
    const b = chunkMarkdown("guide.md", DOC, { spaceKey: "docs" });
    expect(a).toEqual(b);
  });

  it("returns no chunks for empty/whitespace content", () => {
    expect(chunkMarkdown("e.md", "")).toEqual<Chunk[]>([]);
    expect(chunkMarkdown("e.md", "   \n\n  ")).toEqual<Chunk[]>([]);
  });
});

// ---------------------------------------------------------------------------
// embeddings — local deterministic provider
// ---------------------------------------------------------------------------

describe("local embedder", () => {
  it("is deterministic, correct dim, and L2-normalized", async () => {
    const [v1] = await embed(["the quick brown fox"], { provider: "local" });
    const [v2] = await embed(["the quick brown fox"], { provider: "local" });
    expect(v1).toEqual(v2); // deterministic
    expect(v1).toHaveLength(EMBED_DIM.local);

    const norm = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6); // unit length
  });

  it("scores similar texts higher than dissimilar ones", async () => {
    const [a, b, c] = await embed(
      [
        "database migration and schema versioning strategy",
        "schema migration and database versioning approach",
        "the weather forecast predicts heavy rain tomorrow",
      ],
      { provider: "local" },
    );
    const simRelated = cosineSimilarity(a, b);
    const simUnrelated = cosineSimilarity(a, c);
    expect(simRelated).toBeGreaterThan(simUnrelated);
  });

  it("returns [] for an empty batch", async () => {
    expect(await embed([], { provider: "local" })).toEqual([]);
  });
});

describe("embeddingProvider — env selection", () => {
  it("defaults to local with no keys set", () => {
    expect(embeddingProvider({})).toBe("local");
  });

  it("selects voyage when its key is present", () => {
    const env: EmbeddingsEnv = { EMBEDDINGS_PROVIDER: "voyage", VOYAGE_API_KEY: "k" };
    expect(embeddingProvider(env)).toBe("voyage");
  });

  it("falls back to local when the requested provider has no key", () => {
    expect(embeddingProvider({ EMBEDDINGS_PROVIDER: "voyage" })).toBe("local");
  });

  it("auto-selects openai when only its key is present", () => {
    expect(embeddingProvider({ OPENAI_API_KEY: "k" })).toBe("openai");
  });
});

describe("embed — remote provider via injected fetch", () => {
  it("calls the Voyage endpoint and maps the response", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ?? "" });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      };
    };
    const out = await embed(["hello"], {
      provider: "voyage",
      env: { VOYAGE_API_KEY: "k", VOYAGE_MODEL: "voyage-3" },
      fetchImpl,
    });
    expect(out).toEqual([[0.1, 0.2, 0.3]]);
    expect(calls[0].url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(calls[0].body).toContain("voyage-3");
  });
});

// ---------------------------------------------------------------------------
// retrieval — MemoryVectorIndex
// ---------------------------------------------------------------------------

interface Meta {
  path: string;
  spaceKey: string;
  readable: boolean;
}

describe("MemoryVectorIndex", () => {
  const index = new MemoryVectorIndex<Meta>();
  index.upsert([
    { id: "a", vector: [1, 0, 0], meta: { path: "a.md", spaceKey: "s1", readable: true } },
    { id: "b", vector: [0, 1, 0], meta: { path: "b.md", spaceKey: "s1", readable: true } },
    { id: "c", vector: [0.9, 0.1, 0], meta: { path: "c.md", spaceKey: "s2", readable: false } },
  ]);

  it("returns nearest items by cosine similarity", () => {
    const hits = index.search([1, 0, 0], 2);
    expect(hits[0].id).toBe("a"); // exact match → score 1
    expect(hits[0].score).toBeCloseTo(1, 6);
    expect(hits[1].id).toBe("c"); // closest remaining direction
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("applies the filter predicate BEFORE top-K — no leak of unreadable items", () => {
    // "c" is the 2nd-nearest but is unreadable; the filter must exclude it entirely.
    const hits = index.search([1, 0, 0], 5, (m) => m.readable);
    const ids = hits.map((h) => h.id);
    expect(ids).not.toContain("c");
    expect(ids).toEqual(["a", "b"]);
  });

  it("upsert replaces by id rather than duplicating", () => {
    const idx = new MemoryVectorIndex<Meta>();
    idx.upsert([{ id: "x", vector: [1, 0], meta: { path: "x", spaceKey: "s", readable: true } }]);
    idx.upsert([{ id: "x", vector: [0, 1], meta: { path: "x", spaceKey: "s", readable: true } }]);
    expect(idx.size).toBe(1);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical, 0 for orthogonal, 0 for a zero vector", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("returns 0 on a dimension mismatch (different embedders) — no silent truncation", () => {
    // A 1024-dim query vector vs a 256-dim stored chunk vector must NOT score over
    // the shared prefix; that would be a meaningless (but positive) similarity.
    const long = Array.from({ length: 1024 }, () => 1);
    const short = Array.from({ length: 256 }, () => 1);
    expect(cosineSimilarity(long, short)).toBe(0);
    expect(cosineSimilarity(short, long)).toBe(0);
  });
});
