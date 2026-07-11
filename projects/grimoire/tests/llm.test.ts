import { describe, expect, it, vi } from "vitest";

import { complete, status, type LLMEnv, type Provider } from "../lib/llm";

const offline = (p: string) => `OFFLINE: ${p}`;

// Probe that reports a fixed set of providers as available.
const probeOf = (available: Provider[]) => async (p: Provider) =>
  available.includes(p);

describe("complete — chain selection", () => {
  it("falls back to offline when nothing is available", async () => {
    const r = await complete(
      { prompt: "hi", offline },
      { env: {}, probe: probeOf([]) },
    );
    expect(r.provider).toBe("offline");
    expect(r.text).toBe("OFFLINE: hi");
    expect(r.fallbacks).toEqual(["anthropic", "openai", "ollama", "openrouter"]);
  });

  it("never rejects even if the offline function throws (degrades to empty text)", async () => {
    const throwingOffline = () => {
      throw new Error("offline blew up");
    };
    const r = await complete(
      { prompt: "hi", offline: throwingOffline },
      { env: {}, probe: probeOf([]) },
    );
    expect(r.provider).toBe("offline");
    expect(r.text).toBe("");
    expect(r.fallbacks).toEqual(["anthropic", "openai", "ollama", "openrouter"]);
  });

  it("picks the first available provider in chain order", async () => {
    const caller = vi.fn(async () => "hello from model");
    const r = await complete(
      { prompt: "hi", offline },
      { env: { OPENAI_API_KEY: "x" }, probe: probeOf(["openai", "openrouter"]), caller },
    );
    expect(r.provider).toBe("openai"); // openai precedes openrouter in the chain
    expect(r.fallbacks).toEqual(["anthropic"]); // anthropic skipped (unavailable)
    expect(caller).toHaveBeenCalledOnce();
  });

  it("anthropic wins when available (primary)", async () => {
    const r = await complete(
      { prompt: "hi", offline },
      {
        env: { ANTHROPIC_API_KEY: "x" } as LLMEnv,
        probe: probeOf(["anthropic", "openai"]),
        caller: async () => "claude says hi",
      },
    );
    expect(r.provider).toBe("anthropic");
    expect(r.fallbacks).toEqual([]);
  });
});

describe("complete — failure handling", () => {
  it("falls through a provider that throws", async () => {
    const caller = async (p: Provider) => {
      if (p === "anthropic") throw new Error("503");
      return "openai recovered";
    };
    const r = await complete(
      { prompt: "hi", offline },
      { probe: probeOf(["anthropic", "openai"]), caller },
    );
    expect(r.provider).toBe("openai");
    expect(r.fallbacks).toEqual(["anthropic"]); // tried then failed
  });

  it("treats an empty completion as a failure and falls through", async () => {
    const caller = async (p: Provider) => (p === "anthropic" ? "" : "real");
    const r = await complete(
      { prompt: "hi", offline },
      { probe: probeOf(["anthropic", "openai"]), caller },
    );
    expect(r.provider).toBe("openai");
  });

  it("records latency and a non-negative cost estimate", async () => {
    let t = 1000;
    const r = await complete(
      { prompt: "hi", offline },
      {
        probe: probeOf(["anthropic"]),
        caller: async () => "answer",
        now: () => (t += 50),
      },
    );
    expect(r.latencyMs).toBeGreaterThan(0);
    expect(r.costUsd).toBeGreaterThanOrEqual(0);
  });
});

describe("mode restricts the chain", () => {
  it("mode:free only tries openrouter", async () => {
    const caller = vi.fn(async () => "free model");
    const r = await complete(
      { prompt: "hi", mode: "free", offline },
      { probe: probeOf(["anthropic", "openrouter"]), caller },
    );
    expect(r.provider).toBe("openrouter");
    expect(r.fallbacks).toEqual([]); // anthropic isn't in the free chain at all
  });

  it("mode:offline goes straight to the deterministic path", async () => {
    const caller = vi.fn();
    const r = await complete(
      { prompt: "hi", mode: "offline", offline },
      { probe: probeOf(["anthropic"]), caller },
    );
    expect(r.provider).toBe("offline");
    expect(caller).not.toHaveBeenCalled();
  });
});

describe("status", () => {
  it("reports availability per provider", async () => {
    const s = await status({ probe: probeOf(["anthropic"]) });
    expect(s.providers.anthropic).toBe(true);
    expect(s.providers.openai).toBe(false);
    expect(s.offlineFallback).toBe(true);
  });
});
