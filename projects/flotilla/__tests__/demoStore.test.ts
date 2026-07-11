import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Role } from "@/lib/rbac";

// PUBLIC READ-ONLY DEMO — self-contained (NO external Mongo). The public Render
// deploy sets FLOTILLA_PUBLIC_READONLY=1 and leaves MONGODB_URI UNSET. In that mode
// lib/mongo.ts must serve an IN-MEMORY store seeded from lib/seedDemo.ts instead of
// crashing (mongo.ts previously threw "MONGODB_URI is not set" on the first read).
//
// Unlike guestTier.test.ts, this suite deliberately does NOT mock @/lib/mongo — it
// exercises the REAL db()→memoryStore fallback end to end. `uri` is captured at
// mongo.ts module-load, so MONGODB_URI must be absent BEFORE the imports evaluate:
// vi.hoisted() runs before the static imports below.
vi.hoisted(() => {
  delete process.env.MONGODB_URI;
  process.env.FLOTILLA_PUBLIC_READONLY = "1";
});

// Drive withOperator with a chosen identity + the middleware-stamped method, exactly
// as the guest-tier suite does. Everything else (mongo) is the real code path.
let principal: { kind: "clerk" | "breakglass" | "guest"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));

let reqMethod: string | null = null;
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (k: string) => (k.toLowerCase() === "x-flotilla-method" ? reqMethod : null),
  }),
}));

import { GET as INSTANCES_GET, POST as INSTANCES_POST } from "@/app/api/instances/route";
import { GET as HEALTH_GET } from "@/app/api/health/route";

const GUEST = { kind: "guest" as const, id: "guest:public", role: "guest" as Role };

function jsonReq(url: string, method: string, body: Record<string, unknown> = {}) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  principal = null;
  reqMethod = null;
  process.env.FLOTILLA_PUBLIC_READONLY = "1";
  delete process.env.MONGODB_URI;
});
afterEach(() => {
  delete process.env.FLOTILLA_PUBLIC_READONLY;
});

describe("public read-only demo — no MONGODB_URI, in-memory seeded fleet", () => {
  it("guest GET /api/instances returns the seeded demo fleet (non-empty)", async () => {
    principal = GUEST;
    reqMethod = "GET";
    const res = await INSTANCES_GET(new Request("http://localhost/api/instances"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instances?: unknown[]; degraded?: boolean };
    // The seam served real seeded data — NOT the safeRead degraded empty fallback.
    expect(body.degraded).toBeUndefined();
    expect(Array.isArray(body.instances)).toBe(true);
    expect(body.instances!.length).toBeGreaterThan(0);
    // A stable synthetic demo id from lib/seedDemo.ts (inst_demo_<slug>) proves the
    // data is the seed fleet, not some incidental row.
    const ids = (body.instances as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain("inst_demo_trueline");
  });

  it("mutation still 403s under the kill-switch (even authenticated super-admin)", async () => {
    // The in-memory store is READ-ONLY because the kill-switch 403s the mutation in
    // withOperator BEFORE any store write — regardless of role. Prove it for a
    // super-admin, the strongest identity.
    principal = { kind: "breakglass", id: "owner@example.com", role: "super-admin" };
    reqMethod = "POST";
    const res = await INSTANCES_POST(
      jsonReq("http://localhost/api/instances", "POST", { kind: "preview", branch: "main" }),
    );
    expect(res.status).toBe(403);
  });

  it("guest mutation also 403s (fail-closed)", async () => {
    principal = GUEST;
    reqMethod = "POST";
    const res = await INSTANCES_POST(
      jsonReq("http://localhost/api/instances", "POST", { kind: "preview", branch: "main" }),
    );
    expect(res.status).toBe(403);
  });

  it("health route stays a plain unauthenticated 200 with no Mongo", async () => {
    const res = await HEALTH_GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; service?: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("flotilla");
  });
});
