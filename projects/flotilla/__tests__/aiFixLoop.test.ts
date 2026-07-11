import { describe, it, expect, vi } from "vitest";
import { runFixLoop, fixLoopGuard, type FixLoopDeps, type ReprovisionResult } from "../lib/aiFixLoop.ts";
import type { InstanceDoc } from "../lib/models/instances.ts";
import type { LogDoc } from "../lib/models/logs.ts";
import { PROD_CONVEX_DEPLOYMENT } from "../lib/provision.ts";
import type { FixPlan } from "../lib/fixPlan.ts";

// runFixLoop is pure over injected upstreams (mirrors lib/aiTriage.ts): we fake
// getInstance, queryLogs, anthropicConfigured, the Anthropic proposer, AND the
// re-provision, so no Mongo / ANTHROPIC_API_KEY / real provision is needed. These
// cover the scope guard, a winning fix, exhaustion, dedup, and — the load-bearing
// invariant — that the verdict comes from the re-provision result, not the model.

function inst(over: Partial<InstanceDoc> = {}): InstanceDoc {
  const ts = 1_000;
  return {
    id: "inst_abc",
    idempotencyKey: "k",
    name: "staging-oppp5hyz",
    kind: "preview",
    branch: "staging",
    convexDeployment: "quaint-ferret-862",
    createdConvexDeployment: "quaint-ferret-862",
    backupDeployment: "demo-staging-prod",
    backupSnapshotId: "snap_old",
    status: "failed",
    health: "down",
    migrations: true,
    scrubPII: true,
    createdByTool: true,
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}

function log(level: LogDoc["level"], msg: string, seq: number): LogDoc {
  return { seq, ts: 1_000 + seq, source: "convex", level, msg, instanceId: "inst_abc", createdAt: 1_000 + seq };
}

// A proposer that returns a scripted sequence of tool payloads, one per attempt.
function scriptedProposer(payloads: unknown[]): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async () => payloads[Math.min(i++, payloads.length - 1)] as unknown);
}

function deps(over: {
  instance?: InstanceDoc | null;
  logs?: LogDoc[];
  configured?: boolean;
  proposer?: ReturnType<typeof vi.fn>;
  reprovision?: FixLoopDeps["reprovision"];
}): FixLoopDeps {
  return {
    getInstance: async () => (over.instance === undefined ? inst() : over.instance),
    queryLogs: (async () => over.logs ?? [log("error", "import failed: schema mismatch", 1)]) as FixLoopDeps["queryLogs"],
    anthropicConfigured: () => over.configured ?? true,
    callTool: (over.proposer ?? scriptedProposer([{ plan: [{ op: "retryStep" }], rationale: "flake", confidence: "low" }])) as FixLoopDeps["callTool"],
    reprovision: over.reprovision ?? (async () => ({ ok: false, detail: "still failing" }) as ReprovisionResult),
    model: "claude-sonnet-4-6",
  };
}

describe("fixLoopGuard", () => {
  it("refuses a non-tool-created instance", () => {
    const g = fixLoopGuard(inst({ createdByTool: false }));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain("tool-created");
  });

  it("refuses the production deployment", () => {
    const g = fixLoopGuard(inst({ createdConvexDeployment: PROD_CONVEX_DEPLOYMENT, convexDeployment: PROD_CONVEX_DEPLOYMENT }));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain("PRODUCTION");
  });

  it("refuses a shared deployment", () => {
    const g = fixLoopGuard(inst({ createdConvexDeployment: "demo-ci", convexDeployment: "demo-ci" }));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain("shared");
  });

  it("refuses a non-failed instance when requireFailed", () => {
    const g = fixLoopGuard(inst({ status: "ready", health: "healthy" }), { requireFailed: true });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain("failed state");
  });

  it("passes a failed, tool-created, isolated preview", () => {
    expect(fixLoopGuard(inst(), { requireFailed: true }).ok).toBe(true);
  });
});

describe("runFixLoop guards", () => {
  it("throws for a prod-targeted instance (never re-provisions prod)", async () => {
    const reprovision = vi.fn(async () => ({ ok: true, detail: "x" }) as ReprovisionResult);
    await expect(
      runFixLoop("inst_abc", deps({ instance: inst({ createdConvexDeployment: PROD_CONVEX_DEPLOYMENT }), reprovision })),
    ).rejects.toThrow(/PRODUCTION/);
    expect(reprovision).not.toHaveBeenCalled();
  });

  it("throws for a non-failed instance", async () => {
    await expect(
      runFixLoop("inst_abc", deps({ instance: inst({ status: "ready", health: "healthy" }) })),
    ).rejects.toThrow(/failed state/);
  });

  it("throws when AI is not configured (never calls the model)", async () => {
    const proposer = vi.fn(async () => ({}) as unknown);
    await expect(runFixLoop("inst_abc", deps({ configured: false, proposer }))).rejects.toThrow(/not configured/);
    expect(proposer).not.toHaveBeenCalled();
  });
});

