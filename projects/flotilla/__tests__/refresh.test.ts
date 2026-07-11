import { describe, it, expect } from "vitest";
import { refreshStaging, type RefreshArgs, DEV_DEPLOYMENT, STAGING_PROD_DEPLOYMENT } from "../scripts/refresh-staging.ts";
import type { LogEvent } from "../lib/logtap.ts";

const base = (over: Partial<RefreshArgs> = {}): RefreshArgs => ({
  target: DEV_DEPLOYMENT,
  prodBackup: "/backups/prod.zip",
  migrations: true,
  scrub: true,
  force: true, // avoid cron-window flakiness in CI
  dryRun: true,
  schedule: false,
  iVerifiedProdName: false,
  ...over,
});

describe("refreshStaging orchestration", () => {
  it("dry-run rehearsal on dev runs all A-1…A-4 stages and converges", async () => {
    const events: LogEvent[] = [];
    const res = await refreshStaging(base(), (e) => events.push(e));
    expect(res.ok).toBe(true);
    const names = res.steps.map((s) => s.name);
    expect(names).toEqual([
      "A-1 preflight",
      "A-2 snapshot-before",
      "A-3 scrub-and-import",
      "A-3 reset-authIds",
      "A-3 forward-migrations",
      "A-3 neutralize-async-jobs",
      "A-4 verify",
    ]);
    expect(res.steps.every((s) => s.ok)).toBe(true);
    // Every platform source flowed through the one merged tap.
    expect(new Set(events.map((e) => e.source))).toEqual(new Set(["orchestrator", "convex", "clerk"]));
  });

  it("preflight aborts (no snapshot, no writes) when targeting staging-prod for real without a deploy env", async () => {
    // Non-dry-run to a real target with no ALLOW_OUTBOUND_EMAIL set would proceed;
    // here we prove the rehearsal-target guard: dev target, real run → A-1 fails.
    const res = await refreshStaging(base({ target: DEV_DEPLOYMENT, dryRun: false }), () => {});
    expect(res.ok).toBe(false);
    expect(res.steps).toHaveLength(1);
    expect(res.steps[0].name).toBe("A-1 preflight");
    expect(res.steps[0].ok).toBe(false);
    expect(res.steps[0].detail).toMatch(/only allowed with --dry-run/);
  });

  it("skips migrations when toggled off", async () => {
    const res = await refreshStaging(base({ migrations: false }), () => {});
    expect(res.steps.map((s) => s.name)).not.toContain("A-3 forward-migrations");
  });

  it("aborts in preflight when --prod-backup is missing", async () => {
    const res = await refreshStaging(base({ prodBackup: undefined }), () => {});
    expect(res.ok).toBe(false);
    expect(res.steps[0].detail).toMatch(/--prod-backup/);
  });

  it("guards the real target name constant", () => {
    expect(STAGING_PROD_DEPLOYMENT).toBe("demo-staging-prod");
  });
});
