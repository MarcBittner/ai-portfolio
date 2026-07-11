import { describe, it, expect, vi } from "vitest";
import { triageInstance, looksFailed, type TriageDeps } from "../lib/aiTriage.ts";
import type { InstanceDoc } from "../lib/models/instances.ts";
import type { LogDoc } from "../lib/models/logs.ts";

// triageInstance is pure over injected upstreams (mirrors lib/drift.ts): we fake
// getInstance, queryLogs, anthropicConfigured, and the Anthropic tool call, so no
// Mongo cluster or ANTHROPIC_API_KEY is needed. These tests cover a normal
// diagnosis, the entity-faithfulness downgrade, and the no-key path.

function inst(over: Partial<InstanceDoc> = {}): InstanceDoc {
  const ts = 1_000;
  return {
    id: "inst_abc",
    idempotencyKey: "k",
    name: "staging-oppp5hyz",
    kind: "staging",
    branch: "staging",
    convexDeployment: "quaint-ferret-862",
    backupDeployment: "demo-staging-prod",
    status: "failed",
    health: "down",
    migrations: true,
    scrubPII: true,
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}

function log(level: LogDoc["level"], msg: string, seq: number): LogDoc {
  return { seq, ts: 1_000 + seq, source: "convex", level, msg, instanceId: "inst_abc", createdAt: 1_000 + seq };
}

// A raw tool payload the fake model "returns".
type RawTriage = {
  rootCause: string;
  evidence: string[];
  suggestedFix: string;
  confidence: "low" | "medium" | "high";
  insufficientEvidence: boolean;
};

function deps(over: {
  instance?: InstanceDoc | null;
  logs?: LogDoc[];
  configured?: boolean;
  raw?: RawTriage;
  callSpy?: ReturnType<typeof vi.fn>;
}): TriageDeps {
  const callTool =
    over.callSpy ??
    vi.fn(async () => over.raw as unknown);
  return {
    getInstance: async () => (over.instance === undefined ? inst() : over.instance),
    queryLogs: (async () => over.logs ?? []) as TriageDeps["queryLogs"],
    anthropicConfigured: () => over.configured ?? true,
    callTool: callTool as TriageDeps["callTool"],
    model: "claude-sonnet-4-6",
  };
}

describe("looksFailed", () => {
  it("flags failed status / degraded / down health; passes healthy", () => {
    expect(looksFailed({ status: "failed", health: "healthy" })).toBe(true);
    expect(looksFailed({ status: "ready", health: "degraded" })).toBe(true);
    expect(looksFailed({ status: "ready", health: "down" })).toBe(true);
    expect(looksFailed({ status: "ready", health: "healthy" })).toBe(false);
  });
});

describe("triageInstance", () => {
  it("returns a grounded diagnosis unchanged (entities present in the context)", async () => {
    const out = await triageInstance(
      "inst_abc",
      deps({
        logs: [
          log("error", "import failed against quaint-ferret-862: schema mismatch", 1),
          log("warn", "retrying import", 2),
        ],
        raw: {
          rootCause: "The data import into quaint-ferret-862 failed due to a schema mismatch.",
          evidence: ["error: import failed against quaint-ferret-862: schema mismatch"],
          suggestedFix: "Re-run migrations before importing the snapshot.",
          confidence: "high",
          insufficientEvidence: false,
        },
      }),
    );
    expect(out.triage.confidence).toBe("high"); // not downgraded — deployment is in the input
    expect(out.triage.groundingNote).toBeUndefined();
    expect(out.triage.rootCause).toContain("schema mismatch");
    expect(out.model).toBe("claude-sonnet-4-6");
    expect(typeof out.checkedAt).toBe("number");
  });

  it("downgrades confidence + notes it when the model cites an entity not in the input", async () => {
    const out = await triageInstance(
      "inst_abc",
      deps({
        logs: [log("error", "import failed: connection refused", 1)],
        raw: {
          // `frantic-otter-999` was never fed to the model → hallucinated.
          rootCause: "Deployment frantic-otter-999 rejected the connection.",
          evidence: ["error: import failed: connection refused"],
          suggestedFix: "Check the deployment status.",
          confidence: "high",
          insufficientEvidence: false,
        },
      }),
    );
    expect(out.triage.confidence).toBe("medium"); // high → medium
    expect(out.triage.groundingNote).toBeDefined();
    expect(out.triage.groundingNote).toContain("frantic-otter-999");
  });

  it("returns an honest not-configured outcome and never calls the model when no key", async () => {
    const callSpy = vi.fn(async () => ({}) as unknown);
    const out = await triageInstance(
      "inst_abc",
      deps({ configured: false, callSpy }),
    );
    expect(callSpy).not.toHaveBeenCalled();
    expect(out.triage.insufficientEvidence).toBe(true);
    expect(out.triage.confidence).toBe("low");
    expect(out.triage.suggestedFix).toContain("not configured");
  });

  it("throws when the instance does not exist", async () => {
    await expect(triageInstance("inst_missing", deps({ instance: null }))).rejects.toThrow("instance not found");
  });
});
