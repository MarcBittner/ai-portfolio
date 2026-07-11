import { describe, it, expect } from "vitest";
import {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_SETUP_STEPS,
  isOllamaSetupStep,
  isValidModelTag,
  ollamaBinaryAvailable,
  ollamaSetupCommands,
  resolveOllamaBaseUrl,
  resolveOllamaModel,
  runOllamaSetupStep,
  type ExecFileLike,
} from "../lib/ollamaSetup.ts";

// lib/ollamaSetup is pure over an injected execFile — no processes are spawned.
// Covered: the model/URL resolvers (config ?? OLLAMA_MODEL env ?? default), the tag
// validator (injection guard), the FIXED command allowlist (no arbitrary command /
// argv), the "binary not here → not_available, never crash" fallback, and that the
// only variable argv (the model) is charset-checked before `ollama pull`.

// A fake execFile that records the argv it was called with and replies per a rule.
function fakeExec(rule: {
  version?: (Error & { code?: number }) | null; // for `ollama --version`
  run?: { err?: (Error & { code?: number }) | null; stdout?: string; stderr?: string };
  calls?: { cmd: string; args: string[] }[];
}): ExecFileLike {
  return (cmd, args, _opts, cb) => {
    rule.calls?.push({ cmd, args });
    if (args[0] === "--version") {
      cb(rule.version ?? null, "ollama version 0.0.0", "");
      return;
    }
    const r = rule.run ?? {};
    cb(r.err ?? null, r.stdout ?? "", r.stderr ?? "");
  };
}

describe("resolveOllamaModel — config ?? OLLAMA_MODEL ?? default", () => {
  it("uses the explicit config model when set", () => {
    expect(resolveOllamaModel("mistral:7b", {} as NodeJS.ProcessEnv)).toBe("mistral:7b");
  });
  it("falls back to OLLAMA_MODEL env when config is blank", () => {
    expect(resolveOllamaModel("", { OLLAMA_MODEL: "phi3" } as unknown as NodeJS.ProcessEnv)).toBe("phi3");
    expect(resolveOllamaModel(undefined, { OLLAMA_MODEL: "phi3" } as unknown as NodeJS.ProcessEnv)).toBe("phi3");
  });
  it("falls back to the shipped default when neither is set", () => {
    expect(resolveOllamaModel("", {} as NodeJS.ProcessEnv)).toBe(OLLAMA_DEFAULT_MODEL);
    expect(resolveOllamaModel("   ", {} as NodeJS.ProcessEnv)).toBe(OLLAMA_DEFAULT_MODEL);
  });
});

describe("resolveOllamaBaseUrl", () => {
  it("trims a trailing slash and defaults when blank", () => {
    expect(resolveOllamaBaseUrl("http://host:11434/")).toBe("http://host:11434");
    expect(resolveOllamaBaseUrl("")).toBe(OLLAMA_DEFAULT_BASE_URL);
    expect(resolveOllamaBaseUrl(undefined)).toBe(OLLAMA_DEFAULT_BASE_URL);
  });
});

describe("isValidModelTag — the injection guard", () => {
  it("accepts real ollama tags", () => {
    for (const t of ["llama3.1:8b", "mistral", "library/llama3:latest", "phi3.5:3.8b"]) {
      expect(isValidModelTag(t)).toBe(true);
    }
  });
  it("rejects anything with a shell metachar / space / empty", () => {
    for (const t of ["", "llama; rm -rf /", "a b", "$(whoami)", "m|n", "a`b`", "x&y"]) {
      expect(isValidModelTag(t)).toBe(false);
    }
  });
});

describe("setup step allowlist", () => {
  it("only serve + pull are valid steps", () => {
    expect(OLLAMA_SETUP_STEPS).toEqual(["serve", "pull"]);
    expect(isOllamaSetupStep("serve")).toBe(true);
    expect(isOllamaSetupStep("pull")).toBe(true);
    // Never a runnable install (no piping a remote script to a shell on a click).
    expect(isOllamaSetupStep("install")).toBe(false);
    expect(isOllamaSetupStep("rm")).toBe(false);
    expect(isOllamaSetupStep("")).toBe(false);
    expect(isOllamaSetupStep(42)).toBe(false);
  });
});

describe("ollamaSetupCommands — the copy-able fallback", () => {
  it("shows install/serve/pull with the resolved model in pull", () => {
    const c = ollamaSetupCommands("llama3.1:8b");
    expect(c.install).toBe("curl -fsSL https://ollama.com/install.sh | sh");
    expect(c.serve).toBe("ollama serve");
    expect(c.pull).toBe("ollama pull llama3.1:8b");
  });
});

describe("ollamaBinaryAvailable", () => {
  it("true when `ollama --version` exits 0", async () => {
    expect(await ollamaBinaryAvailable(fakeExec({ version: null }))).toBe(true);
  });
  it("false when the binary is missing (ENOENT)", async () => {
    const enoent = Object.assign(new Error("spawn ENOENT"), { code: -2 });
    expect(await ollamaBinaryAvailable(fakeExec({ version: enoent }))).toBe(false);
  });
  it("false (never throws) when exec itself throws synchronously", async () => {
    const throwingExec: ExecFileLike = () => {
      throw new Error("boom");
    };
    expect(await ollamaBinaryAvailable(throwingExec)).toBe(false);
  });
});

describe("runOllamaSetupStep — gated, fixed argv, no injection", () => {
  it("returns not_available (no crash) when the binary is absent — the prod/serverless case", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: -2 });
    const r = await runOllamaSetupStep("pull", "llama3.1:8b", fakeExec({ version: enoent }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not_available");
    expect(r.message).toMatch(/not installed|not available|locally/i);
  });

  it("pull passes a FIXED argv [pull, <model>] — the model is the only variable", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const r = await runOllamaSetupStep(
      "pull",
      "llama3.1:8b",
      fakeExec({ version: null, run: { stdout: "pulling manifest\nsuccess" }, calls }),
    );
    expect(r.ok).toBe(true);
    expect(r.code).toBe("ran");
    // First call is the --version probe, second is the actual command.
    const runCall = calls.find((c) => c.args[0] !== "--version");
    expect(runCall).toEqual({ cmd: "ollama", args: ["pull", "llama3.1:8b"] });
  });

  it("serve runs `ollama serve` with no extra argv", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const r = await runOllamaSetupStep("serve", "llama3.1:8b", fakeExec({ version: null, calls }));
    expect(r.ok).toBe(true);
    const runCall = calls.find((c) => c.args[0] !== "--version");
    expect(runCall).toEqual({ cmd: "ollama", args: ["serve"] });
  });

  it("rejects an invalid model tag BEFORE spawning pull (defense in depth)", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const r = await runOllamaSetupStep("pull", "llama; rm -rf /", fakeExec({ version: null, calls }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("failed");
    expect(r.message).toMatch(/invalid model/i);
    // Never even probed for the binary / spawned anything for a bad tag.
    expect(calls.length).toBe(0);
  });

  it("maps a non-zero exit to failed with the output tail (no crash)", async () => {
    const err = Object.assign(new Error("exit 1"), { code: 1 });
    const r = await runOllamaSetupStep(
      "pull",
      "llama3.1:8b",
      fakeExec({ version: null, run: { err, stderr: "manifest not found" } }),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe("failed");
    expect(r.output).toContain("manifest not found");
  });

  it("rejects an unknown step without spawning", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    // @ts-expect-error — deliberately passing a non-allowlisted step
    const r = await runOllamaSetupStep("install", "llama3.1:8b", fakeExec({ version: null, calls }));
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});
