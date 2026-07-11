import { describe, it, expect, vi } from "vitest";
import { gateVerdict, isTerminal, resolveGateModel, type GateDeps } from "../lib/aiSmokeGate.ts";
import type { TestRunDoc, TestCheck } from "../lib/models/testruns.ts";
import type { InstanceDoc } from "../lib/models/instances.ts";

// gateVerdict is pure over injected upstreams (mirrors lib/aiTriage.ts): we fake
// getTestRun, getInstance, anthropicConfigured, and the Anthropic tool call, so no
// Mongo cluster or ANTHROPIC_API_KEY is needed. These tests cover a clean promote,
// the security guardrail (never promote on a failed security check), the grounding
// downgrade (blocker cites a check not in the run), the no-key path, and the
// non-terminal gentle no-op.

function run(over: Partial<TestRunDoc> = {}): TestRunDoc {
  const ts = 1_000;
  return {
    id: "run_abc",
    instanceId: "inst_abc",
    kind: "smoke",
    status: "passed",
    checks: [],
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}

function check(name: string, pass: boolean, detail?: string): TestCheck {
  return { name, pass, detail };
}

function inst(over: Partial<InstanceDoc> = {}): InstanceDoc {
  const ts = 1_000;
  return {
    id: "inst_abc",
    idempotencyKey: "k",
    name: "staging-oppp5hyz",
    kind: "staging",
    branch: "staging",
    status: "ready",
    health: "healthy",
    migrations: true,
    scrubPII: true,
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}

type RawVerdict = {
  verdict: "promote" | "hold" | "caution";
  summary: string;
  blockers: string[];
  confidence: "low" | "medium" | "high";
  insufficientSignal: boolean;
};

function deps(over: {
  run?: TestRunDoc | null;
  instance?: InstanceDoc | null;
  configured?: boolean;
  raw?: RawVerdict;
  callSpy?: ReturnType<typeof vi.fn>;
}): GateDeps {
  const callTool = over.callSpy ?? vi.fn(async () => over.raw as unknown);
  return {
    getTestRun: async () => (over.run === undefined ? run() : over.run),
    getInstance: async () => (over.instance === undefined ? inst() : over.instance),
    anthropicConfigured: () => over.configured ?? true,
    callTool: callTool as GateDeps["callTool"],
    model: "claude-sonnet-4-6",
  };
}

describe("isTerminal / resolveGateModel", () => {
  it("only passed/failed are terminal", () => {
    expect(isTerminal("passed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });

  it("resolves an explicit override, else the shipped default", () => {
    expect(resolveGateModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveGateModel()).toBe("claude-sonnet-4-6"); // no env override set in test
  });
});

describe("gateVerdict", () => {
  it("returns a clean promote for an all-passing run, unchanged", async () => {
    const out = await gateVerdict(
      "run_abc",
      deps({
        run: run({
          status: "passed",
          checks: [check("smoke: home renders", true), check("smoke: api healthy", true)],
        }),
        raw: {
          verdict: "promote",
          summary: "All smoke checks passed; nothing blocks promotion.",
          blockers: [],
          confidence: "high",
          insufficientSignal: false,
        },
      }),
    );
    expect(out.verdict?.verdict).toBe("promote");
    expect(out.verdict?.groundingNote).toBeUndefined();
    expect(out.verdict?.confidence).toBe("high");
    expect(out.model).toBe("claude-sonnet-4-6");
    expect(typeof out.checkedAt).toBe("number");
  });

  it("never promotes when a security/auth check failed — forces hold", async () => {
    const out = await gateVerdict(
      "run_abc",
      deps({
        run: run({
          status: "failed",
          checks: [
            check("smoke: home renders", true),
            check("security: tenant isolation", false, "cross-tenant read succeeded"),
          ],
        }),
        // Model wrongly says promote; the deterministic guardrail overrides it.
        raw: {
          verdict: "promote",
          summary: "Looks fine to me.",
          blockers: [],
          confidence: "high",
          insufficientSignal: false,
        },
      }),
    );
    expect(out.verdict?.verdict).toBe("hold");
    expect(out.verdict?.groundingNote).toContain("security");
  });

  it("downgrades confidence + notes it when a blocker cites a check not in the run", async () => {
    const out = await gateVerdict(
      "run_abc",
      deps({
        run: run({
          status: "failed",
          checks: [check("smoke: api healthy", false, "503 from /health")],
        }),
        raw: {
          verdict: "hold",
          summary: "A check failed.",
          // `security: nonexistent` is NOT a check in this run → hallucinated citation.
          blockers: ["The `security: nonexistent` check failed and blocks promotion."],
          confidence: "high",
          insufficientSignal: false,
        },
      }),
    );
    expect(out.verdict?.verdict).toBe("hold"); // still a hold (a real check did fail)
    expect(out.verdict?.confidence).toBe("medium"); // high → medium
    expect(out.verdict?.groundingNote).toContain("security: nonexistent");
  });

  it("softens a spurious hold to caution when no check failed and no gap was flagged", async () => {
    const out = await gateVerdict(
      "run_abc",
      deps({
        run: run({ status: "passed", checks: [check("smoke: home renders", true)] }),
        raw: {
          verdict: "hold",
          summary: "I'd hold on this.",
          blockers: [],
          confidence: "medium",
          insufficientSignal: false,
        },
      }),
    );
    expect(out.verdict?.verdict).toBe("caution");
    expect(out.verdict?.groundingNote).toContain("softened");
  });

  it("returns an honest not-configured verdict and never calls the model when no key", async () => {
    const callSpy = vi.fn(async () => ({}) as unknown);
    const out = await gateVerdict(
      "run_abc",
      deps({ run: run({ status: "passed", checks: [check("smoke", true)] }), configured: false, callSpy }),
    );
    expect(callSpy).not.toHaveBeenCalled();
    expect(out.verdict?.insufficientSignal).toBe(true);
    expect(out.verdict?.confidence).toBe("low");
    expect(out.verdict?.summary).toContain("not configured");
  });

  it("gently no-ops (never calls the model) for a non-terminal run", async () => {
    const callSpy = vi.fn(async () => ({}) as unknown);
    const out = await gateVerdict(
      "run_abc",
      deps({ run: run({ status: "running", checks: [] }), callSpy }),
    );
    expect(callSpy).not.toHaveBeenCalled();
    expect(out.notComplete).toBe(true);
    expect(out.verdict).toBeNull();
    expect(out.message).toContain("running");
  });

  it("throws when the run does not exist", async () => {
    await expect(gateVerdict("run_missing", deps({ run: null }))).rejects.toThrow("test run not found");
  });
});
