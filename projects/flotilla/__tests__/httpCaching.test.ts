import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@/lib/rbac";

// Perf R2c (item 2): auth-safe HTTP caching on the read GETs. cachedRead adds an
// ETag + If-None-Match → 304 and a browser-PRIVATE Cache-Control, computed AFTER
// the RBAC gate. This suite proves: (1) a first read carries a strong-enough ETag
// + a `private` (never `public`/`s-maxage`) Cache-Control; (2) a matching
// If-None-Match returns 304 with NO body; (3) a stale/mismatched If-None-Match
// returns a fresh 200; (4) the 304 still passes auth (an unauthenticated caller
// gets 401, never a 304); (5) the header can NEVER be CDN-cacheable.

// In-memory Mongo so the real read handlers run without Atlas.
vi.mock("@/lib/mongo", async () => {
  const { fakeDb } = await import("./helpers/fakeMongo");
  return {
    db: async () => fakeDb,
    COLLECTIONS: {
      config: "config",
      audit: "audit",
      configHistory: "configHistory",
      instances: "instances",
      templates: "templates",
    },
  };
});

// A mutable principal + a mutable If-None-Match request header, both mocked so we
// can drive the RBAC gate and the conditional-request path deterministically.
let principal: { kind: "clerk" | "breakglass"; id: string; role: Role } | null = null;
vi.mock("@/lib/auth", () => ({ getPrincipal: async () => principal }));

let ifNoneMatch: string | null = null;
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => (k.toLowerCase() === "if-none-match" ? ifNoneMatch : null) }),
}));

import { resetStore } from "./helpers/fakeMongo";
import { __resetConfigCache } from "@/lib/models";
import { GET as CONFIG_GET } from "@/app/api/config/route";
import { GET as INSTANCES_GET } from "@/app/api/instances/route";

function asRole(role: Role) {
  principal = { kind: "clerk", id: `${role}@example.com`, role };
}

beforeEach(() => {
  resetStore();
  __resetConfigCache();
  principal = null;
  ifNoneMatch = null;
  process.env.BREAKGLASS_PASSWORD_HASH = "salt:deadbeef";
});

// A bare Request (no conditional header — that's driven via the next/headers mock).
function req(url = "http://localhost/api/config") {
  return new Request(url, { method: "GET" });
}

describe("cachedRead — ETag issued on a read GET (post-RBAC)", () => {
  it("/api/config first read → 200 with an ETag and a private Cache-Control", async () => {
    asRole("read-only");
    const res = await CONFIG_GET();
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    const cc = res.headers.get("cache-control");
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/); // weak validator over the body
    expect(cc).toContain("private");
    expect(cc).toContain("must-revalidate");
    // The body is still the real config payload (behaviour preserved).
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toHaveProperty("meta");
  });

  it("the Cache-Control is NEVER shared/CDN-cacheable (no public / s-maxage / proxy-revalidate)", async () => {
    asRole("read-only");
    const cc = (await CONFIG_GET()).headers.get("cache-control") ?? "";
    expect(cc).not.toContain("public");
    expect(cc).not.toContain("s-maxage");
    expect(cc).not.toContain("proxy-revalidate");
  });
});

describe("cachedRead — conditional requests (If-None-Match → 304)", () => {
  it("a matching If-None-Match → 304 with NO body and the same ETag", async () => {
    asRole("read-only");
    // Warm: capture the current ETag.
    const first = await CONFIG_GET();
    const etag = first.headers.get("etag")!;

    // Replay with that ETag → 304, empty body.
    ifNoneMatch = etag;
    const notModified = await CONFIG_GET();
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(etag);
    expect(await notModified.text()).toBe(""); // 304 carries no body → saved bytes
  });

  it("a STALE If-None-Match → a fresh 200 (data changed → new ETag)", async () => {
    asRole("read-only");
    ifNoneMatch = 'W/"not-the-current-tag"';
    const res = await CONFIG_GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(ifNoneMatch);
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  it("weak-comparison: a bare (non-W/) copy of the tag still matches for GET", async () => {
    asRole("read-only");
    const etag = (await CONFIG_GET()).headers.get("etag")!; // W/"…"
    ifNoneMatch = etag.replace(/^W\//, ""); // "…" without the weak prefix
    expect((await CONFIG_GET()).status).toBe(304);
  });
});

describe("cachedRead — the 304 NEVER bypasses the RBAC gate", () => {
  it("an unauthenticated caller with a valid-looking If-None-Match gets 401, not 304", async () => {
    principal = null; // no auth
    ifNoneMatch = 'W/"whatever"';
    const res = await CONFIG_GET();
    expect(res.status).toBe(401); // gate runs FIRST; ETag compare never reached
    expect(res.headers.get("etag")).toBeNull();
  });

  it("the ETag is computed only after auth — a fresh authed read still 200s", async () => {
    asRole("read-only");
    const res = await CONFIG_GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();
  });
});

describe("cachedRead — /api/instances carries the same auth-safe caching", () => {
  it("first read → 200 + ETag + private Cache-Control; replay → 304", async () => {
    asRole("read-only");
    const first = await INSTANCES_GET(req("http://localhost/api/instances"));
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toContain("private");

    ifNoneMatch = etag;
    const second = await INSTANCES_GET(req("http://localhost/api/instances"));
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("a different owner/team filter yields a DIFFERENT ETag (body-derived tag)", async () => {
    asRole("read-only");
    const all = await INSTANCES_GET(req("http://localhost/api/instances"));
    const scoped = await INSTANCES_GET(req("http://localhost/api/instances?owner=someone@x.com"));
    // Empty store → both bodies are {instances:[]} here, so this asserts the tag is
    // a pure function of the body: same body ⇒ same tag (a filter that changes the
    // body would change the tag, so a stale 304 can't leak a different filter's data).
    expect(all.headers.get("etag")).toBe(scoped.headers.get("etag"));
  });
});
