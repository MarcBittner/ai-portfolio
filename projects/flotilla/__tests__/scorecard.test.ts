import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Role } from "@/lib/rbac";
import {
  scoreInstance,
  rollupScorecards,
  gradeForScore,
  CHECK_WEIGHTS,
  TOTAL_WEIGHT,
  type ScorecardInstance,
  type ScorecardContext,
  type ScoredInstance,
} from "../lib/scorecard.ts";

// ── Part 1: the pure scorer (no Mongo, no clock — `now`/`monitoringOn` injected) ──

const DAY = 86_400_000;
const NOW = 100 * DAY;

// A fully-passing instance fixture: owner set, masked, healthy, drift synced, TTL
// in the future. Every check flips off individually below.
function inst(over: Partial<ScorecardInstance> = {}): ScorecardInstance {
  return {
    status: "ready",
    health: "healthy",
    ownerEmail: "dev@example.com",
    scrubPII: true,
    masked: true,
    ttlHours: 24,
    expiresAt: NOW + DAY,
    drift: { status: "synced", reasons: [], checkedAt: NOW },
    ...over,
  };
}
const ctxOn: ScorecardContext = { now: NOW, monitoringOn: true };

describe("weights + grade boundaries", () => {
  it("check weights sum to exactly 100", () => {
    expect(TOTAL_WEIGHT).toBe(100);
    expect(Object.values(CHECK_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("grade boundaries: 90/80/70/60 cut points", () => {
    expect(gradeForScore(100)).toBe("A");
    expect(gradeForScore(90)).toBe("A");
    expect(gradeForScore(89)).toBe("B");
    expect(gradeForScore(80)).toBe("B");
    expect(gradeForScore(79)).toBe("C");
    expect(gradeForScore(70)).toBe("C");
    expect(gradeForScore(69)).toBe("D");
    expect(gradeForScore(60)).toBe("D");
    expect(gradeForScore(59)).toBe("F");
    expect(gradeForScore(0)).toBe("F");
  });
});

describe("all-pass and all-fail extremes", () => {
  it("all checks pass → 100 / A, every check pass=true", () => {
    const sc = scoreInstance(inst(), ctxOn);
    expect(sc.score).toBe(100);
    expect(sc.grade).toBe("A");
    expect(sc.checks.every((c) => c.pass)).toBe(true);
    expect(sc.checks).toHaveLength(6);
  });

  it("all checks fail → 0 / F, every check pass=false", () => {
    const allBad = inst({
      ownerEmail: undefined,
      scrubPII: true,
      masked: false, // scrub intended but imported unmasked
      health: "down",
      drift: { status: "outofsync", reasons: ["branch gone"], checkedAt: NOW },
      ttlHours: 24,
      expiresAt: NOW - DAY, // elapsed
    });
    const sc = scoreInstance(allBad, { now: NOW, monitoringOn: false });
    expect(sc.score).toBe(0);
    expect(sc.grade).toBe("F");
    expect(sc.checks.every((c) => !c.pass)).toBe(true);
  });
});

// Helper: score, then pull one check by key.
function check(sc: ReturnType<typeof scoreInstance>, key: string) {
  const c = sc.checks.find((x) => x.key === key);
  if (!c) throw new Error(`no check ${key}`);
  return c;
}

describe("ownerSet check", () => {
  it("passes with an ownerEmail", () => {
    expect(check(scoreInstance(inst(), ctxOn), "ownerSet").pass).toBe(true);
  });
  it("fails when ownerEmail absent or blank", () => {
    expect(check(scoreInstance(inst({ ownerEmail: undefined }), ctxOn), "ownerSet").pass).toBe(false);
    expect(check(scoreInstance(inst({ ownerEmail: "  " }), ctxOn), "ownerSet").pass).toBe(false);
  });
  it("weight docks exactly ownerSet's weight", () => {
    const sc = scoreInstance(inst({ ownerEmail: undefined }), ctxOn);
    expect(sc.score).toBe(100 - CHECK_WEIGHTS.ownerSet);
  });
});

describe("maskVerified check", () => {
  it("passes when scrub intended and masked=true", () => {
    expect(check(scoreInstance(inst({ scrubPII: true, masked: true }), ctxOn), "maskVerified").pass).toBe(true);
  });
  it("passes when scrub NOT requested (nothing to verify)", () => {
    expect(check(scoreInstance(inst({ scrubPII: false, masked: undefined }), ctxOn), "maskVerified").pass).toBe(true);
  });
  it("fails when scrub intended but imported unmasked (masked=false)", () => {
    expect(check(scoreInstance(inst({ scrubPII: true, masked: false }), ctxOn), "maskVerified").pass).toBe(false);
  });
  it("fails when scrub intended but never verified (masked undefined)", () => {
    expect(check(scoreInstance(inst({ scrubPII: true, masked: undefined }), ctxOn), "maskVerified").pass).toBe(false);
  });
});

describe("withinTtl check", () => {
  it("passes with no TTL (intentionally permanent)", () => {
    expect(check(scoreInstance(inst({ ttlHours: undefined, expiresAt: undefined }), ctxOn), "withinTtl").pass).toBe(true);
  });
  it("passes when TTL set and expiresAt in the future", () => {
    expect(check(scoreInstance(inst({ ttlHours: 24, expiresAt: NOW + DAY }), ctxOn), "withinTtl").pass).toBe(true);
  });
  it("fails when TTL elapsed", () => {
    expect(check(scoreInstance(inst({ ttlHours: 24, expiresAt: NOW - 1 }), ctxOn), "withinTtl").pass).toBe(false);
  });
});

describe("monitoringOn check", () => {
  it("passes when ctx.monitoringOn true", () => {
    expect(check(scoreInstance(inst(), { now: NOW, monitoringOn: true }), "monitoringOn").pass).toBe(true);
  });
  it("fails when false", () => {
    expect(check(scoreInstance(inst(), { now: NOW, monitoringOn: false }), "monitoringOn").pass).toBe(false);
  });
  it("fails (indeterminate) when undefined, with honest detail", () => {
    const c = check(scoreInstance(inst(), { now: NOW }), "monitoringOn");
    expect(c.pass).toBe(false);
    expect(c.detail).toMatch(/cannot verify/i);
  });
});

describe("driftClean check", () => {
  it("passes only on synced", () => {
    expect(check(scoreInstance(inst({ drift: { status: "synced", reasons: [], checkedAt: NOW } }), ctxOn), "driftClean").pass).toBe(true);
  });
  it("fails on outofsync (detail carries reasons)", () => {
    const c = check(scoreInstance(inst({ drift: { status: "outofsync", reasons: ["stale data"], checkedAt: NOW } }), ctxOn), "driftClean");
    expect(c.pass).toBe(false);
    expect(c.detail).toMatch(/stale data/);
  });
  it("fails when drift never computed (undefined)", () => {
    const c = check(scoreInstance(inst({ drift: undefined }), ctxOn), "driftClean");
    expect(c.pass).toBe(false);
    expect(c.detail).toMatch(/not yet computed/i);
  });
});

describe("healthHealthy check", () => {
  it("passes on healthy", () => {
    expect(check(scoreInstance(inst({ health: "healthy" }), ctxOn), "healthHealthy").pass).toBe(true);
  });
  it("fails on degraded/down/unknown", () => {
    for (const h of ["degraded", "down", "unknown", ""]) {
      expect(check(scoreInstance(inst({ health: h }), ctxOn), "healthHealthy").pass).toBe(false);
    }
  });
});

describe("partial score arithmetic + grade", () => {
  it("owner+mask fail → 50 / F", () => {
    const sc = scoreInstance(inst({ ownerEmail: undefined, masked: false }), ctxOn);
    expect(sc.score).toBe(100 - CHECK_WEIGHTS.ownerSet - CHECK_WEIGHTS.maskVerified); // 50
    expect(sc.grade).toBe("F");
  });
  it("only monitoring off → 90 / A", () => {
    const sc = scoreInstance(inst(), { now: NOW, monitoringOn: false });
    expect(sc.score).toBe(100 - CHECK_WEIGHTS.monitoringOn); // 90
    expect(sc.grade).toBe("A");
  });
});

describe("rollupScorecards", () => {
  const mk = (id: string, over: Partial<ScorecardInstance>, ctx = ctxOn): ScoredInstance => ({
    id,
    name: id,
    scorecard: scoreInstance(inst(over), ctx),
  });

  it("empty fleet → zeros", () => {
    const r = rollupScorecards([]);
    expect(r).toEqual({ count: 0, byGrade: { A: 0, B: 0, C: 0, D: 0, F: 0 }, averageScore: 0, withFailures: 0 });
  });

  it("counts by grade, averages, and withFailures", () => {
    const scored = [
      mk("a", {}), // 100 A, no failures
      mk("b", {}, { now: NOW, monitoringOn: false }), // 90 A, 1 failure
      mk("c", { ownerEmail: undefined, masked: false }), // 50 F
    ];
    const r = rollupScorecards(scored);
    expect(r.count).toBe(3);
    expect(r.byGrade.A).toBe(2);
    expect(r.byGrade.F).toBe(1);
    expect(r.averageScore).toBe(Math.round((100 + 90 + 50) / 3)); // 80
    expect(r.withFailures).toBe(2);
  });
});

describe("determinism", () => {
  it("same input → identical output", () => {
    const a = scoreInstance(inst(), ctxOn);
    const b = scoreInstance(inst(), ctxOn);
    expect(a).toEqual(b);
  });
});

// ── Part 2: the API route (read gate + flag-off 403 + rollup shape) ─────────────

vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  const getDb = async () => fakeDb;
  return {
    db: getDb,
    metricsDb: getDb,
    metricsUriConfigured: () => true,
    COLLECTIONS: {
      instances: "flotilla_instances",
      audit: "flotilla_audit",
      config: "flotilla_config",
      monitors: "flotilla_monitors",
    },
    BACKUP_BUCKET: "flotilla_backup_files",
  };
});

let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));

