import { beforeEach, describe, expect, it } from "vitest";

import { MemoryDatabase } from "../lib/db/memory";
import type { Database } from "../lib/db/types";
import { authorize, loadPrincipal, upsertUserOnLogin } from "../lib/authz";
import { repos } from "../lib/repos";
import type { ResourceRef } from "../lib/permissions";

// End-to-end integration: identity → store → resolver. Proves the RBAC system
// works against a real datastore (the in-memory adapter; Mongo meets the same
// contract), not just at the unit level.

const ENV: Record<string, string | undefined> = {
  SEED_SUPER_ADMINS: "marc.bittner@gmail.com,marc.bittner@example.com",
};
const doc: ResourceRef = { type: "doc", path: "eng/runbooks/oncall.md", spaceKey: "eng" };

describe("upsertUserOnLogin", () => {
  let db: Database;
  beforeEach(() => {
    db = new MemoryDatabase();
  });

  it("seed emails are elevated to super (idempotent)", async () => {
    const u = await upsertUserOnLogin(db, { email: "Marc.Bittner@example.com", clerkId: "c1" }, ENV);
    expect(u.role).toBe("super");
    const again = await upsertUserOnLogin(db, { email: "marc.bittner@example.com", clerkId: "c1" }, ENV);
    expect(again.role).toBe("super");
    expect(await repos(db).users.count()).toBe(1); // no dup
  });

  it("first-time non-seed users default to guest (open-signup demo default)", async () => {
    const u = await upsertUserOnLogin(db, { email: "new@example.com", clerkId: "c2" }, ENV);
    expect(u.role).toBe("guest");
  });

  it("writes an audit row when a role is elevated", async () => {
    await repos(db).users.insert({ email: "marc.bittner@gmail.com", role: "read", createdAt: 1 });
    await upsertUserOnLogin(db, { email: "marc.bittner@gmail.com", clerkId: "c3" }, ENV);
    const audit = await repos(db).audit.find({ action: "role.elevate" });
    expect(audit).toHaveLength(1);
    expect(audit[0].after).toBe("super");
  });
});

describe("authorize — end to end", () => {
  let db: Database;
  beforeEach(async () => {
    db = new MemoryDatabase();
    const r = repos(db);
    await r.spaces.insert({ key: "eng", name: "Engineering", contentRoot: "eng", defaultRole: "none", prWorkflow: false });
    await r.users.insert({ email: "viewer@example.com", role: "read", createdAt: 1 });
    await r.users.insert({ email: "ed@example.com", role: "editor", createdAt: 1 });
    await r.users.insert({ email: "boss@example.com", role: "super", createdAt: 1 });
    await r.groups.insert({ key: "eng-team", name: "Eng" });
    await r.members.insert({ groupKey: "eng-team", email: "ed@example.com" });
  });

  it("denies an unknown user", async () => {
    expect((await authorize(db, "ghost@example.com", doc, "read")).allowed).toBe(false);
  });

  it("denies a viewer with no grant in a closed space", async () => {
    expect((await authorize(db, "viewer@example.com", doc, "read")).allowed).toBe(false);
  });

  it("super admin is allowed anywhere", async () => {
    expect((await authorize(db, "boss@example.com", doc, "admin")).allowed).toBe(true);
  });

  it("a group grant lets the editor edit", async () => {
    await repos(db).grants.insert({
      subjectType: "group", subjectId: "eng-team", resourceType: "space", resourcePath: "eng",
      capability: "edit", effect: "allow", createdAt: 1,
    });
    expect((await authorize(db, "ed@example.com", doc, "edit")).allowed).toBe(true);
    // viewer (not in group) still denied
    expect((await authorize(db, "viewer@example.com", doc, "edit")).allowed).toBe(false);
  });

  it("a folder deny overrides the group allow (deny wins)", async () => {
    const r = repos(db);
    await r.grants.insert({
      subjectType: "group", subjectId: "eng-team", resourceType: "space", resourcePath: "eng",
      capability: "edit", effect: "allow", createdAt: 1,
    });
    await r.grants.insert({
      subjectType: "group", subjectId: "eng-team", resourceType: "folder", resourcePath: "eng/runbooks",
      capability: "read", effect: "deny", createdAt: 2,
    });
    const d = await authorize(db, "ed@example.com", doc, "read");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("deny");
  });

  it("loadPrincipal reflects role + group memberships", async () => {
    const p = await loadPrincipal(db, "ed@example.com");
    expect(p).toEqual({ email: "ed@example.com", role: "editor", groupKeys: ["eng-team"] });
  });
});
