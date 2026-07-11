import { beforeEach, describe, expect, it } from "vitest";

import { MemoryDatabase } from "../lib/db/memory";
import type { Database } from "../lib/db/types";
import { repos } from "../lib/repos";
import { authorize, loadPrincipal, upsertUserOnLogin } from "../lib/authz";
import { canSelfSignUp, isOpenSignup } from "../lib/authPolicy";
import {
  GUEST_DOC_TTL_MS,
  guestExpiryAt,
  guestExpiryFields,
  isExpiredGuestDoc,
  isGuestRole,
} from "../lib/guest";
import { sweepExpiredDocs } from "../lib/reaper";
import { ensurePersonalSpace, personalSpaceKey } from "../lib/personalSpace";
import { canAccess, type Principal, type ResourceRef } from "../lib/permissions";
import { cachedGrants, cachedSpacePolicy, invalidatePolicyCache } from "../lib/server/policyCache";
import { INDEX_SPECS } from "../lib/db/mongo";
import { searchReadable } from "../lib/search";

// Grimoire guest tier + 8h TTL + curated public-read. Proves the whole feature
// against the in-memory store (the portfolio demo default: no Mongo, no GitHub).

// ---------------------------------------------------------------------------
// 1. Open self-signup
// ---------------------------------------------------------------------------
describe("open self-signup", () => {
  it("isOpenSignup: unset / empty / '*' are open; a concrete domain is gated", () => {
    expect(isOpenSignup(undefined)).toBe(true);
    expect(isOpenSignup("")).toBe(true);
    expect(isOpenSignup("  ")).toBe(true);
    expect(isOpenSignup("*")).toBe(true);
    expect(isOpenSignup("acme.com")).toBe(false);
  });

  it("any VERIFIED email may sign up when the domain gate is open (default)", () => {
    expect(canSelfSignUp({ email: "anyone@example.com", emailVerified: true })).toBe(true);
    expect(canSelfSignUp({ email: "someone@gmail.com", emailVerified: true, allowedDomain: "*" })).toBe(true);
    // unverified is still rejected
    expect(canSelfSignUp({ email: "anyone@example.com", emailVerified: false })).toBe(false);
  });

  it("a concrete SIGNUP_ALLOWED_DOMAIN restricts signup to that one domain", () => {
    expect(canSelfSignUp({ email: "a@acme.com", emailVerified: true, allowedDomain: "acme.com" })).toBe(true);
    expect(canSelfSignUp({ email: "a@other.com", emailVerified: true, allowedDomain: "acme.com" })).toBe(false);
  });

  it("seed admins are always allowed, even unverified / off-domain", () => {
    const seed = new Set(["boss@acme.com"]);
    expect(
      canSelfSignUp({ email: "boss@acme.com", emailVerified: false, allowedDomain: "acme.com", seedSuperAdmins: seed }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. A new self-signup user is a guest
// ---------------------------------------------------------------------------
describe("first login role", () => {
  let db: Database;
  beforeEach(() => {
    db = new MemoryDatabase();
  });

  it("a new self-signup user gets role 'guest'", async () => {
    const u = await upsertUserOnLogin(db, { email: "newbie@example.com", clerkId: "c1" }, {});
    expect(u.role).toBe("guest");
  });

  it("a seed super admin is still elevated to super, not guest", async () => {
    const u = await upsertUserOnLogin(
      db,
      { email: "boss@acme.com" },
      { SEED_SUPER_ADMINS: "boss@acme.com" },
    );
    expect(u.role).toBe("super");
  });

  it("provisions the guest's personal space on first login", async () => {
    await upsertUserOnLogin(db, { email: "newbie@example.com" }, {});
    const key = personalSpaceKey("newbie@example.com");
    expect(await repos(db).spaces.find({ key })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Curated public-read + guest access matrix
// ---------------------------------------------------------------------------
describe("guest access matrix (public read, own personal, no others' personal, no curated edit)", () => {
  let db: Database;
  const guest = "guest@example.com";
  const other = "other@example.com";
  let curatedDoc: ResourceRef;
  let ownDoc: ResourceRef;
  let othersDoc: ResourceRef;

  beforeEach(async () => {
    db = new MemoryDatabase();
    const r = repos(db);
    await r.users.insert({ email: guest, role: "guest", createdAt: 1 });
    await r.users.insert({ email: other, role: "guest", createdAt: 1 });
    // Curated public space (as ensureSpace would create for content-root spaces).
    await r.spaces.insert({ key: "tutorials", name: "Tutorials", contentRoot: "tutorials", defaultRole: "read", prWorkflow: false });
    await ensurePersonalSpace(db, guest);
    await ensurePersonalSpace(db, other);
    invalidatePolicyCache(db);

    curatedDoc = { type: "doc", path: "tutorials/intro.md", spaceKey: "tutorials" };
    ownDoc = { type: "doc", path: `${personalSpaceKey(guest)}/note.md`, spaceKey: personalSpaceKey(guest) };
    othersDoc = { type: "doc", path: `${personalSpaceKey(other)}/secret.md`, spaceKey: personalSpaceKey(other) };
  });

  it("guest CAN read a curated public doc", async () => {
    expect((await authorize(db, guest, curatedDoc, "read")).allowed).toBe(true);
  });

  it("guest CANNOT edit a curated public doc", async () => {
    expect((await authorize(db, guest, curatedDoc, "edit")).allowed).toBe(false);
  });

  it("guest CAN create/edit/admin in their OWN personal space", async () => {
    expect((await authorize(db, guest, ownDoc, "read")).allowed).toBe(true);
    expect((await authorize(db, guest, ownDoc, "edit")).allowed).toBe(true);
    expect((await authorize(db, guest, ownDoc, "admin")).allowed).toBe(true);
  });

  it("guest CANNOT read ANOTHER user's personal doc (404 via closed default)", async () => {
    expect((await authorize(db, guest, othersDoc, "read")).allowed).toBe(false);
    expect((await authorize(db, guest, othersDoc, "edit")).allowed).toBe(false);
  });

  it("a guest does NOT satisfy a role:read grant (ranked below read)", () => {
    const g: Principal = { email: guest, role: "guest", groupKeys: [] };
    // role:read allow edit on the space would let read-or-above edit, but a guest is below read.
    const grants = [
      {
        subjectType: "role" as const,
        subjectId: "read",
        resourceType: "space" as const,
        resourcePath: "tutorials",
        capability: "edit" as const,
        effect: "allow" as const,
      },
    ];
    expect(canAccess(g, curatedDoc, "edit", grants, { defaultRole: "read" }).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. 8h TTL — pure math + reaping in the in-memory store
// ---------------------------------------------------------------------------
describe("guest doc TTL math", () => {
  it("guest docs get an 8h expiry; non-guest docs get none", () => {
    expect(isGuestRole("guest")).toBe(true);
    expect(isGuestRole("read")).toBe(false);
    expect(GUEST_DOC_TTL_MS).toBe(8 * 60 * 60 * 1000);

    const g = guestExpiryFields("guest", 1_000);
    expect(g.expiresAt).toBe(guestExpiryAt(1_000));
    expect(g.expiresAtDate).toEqual(new Date(guestExpiryAt(1_000)));

    expect(guestExpiryFields("read", 1_000)).toEqual({}); // non-guest never expires
    expect(guestExpiryFields("super", 1_000)).toEqual({});
  });

  it("isExpiredGuestDoc: only a stamped, past-due doc is expired", () => {
    const at = guestExpiryAt(0);
    expect(isExpiredGuestDoc({ expiresAt: at }, at + 1)).toBe(true); // past due
    expect(isExpiredGuestDoc({ expiresAt: at }, at - 1)).toBe(false); // not yet
    expect(isExpiredGuestDoc({ expiresAt: undefined }, Date.now())).toBe(false); // never expires
  });
});

describe("sweepExpiredDocs (in-memory reaper)", () => {
  let db: Database;
  beforeEach(() => {
    db = new MemoryDatabase();
  });

  it("removes an expired guest doc AND its dependent rows; leaves fresh + non-guest docs", async () => {
    const r = repos(db);
    const now = 10 * GUEST_DOC_TTL_MS;
    const expiredAt = now - 1; // already past
    const freshAt = now + GUEST_DOC_TTL_MS; // still valid

    // Expired guest doc + a full set of dependents.
    await r.docs.insert({ path: "~g/old.md", spaceKey: "~g", title: "Old", headings: [], body: "x", blobSha: "1", updatedAt: 1, expiresAt: expiredAt });
    await r.chunks.insert({ path: "~g/old.md", spaceKey: "~g", headingPath: "", charStart: 0, charEnd: 1, text: "x", vector: [1] });
    await r.favorites.insert({ email: "g@e.com", path: "~g/old.md", createdAt: 1 });
    await r.comments.insert({ id: "c1", path: "~g/old.md", spaceKey: "~g", authorEmail: "g@e.com", body: "b", mentions: [], resolved: false, createdAt: 1 });
    await r.grants.insert({ subjectType: "user", subjectId: "g@e.com", resourceType: "doc", resourcePath: "~g/old.md", capability: "admin", effect: "allow", createdAt: 1 });

    // Fresh guest doc (not yet expired) + a non-guest doc (no expiry).
    await r.docs.insert({ path: "~g/fresh.md", spaceKey: "~g", title: "Fresh", headings: [], body: "y", blobSha: "2", updatedAt: 1, expiresAt: freshAt });
    await r.docs.insert({ path: "tutorials/perm.md", spaceKey: "tutorials", title: "Perm", headings: [], body: "z", blobSha: "3", updatedAt: 1 });

    const res = await sweepExpiredDocs(db, now);
    expect(res.swept).toBe(1);
    expect(res.paths).toEqual(["~g/old.md"]);

    // Expired doc + all dependents gone.
    expect(await r.docs.findOne({ path: "~g/old.md" })).toBeNull();
    expect(await r.chunks.find({ path: "~g/old.md" })).toHaveLength(0);
    expect(await r.favorites.find({ path: "~g/old.md" })).toHaveLength(0);
    expect(await r.comments.find({ path: "~g/old.md" })).toHaveLength(0);
    expect(await r.grants.find({ resourceType: "doc", resourcePath: "~g/old.md" })).toHaveLength(0);

    // Fresh guest doc + non-guest doc survive.
    expect(await r.docs.findOne({ path: "~g/fresh.md" })).not.toBeNull();
    expect(await r.docs.findOne({ path: "tutorials/perm.md" })).not.toBeNull();
  });

  it("a non-guest doc is NEVER swept, even far in the future", async () => {
    const r = repos(db);
    await r.docs.insert({ path: "tutorials/perm.md", spaceKey: "tutorials", title: "Perm", headings: [], body: "z", blobSha: "1", updatedAt: 1 });
    const res = await sweepExpiredDocs(db, Number.MAX_SAFE_INTEGER);
    expect(res.swept).toBe(0);
    expect(await r.docs.findOne({ path: "tutorials/perm.md" })).not.toBeNull();
  });

  it("is idempotent — a second sweep with nothing expired is a no-op", async () => {
    const r = repos(db);
    await r.docs.insert({ path: "~g/x.md", spaceKey: "~g", title: "X", headings: [], body: "x", blobSha: "1", updatedAt: 1, expiresAt: 5 });
    expect((await sweepExpiredDocs(db, 10)).swept).toBe(1);
    expect((await sweepExpiredDocs(db, 10)).swept).toBe(0);
  });
});

// An expired guest doc is absent from a permission-filtered listing AND search
// once swept (mirrors what listReadableDocs / searchAction do: sweep, then read).
describe("expired guest doc vanishes from listing + search after a sweep", () => {
  let db: Database;
  const guest = "guest@example.com";

  beforeEach(async () => {
    db = new MemoryDatabase();
    const r = repos(db);
    await r.users.insert({ email: guest, role: "guest", createdAt: 1 });
    await r.spaces.insert({ key: "tutorials", name: "Tutorials", contentRoot: "tutorials", defaultRole: "read", prWorkflow: false });
    await ensurePersonalSpace(db, guest);
    invalidatePolicyCache(db);
    const pkey = personalSpaceKey(guest);
    // Guest doc created 9h ago → expired. Body carries a searchable term.
    await r.docs.insert({
      path: `${pkey}/ephemeral.md`, spaceKey: pkey, title: "Ephemeral", headings: [],
      body: "supersecretmarker content", blobSha: "1", updatedAt: 1, expiresAt: 5,
    });
    // A curated doc that also matches the search term, to prove search still works.
    await r.docs.insert({
      path: "tutorials/keep.md", spaceKey: "tutorials", title: "Keep", headings: [],
      body: "supersecretmarker tutorial", blobSha: "2", updatedAt: 1,
    });
  });

  async function readableListing(): Promise<string[]> {
    const principal = await loadPrincipal(db, guest);
    if (!principal) return [];
    const grants = await cachedGrants(db);
    const docs = await repos(db).docs.find();
    const out: string[] = [];
    for (const d of docs) {
      const policy = await cachedSpacePolicy(db, d.spaceKey);
      if (canAccess(principal, { type: "doc", path: d.path, spaceKey: d.spaceKey }, "read", grants, policy).allowed) {
        out.push(d.path);
      }
    }
    return out.sort();
  }

  it("before sweep the guest doc is listable; after sweep it is gone; search never returns it", async () => {
    const pkey = personalSpaceKey(guest);
    // Before sweep: the guest can see their own (still-in-store) doc.
    expect(await readableListing()).toContain(`${pkey}/ephemeral.md`);

    await sweepExpiredDocs(db, 10);

    const listing = await readableListing();
    expect(listing).not.toContain(`${pkey}/ephemeral.md`);
    expect(listing).toContain("tutorials/keep.md");

    // Direct-read equivalent: the doc row is gone → a getReadableDoc-style lookup 404s.
    expect(await repos(db).docs.findOne({ path: `${pkey}/ephemeral.md` })).toBeNull();

    // Search: the surviving curated doc matches; the reaped guest doc does not.
    const principal = await loadPrincipal(db, guest);
    const hits = await searchReadable(db, principal!, "supersecretmarker");
    const paths = hits.map((h) => h.path);
    expect(paths).toContain("tutorials/keep.md");
    expect(paths).not.toContain(`${pkey}/ephemeral.md`);
  });
});

// ---------------------------------------------------------------------------
// 5. Mongo TTL index is declared
// ---------------------------------------------------------------------------
describe("Mongo TTL index on guest docs", () => {
  it("INDEX_SPECS declares a TTL index on docs.expiresAtDate with expireAfterSeconds 0", () => {
    const ttl = INDEX_SPECS.find(([col, keys]) => col === "docs" && "expiresAtDate" in keys);
    expect(ttl).toBeDefined();
    const [, keys, opts] = ttl!;
    expect(keys).toEqual({ expiresAtDate: 1 });
    expect(opts.expireAfterSeconds).toBe(0);
    expect(opts.name).toBe("ttl_docs_expiresAt");
  });
});
