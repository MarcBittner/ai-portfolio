import { describe, it, expect, vi } from "vitest";
import {
  askAi,
  deterministicAnswer,
  providerAvailable,
  CHAIN,
  type AiRouterDeps,
  type ProviderFn,
} from "../lib/aiRouter.ts";

// aiRouter is pure over injected deps (mirrors lib/aiTriage.ts): we override the
// config resolution and each provider fn, so no env keys / network are needed.
// These cover the chain order + fallthrough, explicit provider selection, the
// deterministic map, and the flag-off behaviour (enforced at the route layer).

// A provider that always succeeds with a labelled answer.
const okProvider =
  (label: string): ProviderFn =>
  async () =>
    `answer from ${label}`;

// A provider that always fails (triggers failover).
const failProvider =
  (why: string): ProviderFn =>
  async () => {
    throw new Error(why);
  };

// Config resolver stub: pick the start provider; models/url are irrelevant here.
type StartProvider = "auto" | "anthropic" | "openai" | "ollama" | "free" | "deterministic";
function cfg(provider: StartProvider): AiRouterDeps["resolveConfig"] {
  return async () => ({ provider, model: "", ollamaUrl: "http://localhost:11434" });
}

describe("askAi — chain order + fallthrough", () => {
  it("auto: uses the first provider that succeeds (anthropic)", async () => {
    const deps: AiRouterDeps = {
      resolveConfig: cfg("auto"),
      providers: {
        anthropic: okProvider("anthropic"),
        openai: okProvider("openai"),
      },
    };
    const r = await askAi({ question: "hi" }, deps);
    expect(r.provider).toBe("anthropic");
    expect(r.answer).toBe("answer from anthropic");
    expect(r.fellBackFrom).toBeUndefined();
  });

  it("auto: falls through anthropic->openai->ollama->free->deterministic to the end", async () => {
    const deps: AiRouterDeps = {
      resolveConfig: cfg("auto"),
      providers: {
        anthropic: failProvider("anthropic boom"),
        openai: failProvider("openai boom"),
        ollama: failProvider("ollama boom"),
        free: failProvider("free boom"),
        // deterministic left as the real terminal fallback (never throws)
      },
    };
    const r = await askAi({ question: "how do backups work?" }, deps);
    expect(r.provider).toBe("deterministic");
    // every earlier provider was recorded as a failover, in chain order
    expect(r.fellBackFrom).toHaveLength(4);
    expect(r.fellBackFrom).toEqual([
      "anthropic: anthropic boom",
      "openai: openai boom",
      "ollama: ollama boom",
      "free: free boom",
    ]);
    // and the deterministic map actually answered the backups question
    expect(r.answer.toLowerCase()).toContain("snapshot");
  });

  it("auto: stops at the first mid-chain success (ollama) and records prior failovers", async () => {
    const deps: AiRouterDeps = {
      resolveConfig: cfg("auto"),
      providers: {
        anthropic: failProvider("no key"),
        openai: failProvider("no key"),
        ollama: okProvider("ollama"),
        free: okProvider("free"),
      },
    };
    const r = await askAi({ question: "hi" }, deps);
    expect(r.provider).toBe("ollama");
    expect(r.fellBackFrom).toEqual(["anthropic: no key", "openai: no key"]);
  });
});

describe("askAi — explicit provider selection honours the start point", () => {
  it("explicit openai skips anthropic and starts at openai", async () => {
    const deps: AiRouterDeps = {
      resolveConfig: cfg("openai"),
      providers: {
        anthropic: okProvider("anthropic"), // must NOT be used
        openai: okProvider("openai"),
      },
    };
    const r = await askAi({ question: "hi" }, deps);
    expect(r.provider).toBe("openai");
    expect(r.fellBackFrom).toBeUndefined();
  });

  it("explicit openai still falls through the remainder on failure", async () => {
    const deps: AiRouterDeps = {
      resolveConfig: cfg("openai"),
      providers: {
        anthropic: okProvider("anthropic"), // skipped — before the start point
        openai: failProvider("openai down"),
        ollama: okProvider("ollama"),
      },
    };
    const r = await askAi({ question: "hi" }, deps);
    expect(r.provider).toBe("ollama");
    expect(r.fellBackFrom).toEqual(["openai: openai down"]);
  });

  it("an arg-level provider overrides the configured start point", async () => {
    const deps: AiRouterDeps = {
      resolveConfig: cfg("auto"),
      providers: { ollama: okProvider("ollama") },
    };
    const r = await askAi({ question: "hi", provider: "ollama" }, deps);
    expect(r.provider).toBe("ollama");
  });

  it("explicit deterministic answers immediately from the map", async () => {
    const deps: AiRouterDeps = {
      resolveConfig: cfg("deterministic"),
      providers: {
        anthropic: okProvider("anthropic"), // never reached
      },
    };
    const r = await askAi({ question: "tell me about drift and sync" }, deps);
    expect(r.provider).toBe("deterministic");
    expect(r.answer.toLowerCase()).toContain("outofsync");
  });
});

