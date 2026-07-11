import { describe, expect, it, vi } from "vitest";

import { aiAssist } from "../lib/ai/actions";
import type { Provider } from "../lib/llm";

const probeNone = async () => false;
const probeAll = async () => true;

describe("aiAssist", () => {
  it("expand: falls back to a deterministic offline draft with no providers", async () => {
    const r = await aiAssist("expand", "deploy steps", { deps: { probe: probeNone } });
    expect(r.provider).toBe("offline");
    expect(r.text).toContain("deploy steps");
    expect(r.text).toContain("Offline draft");
  });

  it("uses the model output when a provider is available", async () => {
    const caller = vi.fn(async () => "## Deploy\n\n1. build\n2. ship\n");
    const r = await aiAssist("expand", "deploy steps", {
      deps: { probe: probeAll, caller },
    });
    expect(r.provider).toBe("anthropic"); // first in the chain
    expect(r.text).toContain("Deploy");
    expect(caller).toHaveBeenCalledOnce();
  });

  it("sends a kind-specific prompt to the provider", async () => {
    const seen: string[] = [];
    const caller = async (_p: Provider, _m: string, args: { prompt: string }) => {
      seen.push(args.prompt);
      return "ok";
    };
    await aiAssist("proofread", "teh cat", { deps: { probe: probeAll, caller } });
    await aiAssist("prose_to_markdown", "a title then bullets", { deps: { probe: probeAll, caller } });
    expect(seen[0]).toContain("Proofread");
    expect(seen[1]).toContain("Markdown");
  });

  it("proofread offline is an honest no-op (returns input unchanged)", async () => {
    const r = await aiAssist("proofread", "unchanged text", { deps: { probe: probeNone } });
    expect(r.text).toBe("unchanged text");
  });

  it("draft offline scaffolds from the first line as a title", async () => {
    const r = await aiAssist("draft", "Runbook: oncall\nmore", { deps: { probe: probeNone } });
    expect(r.text).toContain("# Runbook: oncall");
  });
});
