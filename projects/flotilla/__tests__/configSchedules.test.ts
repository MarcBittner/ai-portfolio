import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// In-memory Mongo so the singleton upsert + the config-history collection run
// without Atlas. Includes every collection the model touches.
vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  return {
    db: async () => fakeDb,
    COLLECTIONS: { config: "config", configHistory: "configHistory" },
  };
});

import { resetStore } from "./helpers/fakeMongo";
import {
  getConfig,
  getFeatureFlags,
  updateFeatures,
  detectStaleFlags,
  listConfigHistory,
  pruneExpiredSchedules,
  scheduleActiveAt,
  scheduleExpiredAt,
  FeatureSchedule,
  FeatureSchedulePatch,
  __resetConfigCache,
} from "@/lib/models";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000; // fixed epoch base for deterministic windows

beforeEach(() => {
  resetStore();
  __resetConfigCache();
});

// Isolate the env vars the flag layer reads so a test doesn't leak into the next.
const ENV_VARS = ["FLOTILLA_FEATURE_COST_ESTIMATES", "FLOTILLA_FLAG_STALE_AFTER_DAYS"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("scheduleActiveAt / scheduleExpiredAt — pure window math", () => {
  it("open window (no bounds) is always active, never expired", () => {
    const s: FeatureSchedule = { value: true };
    expect(scheduleActiveAt(s, T0)).toBe(true);
    expect(scheduleExpiredAt(s, T0)).toBe(false);
  });

  it("[activateAt, expiresAt) is half-open — inclusive start, exclusive end", () => {
    const s: FeatureSchedule = { value: true, activateAt: T0, expiresAt: T0 + DAY };
    expect(scheduleActiveAt(s, T0 - 1)).toBe(false); // before start
    expect(scheduleActiveAt(s, T0)).toBe(true); // inclusive start
    expect(scheduleActiveAt(s, T0 + DAY - 1)).toBe(true); // still inside
    expect(scheduleActiveAt(s, T0 + DAY)).toBe(false); // exclusive end
    expect(scheduleExpiredAt(s, T0 + DAY - 1)).toBe(false);
    expect(scheduleExpiredAt(s, T0 + DAY)).toBe(true);
  });
});

describe("getConfig — schedule window resolution", () => {
  it("an override BEFORE activateAt falls through to env/default (scheduledInactive)", async () => {
    await updateFeatures({}, "op", { costEstimates: { value: true, activateAt: T0 + DAY } });
    const view = await getConfig(T0); // now is before the turn-on
    expect(view.features.costEstimates).toBe(false); // default, not the stored `true`
    expect(view.featureFields.costEstimates.overriddenBy).toBe("default");
    expect(view.featureFields.costEstimates.scheduledInactive).toBe(true);
    expect(view.featureFields.costEstimates.schedule?.activateAt).toBe(T0 + DAY);
  });

  it("an override INSIDE its window applies (stored)", async () => {
    await updateFeatures({}, "op", { costEstimates: { value: true, activateAt: T0, expiresAt: T0 + DAY } });
    const view = await getConfig(T0 + DAY / 2);
    expect(view.features.costEstimates).toBe(true);
    expect(view.featureFields.costEstimates.overriddenBy).toBe("stored");
    expect(view.featureFields.costEstimates.scheduledInactive).toBeUndefined();
  });

  it("an override AFTER expiresAt falls through to env/default (auto-revert)", async () => {
    process.env.FLOTILLA_FEATURE_COST_ESTIMATES = "1"; // env says ON
    __resetConfigCache();
    await updateFeatures({}, "op", { costEstimates: { value: false, expiresAt: T0 + DAY } });
    // Inside the window: the stored override wins (OFF).
    let view = await getConfig(T0);
    expect(view.features.costEstimates).toBe(false);
    expect(view.featureFields.costEstimates.overriddenBy).toBe("stored");
    // After expiry: reverts to env (ON).
    view = await getConfig(T0 + DAY + 1);
    expect(view.features.costEstimates).toBe(true);
    expect(view.featureFields.costEstimates.overriddenBy).toBe("env");
    expect(view.featureFields.costEstimates.scheduledInactive).toBe(true);
  });

  it("getFeatureFlags honors the window at the real now (open window = active)", async () => {
    await updateFeatures({ costEstimates: true }); // plain boolean, no schedule
    const flags = await getFeatureFlags();
    expect(flags.costEstimates).toBe(true);
  });
});

describe("back-compat — a plain boolean override is unchanged by schedules", () => {
  it("a plain override with no schedule is ALWAYS in window (behaves as before)", async () => {
    await updateFeatures({ costEstimates: true });
    const view = await getConfig(T0);
    expect(view.features.costEstimates).toBe(true);
    expect(view.featureFields.costEstimates.overriddenBy).toBe("stored");
    expect(view.featureFields.costEstimates.schedule).toBeUndefined();
    expect(view.featureFields.costEstimates.scheduledInactive).toBeUndefined();
  });

  it("a schedule SUPERSEDES a plain boolean for the same flag", async () => {
    await updateFeatures({ costEstimates: true }); // plain ON
    await updateFeatures({}, "op", { costEstimates: { value: true, activateAt: T0 + DAY } }); // scheduled future
    const view = await getConfig(T0); // before turn-on → default despite the plain ON
    expect(view.features.costEstimates).toBe(false);
    expect(view.featureFields.costEstimates.overriddenBy).toBe("default");
  });

  it("clearing a schedule (null) reverts to the plain boolean", async () => {
    await updateFeatures({ costEstimates: true });
    await updateFeatures({}, "op", { costEstimates: { value: true, activateAt: T0 + DAY } });
    await updateFeatures({}, "op", { costEstimates: null }); // clear the window
    const view = await getConfig(T0);
    expect(view.features.costEstimates).toBe(true); // plain boolean back in force
    expect(view.featureFields.costEstimates.overriddenBy).toBe("stored");
  });
});

describe("stale / redundant detection", () => {
  it("flags an ON override older than the stale threshold", async () => {
    process.env.FLOTILLA_FLAG_STALE_AFTER_DAYS = "30";
    __resetConfigCache();
    // updatedAt is real now; ask at now+31d.
    await updateFeatures({ costEstimates: true });
    const at = Date.now() + 31 * DAY;
    const view = await getConfig(at);
    expect(view.featureFields.costEstimates.stale).toBe(true);
    const stale = await detectStaleFlags(at);
    expect(stale.some((s) => s.key === "costEstimates" && s.stale)).toBe(true);
  });

  it("does NOT flag a recent override as stale", async () => {
    await updateFeatures({ costEstimates: true });
    const view = await getConfig();
    expect(view.featureFields.costEstimates.stale).toBeUndefined();
  });

  it("flags a redundant override (matches env/default)", async () => {
    // Default for costEstimates is false; store an override of false → redundant.
    await updateFeatures({ costEstimates: false });
    const view = await getConfig();
    expect(view.featureFields.costEstimates.redundant).toBe(true);
    const stale = await detectStaleFlags();
    expect(stale.some((s) => s.key === "costEstimates" && s.redundant)).toBe(true);
  });

  it("an OFF override is never stale (a suppression, not a rollout)", async () => {
    await updateFeatures({ deadLetterQueue: false }); // default ON → override OFF (not redundant)
    const view = await getConfig(Date.now() + 400 * DAY);
    expect(view.featureFields.deadLetterQueue.stale).toBeUndefined();
    expect(view.featureFields.deadLetterQueue.redundant).toBeUndefined();
  });
});

describe("change history", () => {
  it("records a per-key before→after entry on a feature write", async () => {
    await updateFeatures({ costEstimates: true }, "op@x.com");
    const hist = await listConfigHistory();
    expect(hist.length).toBe(1);
    expect(hist[0].actor).toBe("op@x.com");
    const entry = hist[0].entries.find((e) => e.key === "features.costEstimates");
    expect(entry).toBeDefined();
    expect(entry?.before).toBe(false);
    expect(entry?.after).toBe(true);
  });

  it("carries an optional reason + the schedule window", async () => {
    await updateFeatures(
      {},
      "op@x.com",
      { costEstimates: { value: true, expiresAt: T0 + DAY } },
      "Q3 rollout",
    );
    const hist = await listConfigHistory();
    expect(hist[0].reason).toBe("Q3 rollout");
    const entry = hist[0].entries.find((e) => e.key === "features.costEstimates");
    expect(entry?.schedule?.expiresAt).toBe(T0 + DAY);
  });

  it("is most-recent-first", async () => {
    await updateFeatures({ costEstimates: true }, "a");
    await updateFeatures({ costEstimates: false }, "b");
    const hist = await listConfigHistory();
    expect(hist[0].actor).toBe("b");
    expect(hist[1].actor).toBe("a");
  });
});

describe("pruneExpiredSchedules — lazy-on-read cleanup", () => {
  it("removes an expired schedule entry + records an auto-expire history note", async () => {
    await updateFeatures({}, "op", { costEstimates: { value: true, expiresAt: T0 + DAY } });
    const removed = await pruneExpiredSchedules(T0 + DAY + 1);
    expect(removed).toContain("costEstimates");
    // Entry is gone from the doc now.
    __resetConfigCache();
    const view = await getConfig(T0 + DAY + 1);
    expect(view.featureFields.costEstimates.schedule).toBeUndefined();
    const hist = await listConfigHistory();
    expect(hist.some((h) => h.actor === "system:auto-expire")).toBe(true);
  });

  it("leaves a still-active schedule alone", async () => {
    await updateFeatures({}, "op", { costEstimates: { value: true, expiresAt: T0 + 10 * DAY } });
    const removed = await pruneExpiredSchedules(T0);
    expect(removed).toEqual([]);
  });
});

describe("FeatureSchedule / FeatureSchedulePatch — validation", () => {
  it("rejects activateAt >= expiresAt", () => {
    expect(() => FeatureSchedule.parse({ value: true, activateAt: T0 + DAY, expiresAt: T0 })).toThrow();
  });

  it("accepts open bounds", () => {
    expect(FeatureSchedule.parse({ value: true })).toEqual({ value: true });
    expect(FeatureSchedule.parse({ value: false, expiresAt: T0 })).toMatchObject({ value: false, expiresAt: T0 });
  });

  it("the patch accepts null (clear) and rejects an unknown flag", () => {
    expect(FeatureSchedulePatch.parse({ costEstimates: null })).toEqual({ costEstimates: null });
    expect(() => FeatureSchedulePatch.parse({ notAFlag: { value: true } })).toThrow();
  });
});
