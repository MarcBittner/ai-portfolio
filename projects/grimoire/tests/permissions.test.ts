import { describe, expect, it } from "vitest";

import {
  canAccess,
  canGlobal,
  canSetRole,
  type Grant,
  type Principal,
  type ResourceRef,
  type SpacePolicy,
} from "../lib/permissions";

// ---- fixtures ----
const reader: Principal = { email: "r@example.com", role: "read", groupKeys: [] };
const editor: Principal = { email: "e@example.com", role: "editor", groupKeys: ["eng"] };
const admin: Principal = { email: "a@example.com", role: "admin", groupKeys: [] };
const sup: Principal = { email: "s@example.com", role: "super", groupKeys: [] };

const doc: ResourceRef = { type: "doc", path: "eng/runbooks/oncall.md", spaceKey: "eng" };
const closed: SpacePolicy = { defaultRole: "none" };
const open: SpacePolicy = { defaultRole: "read" };

const g = (p: Partial<Grant>): Grant => ({
  subjectType: "role",
  subjectId: "read",
  resourceType: "space",
  resourcePath: "eng",
  capability: "read",
  effect: "allow",
  ...p,
});

describe("canAccess — role short-circuits", () => {
  it("super admin can do anything, even with no grants", () => {
    expect(canAccess(sup, doc, "admin", [], closed).allowed).toBe(true);
  });

  it("admin is NOT a resource short-circuit (scope-bound like an editor)", () => {
    // §6: admins edit within granted scope; global power is via canGlobal.
    expect(canAccess(admin, doc, "edit", [], closed).allowed).toBe(false);
  });
});

describe("canAccess — space default", () => {
  it("open space grants read to everyone", () => {
    expect(canAccess(reader, doc, "read", [], open).allowed).toBe(true);
  });
  it("open space default does NOT grant edit", () => {
    expect(canAccess(reader, doc, "edit", [], open).allowed).toBe(false);
  });
  it("closed space denies read with no grant", () => {
    expect(canAccess(reader, doc, "read", [], closed).allowed).toBe(false);
  });
});

describe("canAccess — grants by subject", () => {
  it("role:editor allow edit on space → editor can edit", () => {
    const grants = [g({ subjectId: "editor", capability: "edit" })];
    expect(canAccess(editor, doc, "edit", grants, closed).allowed).toBe(true);
  });
  it("role grants are additive: role:read covers an editor (read-or-above)", () => {
    const grants = [g({ subjectId: "read", capability: "read" })];
    expect(canAccess(editor, doc, "read", grants, closed).allowed).toBe(true);
  });
  it("role:editor grant does NOT cover a plain reader", () => {
    const grants = [g({ subjectId: "editor", capability: "edit" })];
    expect(canAccess(reader, doc, "edit", grants, closed).allowed).toBe(false);
  });
  it("group grant matches a member", () => {
    const grants = [g({ subjectType: "group", subjectId: "eng", capability: "edit" })];
    expect(canAccess(editor, doc, "edit", grants, closed).allowed).toBe(true);
  });
  it("group grant does not match a non-member", () => {
    const grants = [g({ subjectType: "group", subjectId: "eng", capability: "edit" })];
    expect(canAccess(reader, doc, "edit", grants, closed).allowed).toBe(false);
  });
  it("user grant matches by email (case-insensitive)", () => {
    const grants = [
      g({ subjectType: "user", subjectId: "R@example.COM", resourceType: "doc", resourcePath: doc.path, capability: "edit" }),
    ];
    expect(canAccess(reader, doc, "edit", grants, closed).allowed).toBe(true);
  });
});

describe("canAccess — capability ranking", () => {
  it("an admin-capability grant implies edit and read", () => {
    const grants = [g({ subjectId: "editor", capability: "admin" })];
    expect(canAccess(editor, doc, "read", grants, closed).allowed).toBe(true);
    expect(canAccess(editor, doc, "edit", grants, closed).allowed).toBe(true);
    expect(canAccess(editor, doc, "admin", grants, closed).allowed).toBe(true);
  });
  it("a read grant does NOT imply edit", () => {
    const grants = [g({ subjectId: "read", capability: "read" })];
    expect(canAccess(editor, doc, "edit", grants, closed).allowed).toBe(false);
  });
});

describe("canAccess — deny wins at any specificity", () => {
  it("a broad space deny overrides a specific doc allow", () => {
    const grants = [
      g({ subjectType: "group", subjectId: "eng", resourceType: "doc", resourcePath: doc.path, capability: "edit", effect: "allow" }),
      g({ subjectType: "role", subjectId: "read", resourceType: "space", resourcePath: "eng", capability: "read", effect: "deny" }),
    ];
    const d = canAccess(editor, doc, "read", grants, open);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("deny");
  });
  it("deny at a folder blocks docs beneath it", () => {
    const grants = [
      g({ subjectType: "group", subjectId: "eng", resourceType: "folder", resourcePath: "eng/runbooks", capability: "read", effect: "deny" }),
    ];
    expect(canAccess(editor, doc, "read", grants, open).allowed).toBe(false);
  });
});

describe("resourceMatches — folder boundary", () => {
  it("folder grant matches a nested doc", () => {
    const grants = [g({ resourceType: "folder", resourcePath: "eng/runbooks", capability: "edit" , subjectId: "editor"})];
    expect(canAccess(editor, doc, "edit", grants, closed).allowed).toBe(true);
  });
  it("folder grant does NOT match a sibling prefix (eng/run vs eng/runbooks)", () => {
    const grants = [g({ resourceType: "folder", resourcePath: "eng/run", capability: "edit", subjectId: "editor" })];
    expect(canAccess(editor, doc, "edit", grants, closed).allowed).toBe(false);
  });
});

describe("canGlobal + canSetRole — §6 boundary", () => {
  it("admin can manage permissions/groups/roles-up-to-editor + view audit", () => {
    expect(canGlobal(admin, "managePermissions")).toBe(true);
    expect(canGlobal(admin, "manageGroupsScopes")).toBe(true);
    expect(canGlobal(admin, "viewAudit")).toBe(true);
  });
  it("admin CANNOT assign admins or change org config", () => {
    expect(canGlobal(admin, "assignAdmin")).toBe(false);
    expect(canGlobal(admin, "orgConfig")).toBe(false);
    expect(canGlobal(admin, "assignSuperAdmin")).toBe(false);
  });
  it("super can do all global actions", () => {
    expect(canGlobal(sup, "assignAdmin")).toBe(true);
    expect(canGlobal(sup, "orgConfig")).toBe(true);
    expect(canGlobal(sup, "assignSuperAdmin")).toBe(true);
  });
  it("editor/reader have no global powers", () => {
    expect(canGlobal(editor, "managePermissions")).toBe(false);
    expect(canGlobal(reader, "viewAudit")).toBe(false);
  });
  it("canSetRole: admin up to editor only; super any", () => {
    expect(canSetRole(admin, "editor")).toBe(true);
    expect(canSetRole(admin, "admin")).toBe(false);
    expect(canSetRole(admin, "super")).toBe(false);
    expect(canSetRole(sup, "super")).toBe(true);
    expect(canSetRole(editor, "read")).toBe(false);
  });
});
