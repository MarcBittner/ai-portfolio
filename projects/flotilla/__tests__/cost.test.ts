import { describe, it, expect } from "vitest";
import {
  isActiveForCost,
  estimateInstanceCostUsd,
  estimateFleetCost,
  formatUsd,
  type CostInstance,
} from "../lib/cost.ts";

// lib/cost.ts is pure over injected `now` — no Mongo/clock. We build minimal
// instance fixtures (only the fields the estimator reads) and assert the accrual.

const DAY = 86_400_000;
const NOW = 10 * DAY; // fixed "now" so every case is hermetic.

// A CostInstance fixture. Defaults to a live (ready/healthy) instance created 4
// days ago and last touched 1 day ago.
function inst(over: Partial<CostInstance> = {}): CostInstance {
  return {
    status: "ready",
    health: "healthy",
    createdAt: NOW - 4 * DAY,
    updatedAt: NOW - 1 * DAY,
    ...over,
  };
}

describe("isActiveForCost — still-incurring classification", () => {
  it("ready + healthy is active", () => {
    expect(isActiveForCost(inst({ status: "ready", health: "healthy" }))).toBe(true);
  });

  it("provisioning is active", () => {
    expect(isActiveForCost(inst({ status: "provisioning", health: "provisioning" }))).toBe(true);
  });

  it("failed is inactive", () => {
    expect(isActiveForCost(inst({ status: "failed" }))).toBe(false);
  });

  it("health down is inactive even if status is ready", () => {
    expect(isActiveForCost(inst({ status: "ready", health: "down" }))).toBe(false);
  });

  it("archived / torn-down is inactive", () => {
    expect(isActiveForCost(inst({ status: "archived" }))).toBe(false);
    expect(isActiveForCost(inst({ status: "torn-down" as CostInstance["status"] }))).toBe(false);
  });

  it("pending has not started accruing → inactive", () => {
    expect(isActiveForCost(inst({ status: "pending" }))).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isActiveForCost(inst({ status: "READY" as CostInstance["status"], health: "HEALTHY" as CostInstance["health"] }))).toBe(true);
  });
});

describe("estimateInstanceCostUsd — per-instance accrual", () => {
  const rate = 2; // $2/day for round numbers.

  it("active instance accrues from createdAt to now (grows with age)", () => {
    const created4d = inst({ createdAt: NOW - 4 * DAY });
    const created6d = inst({ createdAt: NOW - 6 * DAY });
    expect(estimateInstanceCostUsd(created4d, rate, NOW)).toBeCloseTo(8); // 4d × $2
    // Older instance costs more — cost grows with age.
    expect(estimateInstanceCostUsd(created6d, rate, NOW)).toBeCloseTo(12);
    expect(estimateInstanceCostUsd(created6d, rate, NOW)).toBeGreaterThan(
      estimateInstanceCostUsd(created4d, rate, NOW),
    );
  });

  it("inactive instance is frozen at updatedAt, not now", () => {
    // Failed 1 day ago after living 3 days (created 4d ago, updated 1d ago).
    const dead = inst({ status: "failed", createdAt: NOW - 4 * DAY, updatedAt: NOW - 1 * DAY });
    // Frozen span = updatedAt − createdAt = 3 days → $6, NOT 4 days ($8).
    expect(estimateInstanceCostUsd(dead, rate, NOW)).toBeCloseTo(6);
  });

  it("inactive cost does not move as `now` advances (frozen)", () => {
    const dead = inst({ status: "archived", createdAt: NOW - 4 * DAY, updatedAt: NOW - 2 * DAY });
    const atNow = estimateInstanceCostUsd(dead, rate, NOW);
    const muchLater = estimateInstanceCostUsd(dead, rate, NOW + 100 * DAY);
    expect(muchLater).toBe(atNow);
  });

  it("clamps negative ages to 0 (clock skew safe)", () => {
    const future = inst({ createdAt: NOW + 2 * DAY });
    expect(estimateInstanceCostUsd(future, rate, NOW)).toBe(0);
    const backwards = inst({ status: "failed", createdAt: NOW - 1 * DAY, updatedAt: NOW - 3 * DAY });
    expect(estimateInstanceCostUsd(backwards, rate, NOW)).toBe(0);
  });

  it("rate 0 → 0 for any instance", () => {
    expect(estimateInstanceCostUsd(inst(), 0, NOW)).toBe(0);
    expect(estimateInstanceCostUsd(inst({ status: "failed" }), 0, NOW)).toBe(0);
  });
});

describe("estimateFleetCost — rollup", () => {
  const rate = 3;

  it("perDay = active count × rate; total sums active + frozen", () => {
    const instances: CostInstance[] = [
      inst({ status: "ready", createdAt: NOW - 2 * DAY }), // active, 2d → $6
      inst({ status: "provisioning", health: "provisioning", createdAt: NOW - 1 * DAY }), // active, 1d → $3
      inst({ status: "failed", createdAt: NOW - 5 * DAY, updatedAt: NOW - 3 * DAY }), // frozen 2d → $6
      inst({ status: "ready", health: "down", createdAt: NOW - 9 * DAY, updatedAt: NOW - 1 * DAY }), // down = inactive, frozen 8d → $24
    ];
    const roll = estimateFleetCost(instances, rate, NOW);
    expect(roll.activeCount).toBe(2);
    expect(roll.perDayUsd).toBe(6); // 2 active × $3
    expect(roll.totalToDateUsd).toBeCloseTo(6 + 3 + 6 + 24);
  });

  it("empty fleet → all zeros", () => {
    expect(estimateFleetCost([], rate, NOW)).toEqual({ perDayUsd: 0, totalToDateUsd: 0, activeCount: 0 });
  });

  it("rate 0 → perDay and total both 0 (active count still counted)", () => {
    const instances: CostInstance[] = [inst({ status: "ready" }), inst({ status: "failed" })];
    const roll = estimateFleetCost(instances, 0, NOW);
    expect(roll.perDayUsd).toBe(0);
    expect(roll.totalToDateUsd).toBe(0);
    expect(roll.activeCount).toBe(1);
  });
});

describe("formatUsd", () => {
  it("keeps cents under $100, whole dollars above", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(8.5)).toBe("$8.50");
    expect(formatUsd(1234.56)).toBe("$1,235");
  });

  it("clamps negatives to $0.00", () => {
    expect(formatUsd(-5)).toBe("$0.00");
  });
});