describe("runFixLoop", () => {
  it("returns the winning plan when a proposed fix makes the real re-provision pass", async () => {
    // The model proposes useSnapshot; the (mocked) re-provision passes → winning.
    const proposer = scriptedProposer([
      { plan: [{ op: "useSnapshot", snapshotId: "snap_new" }], rationale: "stale snapshot", confidence: "high" },
    ]);
    const reprovision = vi.fn(async (_id, edited) => {
      // Verdict is the REAL re-provision result: pass only once the snapshot changed.
      return { ok: edited.backupSnapshotId === "snap_new", detail: "reprovision" } as ReprovisionResult;
    });
    const out = await runFixLoop("inst_abc", deps({ proposer, reprovision }));
    expect(out.winningPlan).not.toBeNull();
    expect(out.winningPlan?.[0]).toMatchObject({ op: "useSnapshot", snapshotId: "snap_new" });
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0].verdict).toBe("pass");
    expect(reprovision).toHaveBeenCalledTimes(1);
  });

  it("returns null after exhausting 3 attempts when nothing passes", async () => {
    // Three DISTINCT plans (so none dedup), all failing the re-provision.
    const proposer = scriptedProposer([
      { plan: [{ op: "retryStep" }], rationale: "a", confidence: "low" },
      { plan: [{ op: "setMigrations", value: false }], rationale: "b", confidence: "low" },
      { plan: [{ op: "useSnapshot", snapshotId: "snap_z" }], rationale: "c", confidence: "low" },
      { plan: [{ op: "setScrubPII", value: false }], rationale: "d (never reached)", confidence: "low" },
    ]);
    const reprovision = vi.fn(async () => ({ ok: false, detail: "still broken" }) as ReprovisionResult);
    const out = await runFixLoop("inst_abc", deps({ proposer, reprovision }));
    expect(out.winningPlan).toBeNull();
    expect(out.attempts).toHaveLength(3); // hard cap
    expect(out.attempts.every((a) => a.verdict === "fail")).toBe(true);
    expect(proposer).toHaveBeenCalledTimes(3);
  });

  it("dedups an identical re-proposed plan (applies once, skips the repeats)", async () => {
    const same = { plan: [{ op: "retryStep" }], rationale: "same each time", confidence: "low" };
    const proposer = scriptedProposer([same, same, same]);
    const reprovision = vi.fn(async () => ({ ok: false, detail: "no" }) as ReprovisionResult);
    const out = await runFixLoop("inst_abc", deps({ proposer, reprovision }));
    expect(out.attempts).toHaveLength(3);
    expect(out.attempts[0].verdict).toBe("fail");
    expect(out.attempts[1].verdict).toBe("skipped");
    expect(out.attempts[2].verdict).toBe("skipped");
    // Applied (re-provisioned) exactly once despite three proposals.
    expect(reprovision).toHaveBeenCalledTimes(1);
  });

  it("takes the verdict from the re-provision, NOT the model's confidence", async () => {
    // Model is 'high' confidence, but the real re-provision fails → verdict fail.
    const proposer = scriptedProposer([
      { plan: [{ op: "setMigrations", value: false }], rationale: "sure it's fixed", confidence: "high" },
      { plan: [{ op: "useSnapshot", snapshotId: "snap_q" }], rationale: "or this", confidence: "high" },
      { plan: [{ op: "retryStep" }], rationale: "or a retry", confidence: "high" },
    ]);
    const reprovision = vi.fn(async () => ({ ok: false, detail: "provision reported failure" }) as ReprovisionResult);
    const out = await runFixLoop("inst_abc", deps({ proposer, reprovision }));
    expect(out.winningPlan).toBeNull();
    expect(out.attempts.every((a) => a.verdict === "fail")).toBe(true);
    expect(out.attempts[0].confidence).toBe("high"); // model's claim is recorded…
    expect(out.attempts[0].detail).toContain("provision reported failure"); // …but the verdict is the real result
  });

  it("marks an all-invalid proposal 'invalid' and keeps looping (unknown ops rejected)", async () => {
    const proposer = scriptedProposer([
      { plan: [{ op: "runShell", cmd: "rm -rf /" }], rationale: "malicious/unknown", confidence: "high" },
      { plan: [{ op: "useSnapshot", snapshotId: "snap_ok" }], rationale: "real fix", confidence: "high" },
    ]);
    const reprovision = vi.fn(async (_id, edited) => ({ ok: edited.backupSnapshotId === "snap_ok", detail: "x" }) as ReprovisionResult);
    const out = await runFixLoop("inst_abc", deps({ proposer, reprovision }));
    expect(out.attempts[0].verdict).toBe("invalid"); // unknown op dropped → nothing to apply
    expect(out.attempts[1].verdict).toBe("pass");
    expect(out.winningPlan?.[0]).toMatchObject({ op: "useSnapshot" });
    // The invalid proposal never reached the executor.
    expect(reprovision).toHaveBeenCalledTimes(1);
  });

  it("stops at the token budget before the attempt cap", async () => {
    const proposer = scriptedProposer([
      { plan: [{ op: "setMigrations", value: false }], rationale: "a", confidence: "low" },
      { plan: [{ op: "useSnapshot", snapshotId: "snap_y" }], rationale: "b", confidence: "low" },
    ]);
    const reprovision = vi.fn(async () => ({ ok: false, detail: "no" }) as ReprovisionResult);
    // A tiny budget only affords one proposer call.
    const out = await runFixLoop("inst_abc", { ...deps({ proposer, reprovision }), tokenBudget: 1300 });
    expect(out.attempts).toHaveLength(1);
    expect(proposer).toHaveBeenCalledTimes(1);
  });
});

// Guard against accidental drift of the closed op set into the plan shape.
describe("FixPlan type surface", () => {
  it("winning plan is an array of ops", async () => {
    const out = await runFixLoop(
      "inst_abc",
      deps({
        proposer: scriptedProposer([{ plan: [{ op: "retryStep" }], rationale: "r", confidence: "low" }]),
        reprovision: async () => ({ ok: true, detail: "ok" }) as ReprovisionResult,
      }),
    );
    const plan: FixPlan | null = out.winningPlan;
    expect(Array.isArray(plan)).toBe(true);
  });
});
