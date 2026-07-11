import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Role } from "@/lib/rbac";

// PUBLIC GUEST TIER (SAFETY-CRITICAL — this deploy is public). The public read-only
// tier (FLOTILLA_PUBLIC_READONLY=1) resolves an unauthenticated visitor to a `guest`
// principal (lib/auth.ts). withOperator (lib/api.ts) must:
//   • let a guest through SAFE (GET/HEAD) read routes → 200, and
//   • hard-reject a guest from EVERY mutating/destructive route → 403,
//     both by method (any non-GET) AND by minRole (any route ≥ write / admin),
//     regardless of what minRole the route passed.
// The method comes from the middleware-stamped `x-flotilla-method` header, which we
// drive here via the next/headers mock (as httpCaching.test.ts does).

vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  return {
    db: async () => fakeDb,
    COLLECTIONS: {
      dashboardUsers: "dashboardUsers",
      audit: "audit",
      templates: "templates",
      jobs: "jobs",
      instances: "instances",
      logs: "logs",
      config: "config",
      configHistory: "configHistory",
    },
    BACKUP_BUCKET: "backup_files",
  };
});

// A mutable principal so each test drives withOperator with a chosen identity.
let principal: { kind: "clerk" | "breakglass" | "guest"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));

// The request method that middleware would have stamped as x-flotilla-method.
let reqMethod: string | null = null;
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (k: string) => (k.toLowerCase() === "x-flotilla-method" ? reqMethod : null),
  }),
}));

import { resetStore } from "./helpers/fakeMongo";
import { GET as INSTANCES_GET, POST as INSTANCES_POST } from "@/app/api/instances/route";
import { GET as TEMPLATES_GET, POST as TEMPLATES_POST, DELETE as TEMPLATES_DELETE } from "@/app/api/templates/route";
import { DELETE as INSTANCE_DELETE } from "@/app/api/instances/[id]/route";
import { GET as ACCESS_GET } from "@/app/api/access/route";
import { GET as QUEUE_GET, POST as QUEUE_POST } from "@/app/api/queue/route";

const GUEST = { kind: "guest" as const, id: "guest:public", role: "guest" as Role };

function jsonReq(url: string, method: string, body: Record<string, unknown> = {}) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetStore();
  principal = null;
  reqMethod = null;
  // The guest-vs-owner suites below exercise the ROLE-based guest guard, which is
  // independent of the global kill-switch. Keep the kill-switch OFF here so an
  // authenticated write can still 200; the kill-switch has its own suite at the end.
  delete process.env.FLOTILLA_PUBLIC_READONLY;
});

describe("guest tier — reads (200)", () => {
  it("guest GET /api/instances → 200 (view-only fleet read)", async () => {
    principal = GUEST;
    reqMethod = "GET";
    const res = await INSTANCES_GET(new Request("http://localhost/api/instances"));
    expect(res.status).toBe(200);
  });

  it("guest GET /api/templates → 200", async () => {
    principal = GUEST;
    reqMethod = "GET";
    const res = await TEMPLATES_GET();
    expect(res.status).toBe(200);
  });

  it("guest GET /api/queue → 200", async () => {
    principal = GUEST;
    reqMethod = "GET";
    const res = await QUEUE_GET();
    expect(res.status).toBe(200);
  });
});

describe("guest tier — mutations hard-rejected (403)", () => {
  it("guest POST /api/instances (provision) → 403", async () => {
    principal = GUEST;
    reqMethod = "POST";
    const res = await INSTANCES_POST(jsonReq("http://localhost/api/instances", "POST", { kind: "preview", branch: "main" }));
    expect(res.status).toBe(403);
  });

  it("guest POST /api/templates (create) → 403", async () => {
    principal = GUEST;
    reqMethod = "POST";
    const res = await TEMPLATES_POST(jsonReq("http://localhost/api/templates", "POST", { name: "t", kind: "preview" }));
    expect(res.status).toBe(403);
  });

  it("guest DELETE /api/templates → 403", async () => {
    principal = GUEST;
    reqMethod = "DELETE";
    const res = await TEMPLATES_DELETE(new Request("http://localhost/api/templates?id=t1", { method: "DELETE" }));
    expect(res.status).toBe(403);
  });

  it("guest DELETE /api/instances/[id] (teardown) → 403", async () => {
    principal = GUEST;
    reqMethod = "DELETE";
    const res = await INSTANCE_DELETE(new Request("http://localhost/api/instances/i1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "i1" }),
    });
    expect(res.status).toBe(403);
  });

  it("guest POST /api/queue (requeue/mutate) → 403", async () => {
    principal = GUEST;
    reqMethod = "POST";
    const res = await QUEUE_POST(jsonReq("http://localhost/api/queue", "POST", { action: "requeue", jobId: "j1" }));
    expect(res.status).toBe(403);
  });

  it("guest is 403'd on an admin-gated GET (/api/access) — read method, elevated role", async () => {
    principal = GUEST;
    reqMethod = "GET";
    const res = await ACCESS_GET();
    expect(res.status).toBe(403);
  });

  it("fails CLOSED: guest POST with a MISSING method header → 403 (not served)", async () => {
    principal = GUEST;
    reqMethod = null; // middleware header absent → treated as unsafe for a guest
    const res = await INSTANCES_POST(jsonReq("http://localhost/api/instances", "POST", { kind: "preview", branch: "main" }));
    expect(res.status).toBe(403);
  });

  it("fails CLOSED: a spoofed safe method on a write route is still 403 (minRole guard)", async () => {
    // Even if a caller could force x-flotilla-method=GET onto a mutating handler, the
    // minRole ≥ write guard independently blocks the guest.
    principal = GUEST;
    reqMethod = "GET";
    const res = await INSTANCES_POST(jsonReq("http://localhost/api/instances", "POST", { kind: "preview", branch: "main" }));
    expect(res.status).toBe(403);
  });
});

