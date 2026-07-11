import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Role } from "@/lib/rbac";

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
    },
    BACKUP_BUCKET: "backup_files",
  };
});

// A mutable principal so each test drives withOperator with a chosen role. The
// route imports withOperator (which imports getPrincipal from "./auth"); mocking
// "@/lib/auth" intercepts the same resolved module.
let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));

// Mock Clerk's server client so the invite branch's best-effort invitation email
// is observable without hitting the real Clerk API. The route dynamically imports
// this module; vi.mock intercepts the dynamic import too. Hoisted so the factory
// can reference the spies. getUserList drives the existing-vs-new Clerk-user
// branch; createInvitation is only reached when no Clerk user exists.
const { createInvitation, getUserList } = vi.hoisted(() => ({
  createInvitation: vi.fn(),
  getUserList: vi.fn(),
}));
vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    invitations: { createInvitation },
    users: { getUserList },
  }),
}));

import { resetStore } from "./helpers/fakeMongo";
import { GET, POST, DELETE } from "@/app/api/access/route";
import { POST as templatesPOST } from "@/app/api/templates/route";
import { provisionDashboardUser, getDashboardUserByEmail } from "@/lib/models/dashboardUsers.ts";

function asRole(role: Role, id = `${role}@example.com`) {
  principal = { kind: "clerk", id, role };
}
async function readJson(res: Response) {
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
function jsonReq(method: string, body: Record<string, unknown>) {
  return new Request("http://localhost/api/access", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetStore();
  principal = null;
  // Env-driven, generic owners (nothing org-specific hardcoded). The suite's
  // immutable-superadmin cases reference these three.
  process.env.FLOTILLA_IMMUTABLE_SUPERADMINS = "owner@example.com, owner2@example.com, owner3@example.com";
  delete process.env.FLOTILLA_PUBLIC_READONLY;
});

describe("withOperator enforcement", () => {
  it("401 when unauthenticated", async () => {
    principal = null;
    const { status } = await readJson(await GET());
    expect(status).toBe(401);
  });

  it("read-only is blocked from a write mutation (POST /api/templates → 403)", async () => {
    asRole("read-only");
    const req = new Request("http://localhost/api/templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "t", kind: "preview" }),
    });
    const { status } = await readJson(await templatesPOST(req));
    expect(status).toBe(403);
  });

  it("write is blocked from role-management (GET /api/access → 403)", async () => {
    asRole("write");
    const { status } = await readJson(await GET());
    expect(status).toBe(403);
  });
});

describe("GET /api/access", () => {
  it("admin sees the user list + their own role", async () => {
    await provisionDashboardUser("someone@example.com", "write");
    asRole("admin");
    const { status, json } = await readJson(await GET());
    expect(status).toBe(200);
    expect(json.role).toBe("admin");
    expect(Array.isArray(json.users)).toBe(true);
    expect((json.immutable as string[]).length).toBe(3);
  });
});

