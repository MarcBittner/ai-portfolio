import { describe, expect, it, vi } from "vitest";

import { categorizeDoc } from "../lib/ai/categorize";
import { upsertFrontmatter, frontmatter } from "../lib/markdown";

const probeNone = async () => false;
const probeAll = async () => true;

const SPACES = ["engineering", "onboarding", "product", "reference"];

describe("categorizeDoc", () => {
  it("offline: heuristic picks a candidate space and derives tags/summary", async () => {
    const doc = {
      title: "Engineering deploy runbook",
      content:
        "# Engineering deploy runbook\n\nThis engineering guide covers deploys.\n\n## Build step\n\n## Rollback\n",
      spaces: SPACES,
    };
    const r = await categorizeDoc(doc, { deps: { probe: probeNone } });
    expect(r.provider).toBe("offline");
    expect(SPACES).toContain(r.spaceKey);
    expect(r.spaceKey).toBe("engineering"); // "engineering" appears most
    expect(r.tags).toContain("build-step");
    expect(r.summary.length).toBeGreaterThan(0);
  });

  it("uses validated model JSON when a provider is available", async () => {
    const caller = vi.fn(async () =>
      '{"spaceKey":"product","docType":"spec","tags":["Billing","Invoices"],"summary":"How billing works."}',
    );
    const r = await categorizeDoc(
      { title: "Billing", content: "## Invoices\ncontent", spaces: SPACES },
      { deps: { probe: probeAll, caller } },
    );
    expect(r.provider).toBe("anthropic");
    expect(r.spaceKey).toBe("product");
    expect(r.docType).toBe("spec");
    expect(r.tags).toEqual(["billing", "invoices"]); // slugified/lowercased
    expect(r.summary).toBe("How billing works.");
  });

  it("rejects a hallucinated space not in the candidate set", async () => {
    const caller = async () =>
      '{"spaceKey":"finance","docType":"guide","tags":["x"],"summary":"y"}';
    const r = await categorizeDoc(
      { title: "Onboarding orientation", content: "onboarding onboarding", spaces: SPACES },
      { deps: { probe: probeAll, caller } },
    );
    expect(SPACES).toContain(r.spaceKey); // falls back to heuristic, not "finance"
    expect(r.spaceKey).not.toBe("finance");
  });

  it("survives non-JSON model output by falling back to the heuristic", async () => {
    const caller = async () => "Sure! I think this belongs in engineering.";
    const r = await categorizeDoc(
      { title: "T", content: "engineering", spaces: SPACES },
      { deps: { probe: probeAll, caller } },
    );
    expect(SPACES).toContain(r.spaceKey);
  });
});

describe("upsertFrontmatter", () => {
  it("creates a block when none exists", () => {
    const out = upsertFrontmatter("# Title\n\nBody", { status: "imported", tags: ["a", "b"] });
    expect(out.startsWith("---\n")).toBe(true);
    const fm = frontmatter(out);
    expect(fm.status).toBe("imported");
    expect(fm.tags).toContain("a");
  });

  it("never overwrites an existing key", () => {
    const src = "---\nstatus: published\n---\n\nBody";
    const out = upsertFrontmatter(src, { status: "imported", summary: "s" });
    const fm = frontmatter(out);
    expect(fm.status).toBe("published"); // preserved
    expect(fm.summary).toBe("s"); // added
  });

  it("skips empty values", () => {
    const out = upsertFrontmatter("Body", { summary: "", tags: [] });
    expect(out).toBe("Body");
  });
});
