import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@/lib/rbac";

// PERF-P2: GET /instances/:id/drift now reads the STORED drift (recomputed off the
// request path by the worker sweep) and only recomputes inline on ?refresh=1 or
// when nothing is stored yet. These tests assert that contract + the freshness
// marker + the preserved driftBadges flag-gating.

let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));

const { getInstance, getFeatureFlags, saveInstanceDrift, computeInstanceDrift } = vi.hoisted(() => ({
  getInstance: vi.fn(),
  getFeatureFlags: vi.fn(),
  saveInstanceDrift: vi.fn(async () => {}),
  computeInstanceDrift: vi.fn(),
}));
vi.mock("@/lib/models", () => ({ getInstance, getFeatureFlags, saveInstanceDrift }));
vi.mock("@/lib/drift", () => ({ computeInstanceDrift }));

import { GET } from "@/app/api/instances/[id]/drift/route";

function call(id: string, query = "") {
  return GET(new Request(`http://localhost/api/instances/${id}/drift${query}`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  principal = { kind: "clerk", id: "op@example.com", role: "write" as Role };
  getInstance.mockReset();
  getFeatureFlags.mockReset();
  saveInstanceDrift.mockReset();
  computeInstanceDrift.mockReset();
  getFeatureFlags.mockResolvedValue({ driftBadges: true });
  saveInstanceDrift.mockResolvedValue(undefined);
});

describe("GET /instances/:id/drift (PERF-P2)", () => {
  it("403s when the driftBadges flag is off (posture preserved)", async () => {
    getFeatureFlags.mockResolvedValue({ driftBadges: false });
    const res = await call("inst_1");
    expect(res.status).toBe(403);
    expect(computeInstanceDrift).not.toHaveBeenCalled();
  });

  it("returns the STORED drift without recomputing on a plain GET", async () => {
    const stored = { status: "synced", reasons: [], checkedAt: 100 };
    getInstance.mockResolvedValue({ id: "inst_1", status: "ready", drift: stored, driftComputedAt: 100 });
    const res = await call("inst_1");
    const body = (await res.json()) as { drift: unknown; source: string; computedAt: number };
    expect(computeInstanceDrift).not.toHaveBeenCalled();
    expect(body.drift).toEqual(stored);
    expect(body.source).toBe("stored");
    expect(body.computedAt).toBe(100);
  });

  it("recomputes + persists inline when nothing is stored yet", async () => {
    getInstance.mockResolvedValue({ id: "inst_1", status: "ready" }); // no drift field
    computeInstanceDrift.mockResolvedValue({ status: "outofsync", reasons: ["x"], checkedAt: 200 });
    const res = await call("inst_1");
    const body = (await res.json()) as { drift: { status: string }; source: string };
    expect(computeInstanceDrift).toHaveBeenCalledTimes(1);
    expect(saveInstanceDrift).toHaveBeenCalledWith("inst_1", { status: "outofsync", reasons: ["x"], checkedAt: 200 });
    expect(body.drift.status).toBe("outofsync");
    expect(body.source).toBe("computed");
  });

  it("?refresh=1 forces an inline recompute even when a stored result exists", async () => {
    getInstance.mockResolvedValue({ id: "inst_1", status: "ready", drift: { status: "synced", reasons: [], checkedAt: 1 } });
    computeInstanceDrift.mockResolvedValue({ status: "synced", reasons: [], checkedAt: 300 });
    const res = await call("inst_1", "?refresh=1");
    const body = (await res.json()) as { source: string };
    expect(computeInstanceDrift).toHaveBeenCalledTimes(1);
    expect(body.source).toBe("refresh");
  });

  it("degrades to unknown (not 500) when the inline recompute throws", async () => {
    getInstance.mockResolvedValue({ id: "inst_1", status: "ready" });
    computeInstanceDrift.mockRejectedValue(new Error("upstream down"));
    const res = await call("inst_1");
    const body = (await res.json()) as { drift: { status: string }; source: string };
    expect(res.status).toBe(200);
    expect(body.drift.status).toBe("unknown");
    expect(body.source).toBe("error");
  });

  it("404s an unknown instance", async () => {
    getInstance.mockResolvedValue(null);
    const res = await call("nope");
    expect(res.status).toBe(404);
  });
});