describe("invite", () => {
  const savedSecret = process.env.CLERK_SECRET_KEY;
  beforeEach(() => {
    createInvitation.mockReset();
    getUserList.mockReset();
    // Default: no existing Clerk user, so the invite branch proceeds to createInvitation.
    getUserList.mockResolvedValue({ data: [], totalCount: 0 });
    delete process.env.CLERK_SECRET_KEY; // default: Clerk not configured (degraded path)
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = savedSecret;
  });

  it("admin invites a read-only user (default role)", async () => {
    asRole("admin");
    const { status, json } = await readJson(await POST(jsonReq("POST", { action: "invite", email: "New@Example.com" })));
    expect(status).toBe(200);
    expect((json.user as { role: string }).role).toBe("read-only");
    expect((await getDashboardUserByEmail("new@example.com"))?.role).toBe("read-only");
  });

  it("admin invites a write user within the grant boundary — record carries that role", async () => {
    asRole("admin");
    const { status, json } = await readJson(
      await POST(jsonReq("POST", { action: "invite", email: "writer@example.com", role: "write" })),
    );
    expect(status).toBe(200);
    expect((json.user as { role: string }).role).toBe("write");
    expect((await getDashboardUserByEmail("writer@example.com"))?.role).toBe("write");
  });

  it("admin CANNOT invite an admin (above grant boundary → 403, no row created)", async () => {
    asRole("admin");
    const { status } = await readJson(
      await POST(jsonReq("POST", { action: "invite", email: "newadmin@example.com", role: "admin" })),
    );
    expect(status).toBe(403);
    expect(await getDashboardUserByEmail("newadmin@example.com")).toBeNull();
  });

  it("super-admin CAN invite an admin", async () => {
    asRole("super-admin");
    const { status, json } = await readJson(
      await POST(jsonReq("POST", { action: "invite", email: "newadmin@example.com", role: "admin" })),
    );
    expect(status).toBe(200);
    expect((json.user as { role: string }).role).toBe("admin");
  });

  it("sends a Clerk invitation email when Clerk is configured and no Clerk user exists (emailSent:true)", async () => {
    process.env.CLERK_SECRET_KEY = "sk_test_123";
    getUserList.mockResolvedValue({ data: [], totalCount: 0 });
    createInvitation.mockResolvedValue({ id: "inv_1" });
    asRole("admin");
    const { status, json } = await readJson(await POST(jsonReq("POST", { action: "invite", email: "mailme@example.com" })));
    expect(status).toBe(200);
    expect(json.emailSent).toBe(true);
    expect(getUserList).toHaveBeenCalledWith(expect.objectContaining({ emailAddress: ["mailme@example.com"] }));
    expect(createInvitation).toHaveBeenCalledTimes(1);
    expect(createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ emailAddress: "mailme@example.com", ignoreExisting: true }),
    );
  });

  it("does NOT createInvitation when a Clerk user already exists — grants access, emailSent:false", async () => {
    process.env.CLERK_SECRET_KEY = "sk_test_123";
    getUserList.mockResolvedValue({ data: [{ id: "user_1" }], totalCount: 1 });
    asRole("admin");
    const { status, json } = await readJson(
      await POST(jsonReq("POST", { action: "invite", email: "existing@example.com", role: "write" })),
    );
    expect(status).toBe(200);
    expect(json.emailSent).toBe(false);
    expect(json.alreadyExists).toBe(true);
    expect(json.emailNote).toBe("user already has a Clerk account — granted access, no invite needed");
    // Clerk was probed but NOT invited — an existing user can already sign in.
    expect(getUserList).toHaveBeenCalledWith(expect.objectContaining({ emailAddress: ["existing@example.com"] }));
    expect(createInvitation).not.toHaveBeenCalled();
    // Access record is still created (the source of truth) with the requested role.
    expect((await getDashboardUserByEmail("existing@example.com"))?.role).toBe("write");
  });

  it("degrades to emailSent:false when Clerk is not configured — invite still succeeds", async () => {
    delete process.env.CLERK_SECRET_KEY;
    asRole("admin");
    const { status, json } = await readJson(await POST(jsonReq("POST", { action: "invite", email: "nomail@example.com" })));
    expect(status).toBe(200);
    expect(json.emailSent).toBe(false);
    expect(json.emailNote).toBe("Clerk not configured");
    expect(createInvitation).not.toHaveBeenCalled();
    // DB record is the source of truth — it exists regardless of email.
    expect((await getDashboardUserByEmail("nomail@example.com"))?.role).toBe("read-only");
  });

  it("degrades to emailSent:false when the Clerk call throws — invite still succeeds", async () => {
    process.env.CLERK_SECRET_KEY = "sk_test_123";
    createInvitation.mockRejectedValue(new Error("clerk boom"));
    asRole("admin");
    const { status, json } = await readJson(await POST(jsonReq("POST", { action: "invite", email: "boom@example.com" })));
    expect(status).toBe(200);
    expect(json.emailSent).toBe(false);
    expect(json.emailNote).toBe("clerk boom");
    expect((await getDashboardUserByEmail("boom@example.com"))?.role).toBe("read-only");
  });
});