import { resetStore } from "./helpers/fakeMongo";
import { __resetConfigCache } from "@/lib/models/config";
import { createInstance } from "@/lib/models/instances";
import { GET as scorecardsGET } from "@/app/api/instances/scorecards/route";

function req(qs = "") {
  return new Request(`http://localhost/api/instances/scorecards${qs}`);
}
async function readJson(res: Response) {
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const savedFlag = process.env.FLOTILLA_FEATURE_FLEET_SCORECARDS;
beforeEach(() => {
  resetStore();
  __resetConfigCache();
  principal = null;
  process.env.FLOTILLA_FEATURE_FLEET_SCORECARDS = "true"; // flag ON via env fallback
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.FLOTILLA_FEATURE_FLEET_SCORECARDS;
  else process.env.FLOTILLA_FEATURE_FLEET_SCORECARDS = savedFlag;
  __resetConfigCache();
});

describe("GET /api/instances/scorecards — auth + flag gate", () => {
  it("no principal → 401", async () => {
    principal = null;
    expect((await readJson(await scorecardsGET(req()))).status).toBe(401);
  });

  it("flag OFF → 403 (past the read gate)", async () => {
    principal = { kind: "clerk", id: "ro@example.com", role: "read-only" };
    process.env.FLOTILLA_FEATURE_FLEET_SCORECARDS = "false";
    __resetConfigCache();
    const { status, json } = await readJson(await scorecardsGET(req()));
    expect(status).toBe(403);
    expect(json.error).toBe("fleetScorecards feature is disabled");
  });

  it("read-only + flag ON → 200 with scored + rollup shape", async () => {
    principal = { kind: "clerk", id: "ro@example.com", role: "read-only" };
    await createInstance({ branch: "main", ownerEmail: "dev@example.com", scrubPII: false });
    const { status, json } = await readJson(await scorecardsGET(req()));
    expect(status).toBe(200);
    expect(Array.isArray(json.scored)).toBe(true);
    const rollup = json.rollup as Record<string, unknown>;
    expect(rollup).toBeTruthy();
    expect(rollup.count).toBe(1);
    expect(rollup).toHaveProperty("byGrade");
    expect(rollup).toHaveProperty("averageScore");
    expect(rollup).toHaveProperty("withFailures");
    const scored = json.scored as Array<{ scorecard: { checks: unknown[] } }>;
    expect(scored[0].scorecard.checks).toHaveLength(6);
  });
});