describe("guest tier — owner still has full access", () => {
  it("an authenticated write principal can POST /api/templates (not a guest)", async () => {
    principal = { kind: "clerk", id: "owner@example.com", role: "write" };
    reqMethod = "POST";
    const res = await TEMPLATES_POST(
      jsonReq("http://localhost/api/templates", "POST", { name: "t", branch: "main", backupRef: "snap-1" }),
    );
    expect(res.status).toBe(200);
  });
});

// GLOBAL KILL-SWITCH (SAFETY-CRITICAL). With FLOTILLA_PUBLIC_READONLY=1 the public
// deploy is a total read-only showcase: EVERY mutation is blocked REGARDLESS of
// role — even a super-admin — while reads still pass. This is belt-and-suspenders
// on top of the guest guard so a misconfigured/authenticated editor session can
// never mutate the shared public fleet.
describe("public kill-switch — mutations blocked regardless of role", () => {
  beforeEach(() => {
    process.env.FLOTILLA_PUBLIC_READONLY = "1";
  });
  afterEach(() => {
    delete process.env.FLOTILLA_PUBLIC_READONLY;
  });

  it("super-admin POST /api/templates (create) → 403 on the public deploy", async () => {
    principal = { kind: "breakglass", id: "owner@example.com", role: "super-admin" };
    reqMethod = "POST";
    const res = await TEMPLATES_POST(
      jsonReq("http://localhost/api/templates", "POST", { name: "t", branch: "main", backupRef: "snap-1" }),
    );
    expect(res.status).toBe(403);
  });

  it("super-admin DELETE /api/instances/[id] (teardown) → 403 on the public deploy", async () => {
    principal = { kind: "breakglass", id: "owner@example.com", role: "super-admin" };
    reqMethod = "DELETE";
    const res = await INSTANCE_DELETE(new Request("http://localhost/api/instances/i1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "i1" }),
    });
    expect(res.status).toBe(403);
  });

  it("super-admin POST /api/instances (provision) → 403 on the public deploy", async () => {
    principal = { kind: "breakglass", id: "owner@example.com", role: "super-admin" };
    reqMethod = "POST";
    const res = await INSTANCES_POST(jsonReq("http://localhost/api/instances", "POST", { kind: "preview", branch: "main" }));
    expect(res.status).toBe(403);
  });

  it("fails CLOSED: super-admin write route with a MISSING method header → 403", async () => {
    principal = { kind: "breakglass", id: "owner@example.com", role: "super-admin" };
    reqMethod = null;
    const res = await INSTANCES_POST(jsonReq("http://localhost/api/instances", "POST", { kind: "preview", branch: "main" }));
    expect(res.status).toBe(403);
  });

  it("reads still pass on the public deploy: super-admin GET /api/instances → 200", async () => {
    principal = { kind: "breakglass", id: "owner@example.com", role: "super-admin" };
    reqMethod = "GET";
    const res = await INSTANCES_GET(new Request("http://localhost/api/instances"));
    expect(res.status).toBe(200);
  });

  it("guest read still passes on the public deploy: GET /api/instances → 200", async () => {
    principal = GUEST;
    reqMethod = "GET";
    const res = await INSTANCES_GET(new Request("http://localhost/api/instances"));
    expect(res.status).toBe(200);
  });
});
