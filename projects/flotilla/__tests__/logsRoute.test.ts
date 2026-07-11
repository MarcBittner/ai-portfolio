import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@/lib/rbac";

// Perf-plan Tier-A (A3): GET /api/logs used to emit the payload TWICE — the unified
// `entries` AND a legacy `logs: sysDocs` (raw system LogDocs) — ~doubling a 222KB
// response. The legacy field is removed and the default page size lowered 500 → 200.
// These tests pin the trimmed contract: `entries` present, NO `logs` field, and the
// default/explicit limit honored (capped at 2000).

const { queryLogs } = vi.hoisted(() => ({
  queryLogs: vi.fn(async (_q: { instanceId?: string; limit: number }) => [] as Array<Record<string, unknown>>),
}));

vi.mock("@/lib/models", () => ({
  queryLogs,
  listAudit: vi.fn(async () => []),
  getInstance: vi.fn(async () => null),
  recordAudit: vi.fn(async () => {}), // lib/api imports this
}));
vi.mock("@/lib/clients/vercel", () => ({ makeVercelClient: () => ({ getDeploymentLogs: vi.fn(async () => []) }) }));

let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));

import { GET } from "@/app/api/logs/route";

beforeEach(() => {
  queryLogs.mockClear();
  principal = { kind: "clerk", id: "super@example.com", role: "super-admin" };
});

async function call(url: string) {
  const res = await GET(new Request(url));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/logs trimmed payload (A3)", () => {
  it("returns `entries` and does NOT include the removed legacy `logs` field", async () => {
    const { status, json } = await call("http://t/api/logs");
    expect(status).toBe(200);
    expect(json).toHaveProperty("entries");
    expect(json).toHaveProperty("links");
    expect(json).not.toHaveProperty("logs");
  });

  it("defaults the limit to 200 (down from 500)", async () => {
    await call("http://t/api/logs");
    expect(queryLogs).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
  });

  it("honors an explicit ?limit= up to the 2000 cap", async () => {
    await call("http://t/api/logs?limit=50");
    expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 50 }));
    await call("http://t/api/logs?limit=99999");
    expect(queryLogs).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 2000 }));
  });
});
