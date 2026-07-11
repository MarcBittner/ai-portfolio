import { beforeEach, describe, expect, it } from "vitest";

import { MemoryDatabase } from "../lib/db/memory";
import type { Database } from "../lib/db/types";
import { repos } from "../lib/repos";
import {
  ensurePersonalSpace,
  isPersonalSpaceKey,
  isPersonalSpaceVisibleTo,
  personalSpaceKey,
} from "../lib/personalSpace";
import { authorize, loadPrincipal } from "../lib/authz";
import { cachedGrants, cachedSpacePolicy, invalidatePolicyCache } from "../lib/server/policyCache";
import { canAccess, type ResourceRef } from "../lib/permissions";

// Personal spaces — privacy is the point. These tests prove: (1) provisioning is
// idempotent; (2) the owner has full access while a different non-super user is
// denied; (3) an owner's personal doc is invisible to others; (4) even a Super
// Admin does not see another user's personal space in the sidebar LISTING.

describe("personalSpaceKey", () => {
  it("is a deterministic, unique-per-email slug under the ~ prefix", () => {
    expect(personalSpaceKey("marc.bittner@example.com")).toBe("~marc-bittner-example-com");
    // case + whitespace normalized (normalizeEmail), non-alnum runs collapsed
    expect(personalSpaceKey("  Marc.Bittner@example.com ")).toBe("~marc-bittner-example-com");
    // no leading/trailing dashes
    expect(personalSpaceKey("a_b@x.io")).toBe("~a-b-x-io");
    expect(isPersonalSpaceKey(personalSpaceKey("x@y.z"))).toBe(true);
    expect(isPersonalSpaceKey("eng")).toBe(false);
  });

  it("distinct emails get distinct keys", () => {
    expect(personalSpaceKey("a@example.com")).not.toBe(personalSpaceKey("b@example.com"));
  });
});

describe("ensurePersonalSpace — idempotent provisioning", () => {
  let db: Database;
  beforeEach(() => {
    db = new MemoryDatabase();
  });

  it("two calls produce exactly one space and one owner grant", async () => {
    const email = "Owner@example.com";
    const key = personalSpaceKey(email);
    await ensurePersonalSpace(db, email);
    await ensurePersonalSpace(db, email);

    const spaces = await repos(db).spaces.find({ key });
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({
      key,
      name: "Personal",
      contentRoot: key,
      defaultRole: "none",
      prWorkflow: false,
      owner: "owner@example.com", // normalized
    });

    const grants = await repos(db).grants.find({
      subjectType: "user",
      subjectId: "owner@example.com",
      resourceType: "space",
      resourcePath: key,
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ capability: "admin", effect: "allow", createdBy: "system" });
  });
});

describe("upsertUserOnLogin provisions the personal space", () => {
  it("creates the personal space + owner grant on login (idempotent)", async () => {
    const { upsertUserOnLogin } = await import("../lib/authz");
    const db = new MemoryDatabase();
    await upsertUserOnLogin(db, { email: "New.User@example.com", clerkId: "c1" }, {});
    await upsertUserOnLogin(db, { email: "new.user@example.com", clerkId: "c1" }, {}); // second login
    const key = personalSpaceKey("new.user@example.com");
    expect(await repos(db).spaces.find({ key })).toHaveLength(1);
    const space = await repos(db).spaces.findOne({ owner: "new.user@example.com" });
    expect(space?.key).toBe(key);
    expect(await repos(db).grants.find({ resourcePath: key, subjectType: "user" })).toHaveLength(1);
  });
});

describe("personal space access — owner vs other (via authorize / canAccess)", () => {
  let db: Database;
  const owner = "owner@example.com";
  const other = "other@example.com";
  let personalDoc: ResourceRef;

  beforeEach(async () => {
    db = new MemoryDatabase();
    const r = repos(db);
    await r.users.insert({ email: owner, role: "read", createdAt: 1 });
    await r.users.insert({ email: other, role: "editor", createdAt: 1 });
    await ensurePersonalSpace(db, owner);
    invalidatePolicyCache(db); // defend against any cross-test cache carryover
    const key = personalSpaceKey(owner);
    personalDoc = { type: "doc", path: `${key}/notes.md`, spaceKey: key };
  });

  it("owner has read + edit + admin on their personal space", async () => {
    expect((await authorize(db, owner, personalDoc, "read")).allowed).toBe(true);
    expect((await authorize(db, owner, personalDoc, "edit")).allowed).toBe(true);
    expect((await authorize(db, owner, personalDoc, "admin")).allowed).toBe(true);
  });

  it("a different non-super user is DENIED (closed default + no grant)", async () => {
    expect((await authorize(db, other, personalDoc, "read")).allowed).toBe(false);
    expect((await authorize(db, other, personalDoc, "edit")).allowed).toBe(false);
    expect((await authorize(db, other, personalDoc, "admin")).allowed).toBe(false);
  });
});

