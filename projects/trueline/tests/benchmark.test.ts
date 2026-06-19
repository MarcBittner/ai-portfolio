import { describe, it, expect } from "vitest";
import { BENCHMARK_INVOICES, scoreBenchmark } from "../convex/lib/benchmark";

// The benchmark is the engine's regression gate. It is deterministic, so we pin its
// exact numbers — a change here means the flag engine's behavior changed, and that
// should be a conscious, reviewed edit, not a silent drift.
describe("scoreBenchmark", () => {
  const score = scoreBenchmark();

  it("covers all 18 labeled invoices", () => {
    expect(BENCHMARK_INVOICES).toHaveLength(18);
    expect(score.n).toBe(18);
  });

  it("flags every real issue and nothing else (precision = recall = 1)", () => {
    expect(score.flagPrecision).toBe(1);
    expect(score.flagRecall).toBe(1);
  });

  it("reports the pinned math-consistency", () => {
    expect(score.extractionAccuracy).toBe(0.871);
  });

  it("every metric is a rounded ratio in [0, 1]", () => {
    for (const v of [score.extractionAccuracy, score.flagPrecision, score.flagRecall]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(Math.round(v * 1000) / 1000).toBe(v);
    }
  });
});
