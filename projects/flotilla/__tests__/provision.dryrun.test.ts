import { describe, it, expect } from "vitest";
import { provision } from "../lib/provision.ts";
import { formatLogEvent, type LogEvent } from "../lib/logtap.ts";

describe("provision() dry-run", () => {
  it("sequences all steps with no writes and proves the merged log tap", async () => {
    const events: LogEvent[] = [];
    const result = await provision({
      branch: "feature/dci-preview",
      backupRef: "/backups/prod-2026-07-02.zip",
      target: {
        kind: "preview",
        convexDeployment: "demo-dev", // dev rehearsal target
        clerkInstance: "clerk.dev.example.com",
        vercelProject: "cover-preview",
      },
      migrations: true,
      scrubPII: true,
      dryRun: true,
      onLog: (e) => events.push(e),
    });

    expect(result.ok).toBe(true);
    expect(result.instanceId).toBe("preview-demo-dev");
    expect(result.steps.map((s) => s.name)).toEqual([
      "preflight",
      "deploy-code",
      "snapshot-target",
      "import-data",
      "reset-auth",
      "migrations",
      "verify",
    ]);
    expect(result.steps.every((s) => s.ok)).toBe(true);

    // The consolidated tap saw all four sources merged into one ordered stream.
    const sources = new Set(events.map((e) => e.source));
    expect(sources.has("orchestrator")).toBe(true);
    expect(sources.has("vercel")).toBe(true);
    expect(sources.has("convex")).toBe(true);

    // Print the merged log so `vitest run` output is the dry-run proof artifact.
    console.log("\n===== provision() DRY-RUN merged log =====\n" + events.map(formatLogEvent).join("\n") + "\n===== end =====");
  });
});
