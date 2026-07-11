import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@/lib/rbac";

// API-2 fix: GET /api/testing/gate must never trigger the billable Anthropic call;
// POST computes at most once per run version, then both methods read the cache.
let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));
vi.mock("@/lib/clients/anthropic", () => ({ anthropicConfigured: () => true }));

const { gateVerdictSpy } = vi.hoisted(() => ({
  gateVerdictSpy: vi.fn(async (_runId?: string) => ({ verdict: { decision: "promote" }, model: "m", checkedAt: 1 })),
}));
vi.mock("@/lib/aiSmokeGate", () => ({ gateVerdict: gateVerdictSpy }));

// In-memory cache + one terminal run — no Mongo needed.
const cache = new Map<string, unknown>();
const run = { runId: "r1", kind: "smoke", status: "passed", updatedAt: 100 };
vi.mock("@/lib/models", () => ({
  getTestRun: async (id: string) => (id === run.runId ? run : null),
  getFeatureFlags: async () => ({ aiSmokeGate: true }),
  recordAudit: async () => {},
  getCachedGateVerdict: async (runId: string, version: number) => cache.get(`${runId}:${version}`) ?? null,
  putCachedGateVerdict: async (runId: string, version: number, outcome: unknown) => {
    cache.set(`${runId}:${version}`, outcome);
  },
}));

import { GET, POST } from "@/app/api/testing/gate/route";

function asRole(role: Role) {
  principal = { kind: "clerk", id: `${role}@example.com`, role };
}
function get(runId: string) {
  return new Request(`http://localhost/api/testing/gate?runId=${runId}`);
}
function post(runId: string) {
  return new Request("http://localhost/api/testing/gate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId }),
  });
}

beforeEach(() => {
  cache.clear();
  gateVerdictSpy.mockClear();
  principal = null;
});

describe("GET/POST /api/testing/gate — verdict cache (API-2)", () => {
  it("GET on a cache miss returns 409 and NEVER computes (no billable call)", async () => {
    asRole("read-only");
    const res = await GET(get("r1"));
    expect(res.status).toBe(409);
    expect(gateVerdictSpy).toHaveBeenCalledTimes(0);
  });

  it("POST computes once, caches; subsequent GET + POST are free (cache hits)", async () => {
    asRole("read-only");
    // First POST: computes (billable) once.
    const p1 = await POST(post("r1"));
    expect(p1.status).toBe(200);
    expect(gateVerdictSpy).toHaveBeenCalledTimes(1);
    // GET now returns the cached verdict — no new compute.
    const g = await GET(get("r1"));
    const gj = (await g.json()) as { cached?: boolean };
    expect(g.status).toBe(200);
    expect(gj.cached).toBe(true);
    expect(gateVerdictSpy).toHaveBeenCalledTimes(1);
    // Repeat POST: also served from cache — still one compute total.
    await POST(post("r1"));
    expect(gateVerdictSpy).toHaveBeenCalledTimes(1);
  });

  it("unknown run → 404 before any compute", async () => {
    asRole("read-only");
    const res = await POST(post("nope"));
    expect(res.status).toBe(404);
    expect(gateVerdictSpy).toHaveBeenCalledTimes(0);
  });
});
