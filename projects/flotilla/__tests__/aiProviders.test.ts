import { describe, it, expect } from "vitest";
import {
  probeCloudAiProviders,
  type CloudProviderProbe,
  type FetchLike,
} from "../lib/aiProviders.ts";

// probeCloudAiProviders is pure over an injected fetch + env (no network, no real
// keys). These cover: per-provider live / not_configured / unreachable / error,
// the always-live deterministic terminal, canonical chain ordering, and that a
// throwing fetch degrades to a status instead of blowing up the whole probe.

// A fetch stub that maps a URL substring → a canned response or a throw.
function stubFetch(routes: Record<string, { ok: boolean; status: number } | "throw">): FetchLike {
  return async (url) => {
    for (const [needle, res] of Object.entries(routes)) {
      if (url.includes(needle)) {
        if (res === "throw") throw new Error("network down");
        return res;
      }
    }
    throw new Error(`unexpected url ${url}`);
  };
}

const ALL_KEYS = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  OPENAI_API_KEY: "sk-openai-test",
  OPENROUTER_API_KEY: "sk-or-test",
} as unknown as NodeJS.ProcessEnv;

function byId(rows: CloudProviderProbe[], id: string): CloudProviderProbe {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

describe("probeCloudAiProviders — per-provider status", () => {
  it("all keys present + 200s ⇒ every cloud provider live", async () => {
    const fetchImpl = stubFetch({
      "api.anthropic.com": { ok: true, status: 200 },
      "api.openai.com": { ok: true, status: 200 },
      "openrouter.ai": { ok: true, status: 200 },
    });
    const rows = await probeCloudAiProviders(fetchImpl, ALL_KEYS);
    expect(byId(rows, "anthropic").status).toBe("live");
    expect(byId(rows, "openai").status).toBe("live");
    expect(byId(rows, "free").status).toBe("live");
    // deterministic is the local map — always live, never fetched.
    expect(byId(rows, "deterministic").status).toBe("live");
  });

  it("no keys ⇒ each key-bearing provider is not_configured (deterministic still live)", async () => {
    // Fetch must never be called when there's no key; make it throw to prove it.
    const fetchImpl = stubFetch({});
    const rows = await probeCloudAiProviders(fetchImpl, {} as NodeJS.ProcessEnv);
    expect(byId(rows, "anthropic").status).toBe("not_configured");
    expect(byId(rows, "openai").status).toBe("not_configured");
    expect(byId(rows, "free").status).toBe("not_configured");
    expect(byId(rows, "deterministic").status).toBe("live");
  });

  it("keyed but the request throws ⇒ unreachable (with a detail, never the key)", async () => {
    const fetchImpl = stubFetch({
      "api.anthropic.com": "throw",
      "api.openai.com": "throw",
      "openrouter.ai": "throw",
    });
    const rows = await probeCloudAiProviders(fetchImpl, ALL_KEYS);
    for (const id of ["anthropic", "openai", "free"]) {
      const row = byId(rows, id);
      expect(row.status).toBe("unreachable");
      expect(row.detail).toBeTruthy();
      expect(row.detail).not.toContain("sk-");
    }
  });

  it("keyed but a non-200 ⇒ error with the HTTP status as detail (e.g. bad key → 401)", async () => {
    const fetchImpl = stubFetch({
      "api.anthropic.com": { ok: false, status: 401 },
      "api.openai.com": { ok: false, status: 500 },
      "openrouter.ai": { ok: false, status: 403 },
    });
    const rows = await probeCloudAiProviders(fetchImpl, ALL_KEYS);
    expect(byId(rows, "anthropic")).toMatchObject({ status: "error", detail: "HTTP 401" });
    expect(byId(rows, "openai")).toMatchObject({ status: "error", detail: "HTTP 500" });
    expect(byId(rows, "free")).toMatchObject({ status: "error", detail: "HTTP 403" });
  });

  it("mixed: one live, one missing key, one unreachable — each classified independently", async () => {
    const fetchImpl = stubFetch({
      "api.anthropic.com": { ok: true, status: 200 },
      "openrouter.ai": "throw",
    });
    const env = { ANTHROPIC_API_KEY: "sk-ant", OPENROUTER_API_KEY: "sk-or" } as unknown as NodeJS.ProcessEnv;
    const rows = await probeCloudAiProviders(fetchImpl, env);
    expect(byId(rows, "anthropic").status).toBe("live");
    expect(byId(rows, "openai").status).toBe("not_configured"); // no OPENAI_API_KEY
    expect(byId(rows, "free").status).toBe("unreachable");
  });
});

describe("probeCloudAiProviders — ordering + shape", () => {
  it("returns rows in canonical chain order with the Ollama slot (order 2) left as a gap", async () => {
    const fetchImpl = stubFetch({
      "api.anthropic.com": { ok: true, status: 200 },
      "api.openai.com": { ok: true, status: 200 },
      "openrouter.ai": { ok: true, status: 200 },
    });
    const rows = await probeCloudAiProviders(fetchImpl, ALL_KEYS);
    // Chain: anthropic 0, openai 1, [ollama 2 — client-side], free 3, deterministic 4.
    expect(rows.map((r) => r.id)).toEqual(["anthropic", "openai", "free", "deterministic"]);
    expect(rows.map((r) => r.order)).toEqual([0, 1, 3, 4]);
    // No ollama row — it's probed in the browser, never here.
    expect(rows.find((r) => (r.id as string) === "ollama")).toBeUndefined();
  });

  it("carries a human label for each provider", async () => {
    const rows = await probeCloudAiProviders(stubFetch({}), {} as NodeJS.ProcessEnv);
    expect(byId(rows, "anthropic").label).toBe("Anthropic");
    expect(byId(rows, "openai").label).toBe("OpenAI");
    expect(byId(rows, "free").label).toBe("OpenRouter (free tier)");
    expect(byId(rows, "deterministic").label).toBe("Deterministic (built-in)");
  });
});