describe("isPersonalSpaceVisibleTo — sidebar visibility predicate", () => {
  it("shared spaces are always visible; a personal space only to its owner", () => {
    const ownerKey = personalSpaceKey("owner@example.com");
    // shared space: visible to anyone
    expect(isPersonalSpaceVisibleTo("eng", "anyone@example.com")).toBe(true);
    // owner sees their own
    expect(isPersonalSpaceVisibleTo(ownerKey, "Owner@example.com")).toBe(true);
    // a different user does NOT
    expect(isPersonalSpaceVisibleTo(ownerKey, "other@example.com")).toBe(false);
    // even a super admin's email doesn't match the owner key → hidden in the tree
    expect(isPersonalSpaceVisibleTo(ownerKey, "boss@example.com")).toBe(false);
  });
});

// End-to-end sidebar privacy: reproduce EXACTLY the two-stage filter that
// listReadableDocs applies (canAccess over grants/policy, THEN the personal-space
// visibility predicate) against a real store, and assert what each viewer sees.
// This proves requirements (3) owner's personal doc appears only for the owner,
// and (4) a Super Admin does NOT see another user's personal doc in the listing.
describe("sidebar listing privacy (listReadableDocs semantics)", () => {
  let db: Database;
  const owner = "owner@example.com";
  const other = "other@example.com";
  const boss = "boss@example.com";
  let ownerDocPath: string;
  let sharedDocPath: string;

  beforeEach(async () => {
    db = new MemoryDatabase();
    const r = repos(db);
    await r.users.insert({ email: owner, role: "read", createdAt: 1 });
    await r.users.insert({ email: other, role: "editor", createdAt: 1 });
    await r.users.insert({ email: boss, role: "super", createdAt: 1 });
    // Shared, open space so everyone can read the shared doc (sanity anchor).
    await r.spaces.insert({ key: "eng", name: "Eng", contentRoot: "eng", defaultRole: "read", prWorkflow: false });
    await ensurePersonalSpace(db, owner);
    invalidatePolicyCache(db);

    const pkey = personalSpaceKey(owner);
    ownerDocPath = `${pkey}/private.md`;
    sharedDocPath = "eng/readme.md";
    await r.docs.insert({
      path: ownerDocPath, spaceKey: pkey, title: "Private", headings: [], body: "", blobSha: "a", updatedAt: 1,
    });
    await r.docs.insert({
      path: sharedDocPath, spaceKey: "eng", title: "Readme", headings: [], body: "", blobSha: "b", updatedAt: 1,
    });
  });

  /** Mirror listReadableDocs: canAccess read-filter THEN personal-space visibility. */
  async function visiblePaths(email: string): Promise<string[]> {
    const principal = await loadPrincipal(db, email);
    if (!principal) return [];
    const grants = await cachedGrants(db);
    const docs = await repos(db).docs.find();
    const out: string[] = [];
    for (const d of docs) {
      if (!isPersonalSpaceVisibleTo(d.spaceKey, principal.email)) continue;
      const policy = await cachedSpacePolicy(db, d.spaceKey);
      if (canAccess(principal, { type: "doc", path: d.path, spaceKey: d.spaceKey }, "read", grants, policy).allowed) {
        out.push(d.path);
      }
    }
    return out.sort();
  }

  it("owner sees their personal doc AND the shared doc", async () => {
    expect(await visiblePaths(owner)).toEqual([sharedDocPath, ownerDocPath].sort());
  });

  it("another user sees the shared doc but NOT the owner's personal doc", async () => {
    const seen = await visiblePaths(other);
    expect(seen).toContain(sharedDocPath);
    expect(seen).not.toContain(ownerDocPath);
  });

  it("a Super Admin does NOT see the owner's personal doc in the listing", async () => {
    const seen = await visiblePaths(boss);
    expect(seen).toContain(sharedDocPath); // super sees shared content
    expect(seen).not.toContain(ownerDocPath); // but NOT another user's personal doc in the tree
  });
});
