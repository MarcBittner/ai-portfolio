import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@/lib/rbac";

// API-1 fix: POST /api/users performs credential-class Clerk user mutations, so it
// must require "admin" — not the read-only default. In-memory Mongo so the denial
// audit write runs without Atlas.
vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  return { db: async () => fakeDb, COLLECTIONS: { audit: "audit", users: "users", instances: "instances" } };
});

// Mutable principal so each test drives withOperator with a chosen role.
let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));

// The Clerk user client is only reached AFTER the auth gate passes; stub it.
vi.mock("@/lib/loaders", () => ({ loadClerkUserClient: async () => ({ impl: {} }) }));

import { resetStore } from "./helpers/fakeMongo";
import { POST } from "@/app/api/users/route";

function asRole(role: Role) {
  principal = { kind: "clerk", id: `${role}@example.com`, role };
}
function post(body: Record<string, unknown>) {
  return new Request("http://localhost/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetStore();
  principal = null;
});

describe("POST /api/users — admin gate (API-1 fix)", () => {
  it("unauthenticated → 401", async () => {
    expect((await POST(post({ action: "create" }))).status).toBe(401);
  });
  it("a READ-ONLY operator is blocked by the admin floor → 403", async () => {
    asRole("read-only");
    const res = await POST(post({ action: "sign-in-link", id: "u1", clerkInstance: "dev", clerkUserId: "cu1" }));
    expect(res.status).toBe(403);
  });
  it("a WRITE operator is blocked by the admin floor → 403", async () => {
    asRole("write");
    expect((await POST(post({ action: "create", instanceId: "i1", email: "a@b.com" }))).status).toBe(403);
  });
  it("an ADMIN operator passes the gate (reaches the handler) → not 401/403", async () => {
    asRole("admin");
    const res = await POST(post({ action: "bogus" }));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400); // "unknown action" — proves it cleared the gate
  });
});
