import { describe, it, expect } from "vitest";
import { executeProvision, SHARED_DEPLOYMENTS, type ExecOpts } from "../lib/executor.ts";
import { PROD_CONVEX_DEPLOYMENT } from "../lib/provision.ts";
import type { LogEvent } from "../lib/logtap.ts";

// Base opts for a FRESH code-only provision. dryRun => no network, no Mongo
// (the data dimension is omitted, so no snapshot/GridFS access).
const base = (over: Partial<ExecOpts> = {}): ExecOpts => ({
  instanceName: "staging-abc123",
  branch: "feature/dci-preview",
  clerkInstance: "clerk.dev.example.com",
  migrations: true,
  scrubPII: true,
  dryRun: true,
  dimensions: ["code", "clerk"],
  target: { kind: "preview", vercelProject: "cover-preview" },
  onLog: () => {},
  ...over,
});

describe("executeProvision — fresh isolated provision (dry-run)", () => {
  it("provisions a NEW convex deployment + deploys code, no pre-existing target touched", async () => {
    const events: LogEvent[] = [];
    const out = await executeProvision(base({ onLog: (e) => events.push(e) }));

    expect(out.ok).toBe(true);
    expect(out.createdByTool).toBe(true);
    expect(out.steps.map((s) => s.name)).toEqual([
      "preflight",
      "provision-convex",
      "deploy-code",
      "clerk-select",
      "verify",
    ]);
    expect(out.steps.every((s) => s.ok)).toBe(true);
    expect(out.convexDeployment).toContain("staging-abc123"); // preview named from the instance
    expect(out.url).toBeDefined();
    // Consolidated tap saw all platform sources.
    const sources = new Set(events.map((e) => e.source));
    expect(sources.has("orchestrator")).toBe(true);
    expect(sources.has("convex")).toBe(true);
    expect(sources.has("vercel")).toBe(true);
  });
});

describe("executeProvision — full fresh provision (code + data + clerk, dry-run)", () => {
  it("sequences deploy + HTTP import + authreset + migrations with no side effects", async () => {
    const out = await executeProvision(
      base({
        dimensions: ["code", "data", "clerk"],
        data: { backupSnapshotId: "snap-1", backupDeployment: "demo-prod" },
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.steps.map((s) => s.name)).toEqual([
      "preflight",
      "provision-convex",
      "deploy-code",
      "import-data",
      "reset-auth",
      "migrations",
      "clerk-select",
      "verify",
    ]);
    expect(out.steps.every((s) => s.ok)).toBe(true);
    expect(out.lastImportedSnapshotId).toBe("snap-1");
  });
});

describe("executeProvision — safety gates", () => {
  it("HARD-blocks writing the production deployment even with dangerAck", async () => {
    const out = await executeProvision(
      base({ dimensions: ["code"], dangerAck: true, target: { kind: "preview", convexDeployment: PROD_CONVEX_DEPLOYMENT, vercelProject: "p" } }),
    );
    expect(out.ok).toBe(false);
    const preflight = out.steps.find((s) => s.name === "preflight")!;
    expect(preflight.ok).toBe(false);
    expect(preflight.detail).toMatch(/PRODUCTION/i);
    expect(SHARED_DEPLOYMENTS[PROD_CONVEX_DEPLOYMENT]).toBe("PRODUCTION");
  });

  it("refuses to overwrite a pre-existing deployment WITHOUT dangerAck", async () => {
    const out = await executeProvision(
      base({ dimensions: ["code"], target: { kind: "preview", convexDeployment: "demo-staging-prod", vercelProject: "p" } }),
    );
    expect(out.ok).toBe(false);
    const preflight = out.steps.find((s) => s.name === "preflight")!;
    expect(preflight.ok).toBe(false);
    expect(preflight.detail).toMatch(/dangerAck/);
  });

  it("allows overwriting a pre-existing (non-prod) deployment WITH dangerAck", async () => {
    const out = await executeProvision(
      base({ dimensions: ["code"], dangerAck: true, target: { kind: "preview", convexDeployment: "demo-staging-prod", vercelProject: "p" } }),
    );
    expect(out.ok).toBe(true);
    expect(out.createdByTool).toBe(false);
    expect(out.convexDeployment).toBe("demo-staging-prod");
  });
});
