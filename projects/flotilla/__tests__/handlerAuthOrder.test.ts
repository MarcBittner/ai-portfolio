import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@/lib/rbac";

// API-3 + API-4: authenticate before any request-shape feedback, with the standard
// JSON 401 shape.
let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));
vi.mock("@/lib/models", () => ({
  recordAudit: async () => {},
  deleteTemplate: async () => {},
  listTemplates: async () => [],
  createTemplate: async () => ({}),
  getJob: async () => null,
  queryLogs: async () => [],
}));

import { DELETE } from "@/app/api/templates/route";
import { GET as streamGET } from "@/app/api/jobs/[id]/stream/route";

function asRole(role: Role) {
  principal = { kind: "clerk", id: `${role}@example.com`, role };
}
beforeEach(() => {
  principal = null;
});

describe("DELETE /api/templates — auth before validation (API-4)", () => {
  it("unauthenticated DELETE with no id → 401 (not a 400 param oracle)", async () => {
    const res = await DELETE(new Request("http://localhost/api/templates", { method: "DELETE" }));
    expect(res.status).toBe(401);
  });
  it("read-only DELETE (below write floor) → 403", async () => {
    asRole("read-only");
    const res = await DELETE(new Request("http://localhost/api/templates?id=t1", { method: "DELETE" }));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/jobs/[id]/stream — consistent 401 shape (API-3)", () => {
  it("unauthenticated → 401 with JSON { error } (not plaintext)", async () => {
    const res = await streamGET(new Request("http://localhost/api/jobs/j1/stream"), {
      params: Promise.resolve({ id: "j1" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
  });
});
