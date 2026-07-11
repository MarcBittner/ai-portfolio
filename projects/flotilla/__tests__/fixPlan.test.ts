import { describe, it, expect } from "vitest";
import {
  FixOp,
  validateFixPlan,
  applyFixPlanToOpts,
  fixPlanKey,
  describeFixOp,
  describeFixPlan,
  type FixPlan,
  type FixableOpts,
} from "../lib/fixPlan.ts";

// The closed-enum FixPlan spine is PURE — these tests exercise the enum validation
// (the out-of-model gate), the pure applicator, and dedup keying with no I/O.

describe("FixOp enum validation", () => {
  it("accepts each of the five allowed ops with correct fields", () => {
    expect(FixOp.safeParse({ op: "setMigrations", value: false }).success).toBe(true);
    expect(FixOp.safeParse({ op: "setScrubPII", value: true }).success).toBe(true);
    expect(FixOp.safeParse({ op: "useSnapshot", snapshotId: "snap_123" }).success).toBe(true);
    expect(FixOp.safeParse({ op: "setClerkInstance", value: "clerk-abc" }).success).toBe(true);
    expect(FixOp.safeParse({ op: "retryStep" }).success).toBe(true);
    expect(FixOp.safeParse({ op: "retryStep", step: "import-data" }).success).toBe(true);
  });

  it("rejects an unknown op, a wrong-typed field, and an extra field", () => {
    expect(FixOp.safeParse({ op: "runShell", cmd: "rm -rf /" }).success).toBe(false); // not in the enum
    expect(FixOp.safeParse({ op: "setMigrations", value: "yes" }).success).toBe(false); // must be boolean
    expect(FixOp.safeParse({ op: "useSnapshot" }).success).toBe(false); // missing snapshotId
    // `.strict()` — a smuggled extra field fails instead of passing through.
    expect(FixOp.safeParse({ op: "retryStep", shell: "curl evil" }).success).toBe(false);
  });
});

describe("validateFixPlan (out-of-model gate)", () => {
  it("keeps valid ops and drops unknown/invalid ones", () => {
    const { plan, dropped } = validateFixPlan([
      { op: "setMigrations", value: false },
      { op: "runShell", cmd: "rm -rf /" }, // dropped: not an allowed op
      { op: "useSnapshot", snapshotId: "snap_9" },
      { op: "setMigrations", value: "nope" }, // dropped: bad type
    ]);
    expect(plan).toHaveLength(2);
    expect(plan.map((p) => p.op)).toEqual(["setMigrations", "useSnapshot"]);
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toContain("runShell");
  });

  it("returns an empty plan for a non-array or an all-invalid proposal", () => {
    expect(validateFixPlan(undefined).plan).toEqual([]);
    expect(validateFixPlan("not-an-array").plan).toEqual([]);
    expect(validateFixPlan([{ op: "nope" }, 42, null]).plan).toEqual([]);
  });
});

describe("applyFixPlanToOpts (pure applicator)", () => {
  const base: FixableOpts = { migrations: true, scrubPII: true, backupSnapshotId: "snap_a", clerkInstance: "clerk-1" };

  it("applies each op to produce edited opts without mutating base", () => {
    const plan: FixPlan = [
      { op: "setMigrations", value: false },
      { op: "setScrubPII", value: false },
      { op: "useSnapshot", snapshotId: "snap_b" },
      { op: "setClerkInstance", value: "clerk-2" },
    ];
    const out = applyFixPlanToOpts(base, plan);
    expect(out).toEqual({ migrations: false, scrubPII: false, backupSnapshotId: "snap_b", clerkInstance: "clerk-2" });
    // base untouched (pure)
    expect(base).toEqual({ migrations: true, scrubPII: true, backupSnapshotId: "snap_a", clerkInstance: "clerk-1" });
  });

  it("last write wins for a repeated op; retryStep is a no-op", () => {
    const plan: FixPlan = [
      { op: "setMigrations", value: false },
      { op: "setMigrations", value: true },
      { op: "retryStep" },
    ];
    const out = applyFixPlanToOpts(base, plan);
    expect(out.migrations).toBe(true);
    expect(out.backupSnapshotId).toBe("snap_a"); // retryStep changed nothing
  });
});

describe("fixPlanKey + describe helpers", () => {
  it("gives identical keys for identical ordered plans and different keys otherwise", () => {
    const a: FixPlan = [{ op: "setMigrations", value: false }];
    const b: FixPlan = [{ op: "setMigrations", value: false }];
    const c: FixPlan = [{ op: "setMigrations", value: true }];
    expect(fixPlanKey(a)).toBe(fixPlanKey(b));
    expect(fixPlanKey(a)).not.toBe(fixPlanKey(c));
  });

  it("renders readable op/plan text", () => {
    expect(describeFixOp({ op: "setMigrations", value: false })).toBe("migrations → off");
    expect(describeFixOp({ op: "useSnapshot", snapshotId: "snap_x" })).toBe("use snapshot snap_x");
    expect(describeFixPlan([{ op: "retryStep" }])).toContain("retry the failed step");
    expect(describeFixPlan([])).toBe("(no ops)");
  });
});
