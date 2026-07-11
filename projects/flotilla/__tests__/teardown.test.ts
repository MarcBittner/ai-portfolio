import { describe, it, expect } from "vitest";
import { executeTeardown, type ExecTeardownOpts } from "../lib/executor.ts";
import { PROD_CONVEX_DEPLOYMENT } from "../lib/provision.ts";
import type { LogEvent } from "../lib/logtap.ts";

// dryRun => no network, no Mongo (the Clerk-records step short-circuits on dry-run).
const base = (over: Partial<ExecTeardownOpts> = {}): ExecTeardownOpts => ({
  instanceId: "inst_1",
  instanceName: "staging-abc123",
  createdByTool: true,
  convexDeployment: "quaint-ferret-862",
  vercelProject: "staging-abc123",
  vercelDeploymentId: "dep_1",
  dryRun: true,
  onLog: () => {},
  ...over,
});

describe("executeTeardown — reclaim (dry-run)", () => {
  it("tears down a tool-created instance across vercel + convex + clerk records", async () => {
    const events: LogEvent[] = [];
    const out = await executeTeardown(base({ onLog: (e) => events.push(e) }));
    expect(out.ok).toBe(true);
    expect(out.steps.map((s) => s.name)).toEqual([
      "preflight",
      "teardown-vercel",
      "teardown-convex",
      "teardown-clerk-records",
    ]);
    expect(out.steps.every((s) => s.ok)).toBe(true);
  });
});

describe("executeTeardown — safety gates", () => {
  it("refuses an instance the tool did not create", async () => {
    const out = await executeTeardown(base({ createdByTool: false }));
    expect(out.ok).toBe(false);
    expect(out.steps.find((s) => s.name === "preflight")!.detail).toMatch(/did not create/);
  });

  it("HARD-refuses the production Convex deployment", async () => {
    const out = await executeTeardown(base({ convexDeployment: PROD_CONVEX_DEPLOYMENT }));
    expect(out.ok).toBe(false);
    expect(out.steps.find((s) => s.name === "preflight")!.detail).toMatch(/PRODUCTION/i);
  });

  it("refuses a shared Convex deployment", async () => {
    const out = await executeTeardown(base({ convexDeployment: "demo-staging-prod" }));
    expect(out.ok).toBe(false);
    expect(out.steps.find((s) => s.name === "preflight")!.detail).toMatch(/shared/i);
  });

  it("refuses a shared/prod Vercel project", async () => {
    const out = await executeTeardown(base({ vercelProject: "production" }));
    expect(out.ok).toBe(false);
    expect(out.steps.find((s) => s.name === "preflight")!.detail).toMatch(/Vercel project/i);
  });
});