describe("askAi — real providers are skipped cleanly when unconfigured", () => {
  it("with no keys + unreachable providers, auto still returns a deterministic answer", async () => {
    // No injected providers → real ones run. Empty env → anthropic/openai/free are
    // 'not configured'; ollama attempts a real fetch which we stub to fail.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));
    try {
      const r = await askAi(
        { question: "what is the queue?" },
        { resolveConfig: cfg("auto"), env: {} as NodeJS.ProcessEnv },
      );
      expect(r.provider).toBe("deterministic");
      expect(r.fellBackFrom).toEqual([
        "anthropic: not configured",
        "openai: not configured",
        expect.stringContaining("ollama:"),
        "free: not configured",
      ]);
      expect(r.answer.toLowerCase()).toContain("dead-letter");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("ollama routing config — URL + model actually reach the daemon", () => {
  it("POSTs to the resolved base URL /api/chat with the resolved model", async () => {
    // A blank config model + no OLLAMA_MODEL → the shipped default llama3.1:8b; the
    // configured ollamaUrl is normalized (trailing slash trimmed) and hit at /api/chat.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: { content: "hi from ollama" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const r = await askAi(
        { question: "what is drift?" },
        {
          resolveConfig: async () => ({
            provider: "ollama",
            model: "",
            ollamaUrl: "http://my-ollama:11434/",
          }),
          env: {} as NodeJS.ProcessEnv,
        },
      );
      expect(r.provider).toBe("ollama");
      expect(r.answer).toBe("hi from ollama");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://my-ollama:11434/api/chat");
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("llama3.1:8b");
      expect(body.stream).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("honors OLLAMA_MODEL from env when the config model is blank", async () => {
    const prev = process.env.OLLAMA_MODEL;
    process.env.OLLAMA_MODEL = "mistral:7b";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: { content: "ok" } }), { status: 200 }),
    );
    try {
      await askAi(
        { question: "hi" },
        {
          resolveConfig: async () => ({ provider: "ollama", model: "", ollamaUrl: "http://localhost:11434" }),
          env: {} as NodeJS.ProcessEnv,
        },
      );
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body)).model).toBe("mistral:7b");
    } finally {
      fetchSpy.mockRestore();
      if (prev === undefined) delete process.env.OLLAMA_MODEL;
      else process.env.OLLAMA_MODEL = prev;
    }
  });
});

describe("providerAvailable", () => {
  it("gates key-bearing providers on their env key; local ones are always available", () => {
    const env = { ANTHROPIC_API_KEY: "x" } as unknown as NodeJS.ProcessEnv;
    expect(providerAvailable("anthropic", env)).toBe(true);
    expect(providerAvailable("openai", env)).toBe(false);
    expect(providerAvailable("free", env)).toBe(false);
    expect(providerAvailable("ollama", env)).toBe(true);
    expect(providerAvailable("deterministic", env)).toBe(true);
  });
});

describe("deterministicAnswer — keyword map", () => {
  it("returns a sensible grounded answer for known keywords", () => {
    expect(deterministicAnswer("how do I provision a new instance?").toLowerCase()).toContain(
      "branch",
    );
    expect(deterministicAnswer("what does masking do to PII?").toLowerCase()).toContain("mask");
    expect(deterministicAnswer("explain share links").toLowerCase()).toContain("reviewer");
  });

  it("falls back to a general dashboard summary for an unknown question", () => {
    const a = deterministicAnswer("what is the meaning of life?");
    expect(a.toLowerCase()).toContain("flotilla");
  });
});

describe("chain shape", () => {
  it("is the exact ordered fallback chain, terminating at deterministic", () => {
    expect(CHAIN).toEqual(["anthropic", "openai", "ollama", "free", "deterministic"]);
  });
});