describe("set-role grant boundary", () => {
  beforeEach(async () => {
    await provisionDashboardUser("worker@example.com", "write");
    await provisionDashboardUser("boss@example.com", "super-admin");
  });

  it("admin CANNOT promote a write user to admin (403)", async () => {
    asRole("admin");
    const { status } = await readJson(await POST(jsonReq("POST", { action: "set-role", email: "worker@example.com", role: "admin" })));
    expect(status).toBe(403);
    expect((await getDashboardUserByEmail("worker@example.com"))?.role).toBe("write");
  });

  it("admin CANNOT demote a super-admin (403)", async () => {
    asRole("admin");
    const { status } = await readJson(await POST(jsonReq("POST", { action: "set-role", email: "boss@example.com", role: "write" })));
    expect(status).toBe(403);
  });

  it("admin CAN move a user between read-only and write", async () => {
    asRole("admin");
    const { status, json } = await readJson(await POST(jsonReq("POST", { action: "set-role", email: "worker@example.com", role: "read-only" })));
    expect(status).toBe(200);
    expect((json.user as { role: string }).role).toBe("read-only");
  });

  it("super-admin CAN promote to admin", async () => {
    asRole("super-admin");
    const { status, json } = await readJson(await POST(jsonReq("POST", { action: "set-role", email: "worker@example.com", role: "admin" })));
    expect(status).toBe(200);
    expect((json.user as { role: string }).role).toBe("admin");
  });

  it("an immutable super-admin can never be demoted (403)", async () => {
    asRole("super-admin");
    const { status } = await readJson(await POST(jsonReq("POST", { action: "set-role", email: "owner@example.com", role: "read-only" })));
    expect(status).toBe(403);
  });
});

// Grant boundary (operator-confirmed 2026-07-05): admins manage NON-admin users
// fully — including disable/enable and remove — but may not touch an admin or
// super-admin. Super-admins manage admins.
describe("disable / remove (admins manage non-admin users)", () => {
  beforeEach(async () => {
    await provisionDashboardUser("target@example.com", "write");
  });

  it("admin CAN disable a non-admin (write) user", async () => {
    asRole("admin");
    const { status, json } = await readJson(await POST(jsonReq("POST", { action: "disable", email: "target@example.com" })));
    expect(status).toBe(200);
    expect((json.user as { disabled: boolean }).disabled).toBe(true);
  });

  it("admin CAN remove a non-admin (write) user", async () => {
    asRole("admin");
    const req = new Request("http://localhost/api/access?email=target@example.com", { method: "DELETE" });
    const { status } = await readJson(await DELETE(req));
    expect(status).toBe(200);
    expect(await getDashboardUserByEmail("target@example.com")).toBeNull();
  });

  it("admin CANNOT disable an admin (403)", async () => {
    await provisionDashboardUser("peer@example.com", "admin");
    asRole("admin");
    const { status } = await readJson(await POST(jsonReq("POST", { action: "disable", email: "peer@example.com" })));
    expect(status).toBe(403);
  });

  it("admin CANNOT remove an admin (403)", async () => {
    await provisionDashboardUser("peer@example.com", "admin");
    asRole("admin");
    const req = new Request("http://localhost/api/access?email=peer@example.com", { method: "DELETE" });
    const { status } = await readJson(await DELETE(req));
    expect(status).toBe(403);
  });

  it("super-admin can disable then remove a user", async () => {
    asRole("super-admin");
    const dis = await readJson(await POST(jsonReq("POST", { action: "disable", email: "target@example.com" })));
    expect(dis.status).toBe(200);
    expect((dis.json.user as { disabled: boolean }).disabled).toBe(true);
    const req = new Request("http://localhost/api/access?email=target@example.com", { method: "DELETE" });
    const { status } = await readJson(await DELETE(req));
    expect(status).toBe(200);
    expect(await getDashboardUserByEmail("target@example.com")).toBeNull();
  });

  it("an immutable super-admin can never be removed (403)", async () => {
    asRole("super-admin");
    const req = new Request("http://localhost/api/access?email=owner2@example.com", { method: "DELETE" });
    const { status } = await readJson(await DELETE(req));
    expect(status).toBe(403);
  });
});

describe("last-super-admin lockout guard", () => {
  it("demoting a stored super-admin is allowed because the two immutables always remain", async () => {
    // The invariant the guard protects: effective super-admins never drops below
    // the two immutable ones, so a legitimate demote is permitted (never a false
    // 409) and true lockout is structurally impossible.
    await provisionDashboardUser("extra@example.com", "super-admin");
    asRole("super-admin");
    const { status } = await readJson(await POST(jsonReq("POST", { action: "set-role", email: "extra@example.com", role: "read-only" })));
    expect(status).toBe(200);
  });
});
